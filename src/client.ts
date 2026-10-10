import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { WebError } from "@deepseek-ai/dsh-web";

import { isRecord } from "./guard.ts";

/**
 * TinyFish transport for the DSH web capability seam.
 *
 * Two channels reach the same upstream:
 *
 *   monid  — POST https://api.monid.ai/v1/run  {provider:"tinyfish", …}
 *            Auth: `Authorization: Bearer <monid platform key>`
 *            Response: `{ status, output, … }`
 *
 *   direct — the TinyFish API directly
 *            Search: GET  https://api.search.tinyfish.ai?query=…
 *            Fetch:  POST https://api.fetch.tinyfish.ai
 *            Auth: `X-API-Key: <tinyfish key>`
 *            Response: the payload itself
 *
 * Monid is a thin envelope: its `output` is byte-for-byte the direct response,
 * and it forwards the parameter names unchanged (`query`, `location`,
 * `include_domains`, `after_date`, `urls`, `format`, …). So both channels
 * normalise to one shape here and the providers above never branch.
 *
 * @module dsh-tinyfish/client
 */

/** Which upstream route a call takes. */
export type TinyfishChannel = "monid" | "direct";

/** Monid REST base. */
export const DEFAULT_MONID_BASE = "https://api.monid.ai";

/** TinyFish's own search and fetch bases. */
export const DEFAULT_SEARCH_BASE = "https://api.search.tinyfish.ai";
export const DEFAULT_FETCH_BASE = "https://api.fetch.tinyfish.ai";

/** Where the `monid` CLI keeps the platform key. */
const DEFAULT_CREDENTIALS = "~/.config/monid/credentials.yaml";

/** Where the official `tinyfish` CLI keeps its key (the same file it reads). */
const DEFAULT_TINYFISH_CONFIG = "~/.tinyfish/config.json";

/** Base backoff between attempts; grows linearly with the attempt. */
const DEFAULT_RETRY_DELAY_MS = 1200;

/** Poll cadence and ceiling for an async Monid run. */
const DEFAULT_POLL_MS = 1500;
const DEFAULT_MAX_POLLS = 40;

/**
 * Monid sits behind Cloudflare, which rejects the default fetch/undici
 * user-agent with a 403 `browser_signature_banned`. The direct API is fine
 * either way, so one browser UA is sent on every request.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Failure classes, named as the seam names them.
 *
 * These are the codes `dsh-tool-web` puts in structured error metadata, so a
 * caller can route on them without parsing a message. `WEB_PROVIDER_ERROR`
 * and `WEB_ABORTED` are the two a search or fetch provider can produce;
 * `WEB_PROVIDER_CREDENTIAL_MISSING` is split out so "you have no key" can be
 * distinguished from "your key was rejected" without reading the text.
 */
export { WebError };

export const WEB_PROVIDER_ERROR = "WEB_PROVIDER_ERROR";
export const WEB_PROVIDER_CREDENTIAL_MISSING =
  "WEB_PROVIDER_CREDENTIAL_MISSING";
export const WEB_ABORTED = "WEB_ABORTED";

/** One hit from TinyFish's `/search`. Only the fields this adapter reads. */
export interface TinyfishSearchHit {
  position?: number;
  site_name?: string;
  title?: string;
  snippet?: string;
  description?: string;
  url?: string;
  date?: string;
  publisher?: string;
}

/** The upstream search payload, byte-identical on both channels. */
export interface TinyfishSearchPayload {
  query?: string;
  results?: TinyfishSearchHit[];
  total_results?: number;
  page?: number;
}

/** One page from TinyFish's `/fetch`. */
export interface TinyfishFetchPage {
  url?: string;
  final_url?: string;
  title?: string;
  text?: string;
  published_date?: string;
  latency_ms?: number;
}

/** One per-URL failure from `/fetch`. A 404 arrives here, not in `results`. */
export interface TinyfishFetchFailure {
  url?: string;
  error?: string;
  status?: number;
}

/** The upstream fetch payload, byte-identical on both channels. */
export interface TinyfishFetchPayload {
  results?: TinyfishFetchPage[];
  errors?: TinyfishFetchFailure[];
}

/** The Monid run envelope. `output` is the direct response, verbatim. */
interface MonidEnvelope {
  runId?: string;
  status?: string;
  output?: Record<string, unknown> | null;
  providerResponse?: { httpStatus?: number; error?: unknown };
  reason?: { reason?: string; hints?: string[] } | string;
}

/* --------------------------------------------------------------- decoding */

/**
 * Turn a response body into a typed payload, field by field.
 *
 * `call` returns `unknown` because that is what a response body genuinely is
 * until something has parsed and checked it. The alternative — asserting the
 * answer at each of the four call sites — makes an upstream rename arrive as
 * `undefined` travelling through typed code until it throws somewhere
 * unrelated. Decoding once, where the body is read, makes the same rename
 * arrive as an empty result, which the retry loop already knows how to treat.
 *
 * Both channels share these: Monid's `output` is the direct response
 * verbatim, so there is one shape to read and nothing above this branches.
 */

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Every declared field of one row, with the check each must pass.
 *
 * Keyed by `keyof T` rather than written free-form, so adding a field to a
 * payload interface fails the build until this says how to read it. That is
 * the whole point of decoding rather than asserting: the compiler can police a
 * table, but it cannot police a cast.
 */
type RowShape = Record<string, (value: unknown) => boolean>;

const SEARCH_HIT_SHAPE = {
  position: isNumber,
  site_name: isString,
  title: isString,
  snippet: isString,
  description: isString,
  url: isString,
  date: isString,
  publisher: isString,
} satisfies Record<keyof TinyfishSearchHit, (value: unknown) => boolean>;

const FETCH_PAGE_SHAPE = {
  url: isString,
  final_url: isString,
  title: isString,
  text: isString,
  published_date: isString,
  latency_ms: isNumber,
} satisfies Record<keyof TinyfishFetchPage, (value: unknown) => boolean>;

/**
 * A failure row as upstream sends it, which is not quite the decoded payload.
 *
 * `status` is documented as a number and has been sent as a string. Dropping
 * the row over that would leave the caller with neither a page nor a failure
 * and turn a 404 into a thrown provider error, so the row is read as this and
 * the status is normalised on the way out.
 */
type TinyfishFailureWire = Omit<TinyfishFetchFailure, "status"> & {
  status?: number | string;
};

/** A status in either form it arrives: a number, or a string to be coerced. */
const isStatus = (value: unknown): boolean =>
  isNumber(value) || isString(value);

const FETCH_FAILURE_SHAPE = {
  url: isString,
  error: isString,
  status: isStatus,
} satisfies Record<keyof TinyfishFailureWire, (value: unknown) => boolean>;

/**
 * One failure row with its status as the number the payload promises.
 *
 * An unreadable status degrades to absent instead of discarding the row: the
 * provider already answers an absent status with 502, so the failure still
 * reaches the model. Blank is the case that matters — `Number("")` is `0`, and
 * a blank would otherwise be reported as a status code.
 */
function decodeFailure(row: TinyfishFailureWire): TinyfishFetchFailure {
  // A number is left exactly as it arrived, `0` included: deciding a status is
  // unusable is the provider's call, not this decoder's.
  if (!isString(row.status)) return { ...row, status: row.status };
  const status = Number(row.status);
  return {
    ...row,
    status: Number.isFinite(status) && status > 0 ? status : undefined,
  };
}

/** True for a row whose declared fields all arrived as their declared type. */
function rowFits(value: unknown, shape: RowShape): boolean {
  if (!isRecord(value)) return false;
  for (const [key, accept] of Object.entries(shape)) {
    const field = value[key];
    if (field !== undefined && !accept(field)) return false;
  }
  return true;
}

/** A search row. A wrong-typed field drops the row rather than being read. */
const isSearchHit = (value: unknown): value is TinyfishSearchHit =>
  rowFits(value, SEARCH_HIT_SHAPE);

/** A fetched page. */
const isFetchPage = (value: unknown): value is TinyfishFetchPage =>
  rowFits(value, FETCH_PAGE_SHAPE);

/** A per-URL failure, still carrying whatever form its status arrived in. */
const isFetchFailure = (value: unknown): value is TinyfishFailureWire =>
  rowFits(value, FETCH_FAILURE_SHAPE);

/**
 * One row with its null-valued fields removed.
 *
 * Upstream answers `null` for a field it could not extract, and the fetch docs
 * name them: title, description, language, author, published_date. `rowFits`
 * skips a field that is *absent*, so "could not extract" has to arrive as
 * absent — left as `null` it fails its own shape test and takes the whole row
 * with it. For a fetched page that turns a successful fetch into a thrown
 * `WEB_PROVIDER_ERROR`, which is invariant 2 inverted: a 404 is resource state
 * the model needs, and so is a page whose date could not be read.
 *
 * Stripping here, before the shape test, is also what keeps the declared types
 * true. Nothing downstream has to know a null was ever possible, so no
 * consumer grows a second null check that only this wire shape would need.
 *
 * Takes and returns `unknown` so it stays a transform rather than a cast: the
 * guard in `rows` is still the thing that narrows, and the compiler still
 * polices the shape table.
 */
function withoutNulls(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== null) clean[key] = field;
  }
  return clean;
}

/** An array of rows, kept `undefined` when upstream sent no array at all. */
function rows<T>(
  value: unknown,
  accept: (item: unknown) => item is T
): T[] | undefined {
  return Array.isArray(value)
    ? value.map(withoutNulls).filter(accept)
    : undefined;
}

/** Decode a `/search` payload. */
function decodeSearch(raw: unknown): TinyfishSearchPayload {
  if (!isRecord(raw)) return {};
  return {
    query: isString(raw.query) ? raw.query : undefined,
    results: rows(raw.results, isSearchHit),
    total_results: isNumber(raw.total_results) ? raw.total_results : undefined,
    page: isNumber(raw.page) ? raw.page : undefined,
  };
}

/** Decode a `/fetch` payload. */
function decodeFetch(raw: unknown): TinyfishFetchPayload {
  if (!isRecord(raw)) return {};
  return {
    results: rows(raw.results, isFetchPage),
    errors: rows(raw.errors, isFetchFailure)?.map(decodeFailure),
  };
}

/** Decode one Monid envelope. */
function decodeEnvelope(raw: unknown): MonidEnvelope {
  if (!isRecord(raw)) return {};
  const { runId, status, output, providerResponse, reason } = raw;

  // `output: null` is not the same answer as an absent `output`. The first is
  // Monid saying "the run completed and produced nothing" — which, alongside a
  // provider error, is how an upstream 5xx is reported — and the second is
  // "nothing has been produced yet". Collapsing them would discard the state
  // `assertUsableRun` needs to tell a retryable failure from a success.
  let decodedOutput: Record<string, unknown> | null | undefined;
  if (output === null) {
    decodedOutput = null;
  } else if (output === undefined) {
    decodedOutput = undefined;
  } else if (isRecord(output)) {
    decodedOutput = output;
  } else {
    decodedOutput = {};
  }

  // Monid reports a blocked run as either a bare string or an object; a
  // third, unrecognised shape decodes to "no reason" rather than being read
  // as one by a truthiness test that would also swallow `""`.
  let decodedReason: MonidEnvelope["reason"];
  if (typeof reason === "string") {
    decodedReason = reason;
  } else if (isRecord(reason)) {
    const detail = isString(reason.reason) ? reason.reason : undefined;
    const hints = rows(reason.hints, isString);
    decodedReason = { reason: detail, hints };
  } else {
    decodedReason = undefined;
  }

  let decodedProvider: MonidEnvelope["providerResponse"];
  if (isRecord(providerResponse)) {
    const httpStatus = isNumber(providerResponse.httpStatus)
      ? providerResponse.httpStatus
      : undefined;
    decodedProvider = { httpStatus, error: providerResponse.error };
  } else {
    decodedProvider = undefined;
  }

  return {
    runId: isString(runId) ? runId : undefined,
    status: isString(status) ? status : undefined,
    output: decodedOutput,
    reason: decodedReason,
    providerResponse: decodedProvider,
  };
}

/**
 * Resolves a stored credential by reference name.
 *
 * The shape matches `@deepseek-ai/dsh-credentials`: given a name, return the
 * stored value or undefined. Passed in rather than imported so the service
 * stays an optional peer — a host without it falls through to the CLI stores.
 */
export type CredentialResolver = (name: string) => Promise<string | undefined>;

/** Inputs for credential resolution, in precedence order. */
export interface ResolveApiKeyOptions {
  /** Explicit key; wins over everything. */
  apiKey?: string;
  /**
   * Name of a stored credential to ask the harness service for.
   *
   * Checked after the literal key and before the ambient environment, because
   * a stored credential is more specific than whatever happens to be exported.
   * This is the **direct** channel's ref; the monid channel reads
   * {@link ResolveApiKeyOptions.monidKeyEnv}.
   */
  apiKeyEnv?: string;
  /**
   * The monid channel's stored-credential name, kept separate from
   * {@link ResolveApiKeyOptions.apiKeyEnv} so a user can save both keys.
   *
   * One shared ref would hand a TinyFish key to Monid as its bearer token,
   * which fails upstream as a 401 — indistinguishable from "your Monid key is
   * wrong". Left unset, the monid channel skips the store and falls through to
   * its own rungs (`MONID_API_KEY`, `MONID_MCP_TOKEN`, the CLI store).
   */
  monidKeyEnv?: string;
  /** The harness credentials service, when the host provides one. */
  resolveCredential?: CredentialResolver;
  /** Override the Monid CLI credential path. */
  credentialsPath?: string;
  /** Override the TinyFish CLI config path. */
  tinyfishConfigPath?: string;
  /** Environment to read. Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Caller cancellation, honoured by the async credential lookup. */
  signal?: AbortSignal;
}

/**
 * A `WebError` the retry loop may try again.
 *
 * A subclass rather than a flag on the error, because `WebError` is the
 * seam's own type and adding a field to it would put a property on something
 * the harness renders. `instanceof WebError` still holds, so cancellation and
 * error routing downstream are unaffected.
 *
 * Transient covers rate limits and upstream 5xx — the shapes that are worth
 * another attempt. It is deliberately not a code: the retry loop asks "would
 * this probably work next time", and one code cannot answer that for both a
 * 429 and a 503.
 */
class TransientWebError extends WebError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options);
    this.name = "TransientWebError";
  }
}

/** True for an error the retry loop is allowed to try again. */
const isTransient = (error: unknown): error is TransientWebError =>
  error instanceof TransientWebError;

/**
 * Build the provider's stable cancellation error.
 *
 * The caller's `reason` is kept as the `cause` when the signal has already
 * fired, so the harness's own abort reason survives instead of being replaced
 * by a generic string.
 */
const aborted = (signal?: AbortSignal, fallback?: unknown): WebError =>
  new WebError("TinyFish request aborted", WEB_ABORTED, {
    cause: signal !== undefined && signal.aborted ? signal.reason : fallback,
  });

/**
 * True for a fetch/`AbortSignal` abort.
 *
 * `signal.aborted` alone is not enough: a request can be cancelled by a
 * timeout racing an in-flight `fetch`, in which case the signal never fired
 * and the rejection arrives as a `DOMException` named `AbortError`. Treating
 * that as a transport failure would surface a user-initiated stop as an
 * upstream error.
 */
const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

/** Throw the stable cancellation error when the caller has already aborted. */
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal !== undefined && signal.aborted) throw aborted(signal);
};

/**
 * Race an operation against the caller's cancellation.
 *
 * Two properties are load-bearing and both are stated here so they are not
 * "simplified" away later:
 *
 * 1. **Both settlement handlers are attached before anything is awaited.**
 *    When the abort wins and the abandoned operation rejects afterwards, that
 *    rejection already has a handler, so it is marked handled instead of
 *    surfacing as an `unhandledRejection`. This is the usual failure mode of
 *    abandoning a `Promise.race`'s loser, and a hand-rolled wrapper that stops
 *    observing on abort has it.
 * 2. **The listener is removed on every path that settles.** An operation that
 *    wins leaves its subscription behind otherwise, so a signal reused across a
 *    batch of searches accumulates one dead listener per attempt.
 */
export function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal === undefined) return operation;
  const active = signal;
  if (active.aborted) return Promise.reject(aborted(active));

  return new Promise<T>((resolve, reject) => {
    const drop = (): void => {
      active.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      drop();
      reject(aborted(active));
    };
    active.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      try {
        const value = await operation;
        drop();
        resolve(value);
      } catch (error: unknown) {
        drop();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

/** Sleep that rejects promptly when the caller's signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  const active = signal;
  if (active.aborted) return Promise.reject(aborted(active));

  return new Promise((resolve, reject) => {
    const drop = (): void => {
      active.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      drop();
      reject(aborted(active));
    };
    // The timer clears the listener as well: a sleep that finishes must not
    // leave a subscription on a signal the caller may keep for a whole batch.
    const timer = setTimeout(() => {
      drop();
      resolve();
    }, ms);
    active.addEventListener("abort", onAbort, { once: true });
  });
}

/** Expand a leading `~`. */
const home = (path: string): string =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/**
 * Read the active key out of the monid CLI's credentials file.
 *
 * The file is YAML, but its shape is fixed and tiny — `active_key:` plus one
 * indented `key:` per entry — so a targeted read beats pulling a YAML parser
 * into a plugin with no other use for one.
 */
function readMonidCredentials(path: string): string {
  let text: string;
  try {
    text = readFileSync(home(path), "utf8");
  } catch {
    return "";
  }

  // Entries are two-space-indented headers (`  main:`) with an indented `key:`
  // beneath. Split on the headers so a lookup can be by name rather than by
  // position — `active_key:` names the entry in use, and taking whichever key
  // happened to be first would pick a rotated-out one.
  //
  // Two capture groups, so the split array is
  // [before, indent, name, body, indent, name, body, …] and entry names land
  // on every third index starting at 2 — which is why the loop steps in
  // threes from 1 and reads them as `i + 1`.
  const active = /^active_key:\s*(\S+)\s*$/m.exec(text)?.[1];
  const parts = text.split(/^(\s{2,})(\S+):\s*$/m);
  const entries = new Map<string, string>();
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const name = parts[i + 1];
    const body = parts[i + 2];
    if (name !== undefined && body !== undefined) entries.set(name, body);
  }

  // `*`, not `+`, before `key:`: an entry body is indented, but the flat file
  // this falls back to need not be, and requiring whitespace at column 0 read
  // a perfectly good `key:` as no key at all.
  const keyIn = (body?: string): string | undefined =>
    /^\s*key:\s*(\S+)\s*$/m.exec(body ?? "")?.[1];

  // `undefined` is the distinct answer from `""`: no `active_key` line means
  // "pick the only entry", while one that names nothing we have is "retry on
  // the first entry that still carries a key". Collapsing them to a string
  // would make `if (active)` a truthiness test on a value that can be empty.
  if (active !== undefined) {
    const chosen = keyIn(entries.get(active));
    if (chosen !== undefined) return chosen;
  }
  for (const body of entries.values()) {
    const key = keyIn(body);
    if (key !== undefined) return key;
  }
  // A flat file with no entry headers: read the only `key:` there is.
  return keyIn(text) ?? "";
}

/**
 * Read the key the official `tinyfish` CLI already stored.
 *
 * Reusing that file is deliberate: the user has already authenticated the CLI
 * (`tinyfish auth login`), and reading the same store means the plugin has no
 * separate credential to provision, rotate, or leak.
 */
function readTinyfishConfig(path: string): string {
  try {
    const config: unknown = JSON.parse(readFileSync(home(path), "utf8"));
    if (!isRecord(config)) return "";
    return isString(config.api_key) ? config.api_key.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Read a field out of the environment, trimming only what it holds.
 *
 * A present-but-empty entry is the same answer as an absent one: the source
 * declared the name, but declared no credential. Keeping that distinction out
 * of `if (fromEnv)` is what makes the rung readable as a lookup rather than as
 * a truthiness test on a possibly-empty string.
 */
const envKey = (
  env: Record<string, string | undefined>,
  name: string
): string | undefined => {
  const value = env[name]?.trim();
  return value !== undefined && value !== "" ? value : undefined;
};

/**
 * Resolve the credential for one channel.
 *
 * Explicit config wins, then the environment, then the channel's own
 * credential store. Stores are re-read per call rather than cached at module
 * load: they are a few hundred bytes, and caching would pin a rotated key
 * inside a long-lived host process.
 *
 * The environment rung reads the **configured reference** first and the
 * channel's conventional names second. That ordering is the documented
 * contract of `apiKeyEnv` — "credential reference, or env var" — and it is
 * also the one `hasCredential` implements, so `available()` and the request
 * that follows it cannot disagree about whether a key exists.
 */
export function resolveApiKey(
  channel: TinyfishChannel,
  options: ResolveApiKeyOptions = {}
): string {
  const explicit = options.apiKey?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  const env = options.env ?? process.env;
  const ref = channel === "monid" ? options.monidKeyEnv : options.apiKeyEnv;
  if (ref !== undefined) {
    const named = envKey(env, ref);
    if (named !== undefined) return named;
  }

  // The conventional names stay a rung below the named one rather than being
  // replaced by it. A default `monidKeyEnv` still falls through to
  // `MONID_MCP_TOKEN` when only that is exported, which is the whole point of
  // keeping both rungs for this channel.
  const conventional =
    channel === "monid"
      ? (envKey(env, "MONID_API_KEY") ?? envKey(env, "MONID_MCP_TOKEN"))
      : envKey(env, "TINYFISH_API_KEY");
  if (conventional !== undefined) return conventional;

  return channel === "monid"
    ? readMonidCredentials(options.credentialsPath ?? DEFAULT_CREDENTIALS)
    : readTinyfishConfig(options.tinyfishConfigPath ?? DEFAULT_TINYFISH_CONFIG);
}

/**
 * The same resolution, with the harness credentials service consulted first.
 *
 * The split is deliberate rather than an oversight: `available()` must be a
 * cheap synchronous check that never awaits, and it uses the synchronous form.
 * Only the credential lookup is async, and only when a service is present.
 */
export async function resolveApiKeyAsync(
  channel: TinyfishChannel,
  options: ResolveApiKeyOptions = {}
): Promise<string> {
  const explicit = options.apiKey?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  const { apiKeyEnv, monidKeyEnv, resolveCredential } = options;
  // The ref belongs to the channel that is about to use it. Selecting it here,
  // where the channel is already an argument, is what keeps a user who saved
  // both keys from having the wrong one sent.
  const ref = channel === "monid" ? monidKeyEnv : apiKeyEnv;
  // Check before *invoking* the resolver, not just before awaiting it. An
  // already-aborted caller should not cause a credential lookup at all, and an
  // unguarded rejection from the abandoned call would surface as an
  // unhandledRejection rather than as a cancellation.
  throwIfAborted(options.signal);
  if (ref !== undefined && resolveCredential !== undefined) {
    try {
      const stored = await abortable(
        Promise.resolve(resolveCredential(ref)),
        options.signal
      );
      const trimmed = stored?.trim();
      if (trimmed !== undefined && trimmed !== "") return trimmed;
    } catch (error) {
      // A failing credential service must not fail the search: the CLI stores
      // are a working fallback, and treating that as fatal would take out a
      // provider that was fine a moment ago. A cancelled signal still wins.
      if (options.signal !== undefined && options.signal.aborted) {
        throw aborted(options.signal, error);
      }
    }
  }

  return resolveApiKey(channel, options);
}

/**
 * Assert that a channel is configured, naming the fix in the message.
 *
 * Deliberately a statement rather than an accessor: the caller resolves the
 * key itself and must use that same value, so this only ever throws.
 */
function requireKey(channel: TinyfishChannel, key: string): void {
  if (key) return;

  // A separate code, not WEB_PROVIDER_ERROR. "You have no key" and "your key was
  // rejected" are the two things a user can act on completely differently, and
  // the seam surfaces this code in structured error metadata precisely so the
  // two do not have to be told apart by reading a message.
  if (channel === "monid") {
    throw new WebError(
      "The tinyfish provider has no Monid API key. Save one in Plugins → Tinyfish, " +
        "or run `monid keys add` to store one in the local credential file, or export MONID_API_KEY, or " +
        "set the dsh-tinyfish `monidKeyEnv` row in the profile's cordis.patch.yml.",
      WEB_PROVIDER_CREDENTIAL_MISSING
    );
  }
  throw new WebError(
    "The tinyfish provider has no TinyFish API key. Save one in Plugins → Tinyfish, " +
      "or run `tinyfish auth login` to save one, or export TINYFISH_API_KEY, or set the " +
      "dsh-tinyfish `apiKeyEnv` row in the profile's cordis.patch.yml — or " +
      "switch the provider's channel to 'monid' to use a Monid key instead.",
    WEB_PROVIDER_CREDENTIAL_MISSING
  );
}

/** `fetch` with auth applied and failures mapped to `WebError`. */
async function call(
  url: string,
  options: {
    channel: TinyfishChannel;
    key: string;
    init: RequestInit;
    signal?: AbortSignal;
  }
): Promise<unknown> {
  const { channel, key, init, signal } = options;
  // Auth headers are owned here, deliberately: `call` is the only thing that
  // knows which header a channel authenticates with, and letting a caller pass
  // its own would make an override of `Authorization` possible without a
  // reviewer noticing.
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...(channel === "monid"
      ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
      : { "X-API-Key": key }),
  };

  let response: Response;
  try {
    // `redirect: "error"` matches the harness's own providers: a provider
    // configured for one endpoint should not silently follow it somewhere
    // else, and a redirect here is far more likely a misconfiguration than a
    // normal control flow.
    response = await fetch(url, {
      ...init,
      headers,
      redirect: "error",
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    if (signal !== undefined && signal.aborted) throw aborted(signal);
    if (isAbortError(error)) throw aborted(signal, error);
    throw new WebError(
      `TinyFish request to ${url} failed: ${String(error)}`,
      WEB_PROVIDER_ERROR,
      {
        cause: error,
      }
    );
  }

  if (response.status === 401 || response.status === 403) {
    // Which key was rejected, identified without revealing it. When several
    // sources can supply the credential — a literal, the harness store, the
    // environment, the CLI file — "your key is wrong" is unactionable unless
    // the user can tell which one was sent. A hash prefix does that safely.
    const fingerprint = createHash("sha256")
      .update(key, "utf8")
      .digest("hex")
      .slice(0, 12);
    throw new WebError(
      `TinyFish rejected the ${channel} API key (HTTP ${response.status}, key sha256:${fingerprint}). ` +
        "Refresh it, or switch the provider's channel.",
      WEB_PROVIDER_ERROR
    );
  }
  if (response.status === 429) {
    throw new TransientWebError(
      "TinyFish rate limit reached (HTTP 429).",
      WEB_PROVIDER_ERROR
    );
  }
  // An upstream 5xx is the other transient shape, and it has to be labelled
  // here rather than left for the retry loop to recognise: `TransientWebError`
  // is the *only* thing `isTransient` accepts, so a plain 5xx used to reach
  // `withRetry` and be rethrown on the first attempt. That contradicted this
  // class's own contract — "transient covers rate limits and upstream 5xx" —
  // and cost the retry its whole purpose on the one status that means "try
  // again". Both surfaces are $0, so a blind retry spends nothing.
  if (response.status >= 500) {
    throw new TransientWebError(
      `TinyFish returned HTTP ${response.status} for ${url}`,
      WEB_PROVIDER_ERROR
    );
  }
  if (!response.ok) {
    throw new WebError(
      `TinyFish returned HTTP ${response.status} for ${url}`,
      WEB_PROVIDER_ERROR
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new WebError(
      `TinyFish returned a non-JSON body for ${url}`,
      WEB_PROVIDER_ERROR,
      {
        cause: error,
      }
    );
  }
}

/* ------------------------------------------------------------------ search */

/** Query string for the direct channel, skipping empty filters. */
function searchQueryString(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/**
 * Start one Monid run and poll it until it settles.
 *
 * Shared by search and fetch because they are the same operation twice: the
 * endpoint differs and nothing else does. Fetch used to carry its own copy
 * *without* the poll loop, which is how an async `RUNNING` fetch envelope got
 * read as if it were a completed one.
 *
 * The loop is bounded rather than `while (status === "RUNNING")`: Monid has no
 * "cancelled" state for a run the client has stopped asking about, so an
 * unreplied run would otherwise poll until the caller's signal fires — or
 * forever, for a caller that has none.
 */
async function runMonid(options: {
  key: string;
  base: string;
  /** Which operation to run: `/search` or `/fetch`. */
  endpoint: string;
  /** That operation's own parameters, nested as Monid's `input`. */
  input: Record<string, unknown>;
  signal?: AbortSignal;
  pollMs: number;
  maxPolls: number;
}): Promise<MonidEnvelope> {
  const { key, base, endpoint, input, signal, pollMs, maxPolls } = options;

  const post = async (body: Record<string, unknown>): Promise<MonidEnvelope> =>
    decodeEnvelope(
      await call(`${base}/v1/run`, {
        channel: "monid",
        key,
        signal,
        init: { method: "POST", body: JSON.stringify(body) },
      })
    );

  let envelope = await post({ provider: "tinyfish", endpoint, input });

  let polls = 0;
  while (envelope.status === "RUNNING" && polls < maxPolls) {
    throwIfAborted(signal);
    polls += 1;
    await sleep(pollMs, signal);
    envelope = await post({ runId: envelope.runId });
  }
  if (envelope.status === "RUNNING") {
    throw new WebError(
      `TinyFish run ${envelope.runId ?? "?"} did not settle within ${polls} polls`,
      WEB_PROVIDER_ERROR
    );
  }
  assertUsableRun(envelope);
  return envelope;
}

/** One search through the monid channel, polling if the run is async. */
async function searchMonid(options: {
  key: string;
  base: string;
  params: Record<string, string | number>;
  signal?: AbortSignal;
  pollMs: number;
  maxPolls: number;
}): Promise<TinyfishSearchPayload> {
  const { key, base, params, signal, pollMs, maxPolls } = options;
  const envelope = await runMonid({
    key,
    base,
    endpoint: "/search",
    input: { queryParams: params },
    signal,
    pollMs,
    maxPolls,
  });
  return decodeSearch(envelope.output);
}

/**
 * The human-readable form of a `BLOCKED` reason, for the error text.
 *
 * Monid sends either a bare string or an object carrying `reason` plus
 * `hints`; an empty result means neither arrived. Each arm is matched
 * explicitly rather than by truthiness — a union is precisely where
 * `if (reason && …)` reads as one test and means three of them.
 */
function describeBlock(reason: MonidEnvelope["reason"]): string {
  if (typeof reason === "string") return reason;
  if (reason === undefined) return "";
  return [reason.reason, ...(reason.hints ?? [])]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" ");
}

/** Raise for a BLOCKED / FAILED run, which retrying will not fix. */
function assertUsableRun(envelope: MonidEnvelope): void {
  if (envelope.status === "BLOCKED") {
    const detail = describeBlock(envelope.reason);
    throw new WebError(
      `The Monid workspace blocked this run${detail === "" ? "." : `: ${detail}`} ` +
        "Top up at https://app.monid.ai/wallet.",
      WEB_PROVIDER_ERROR
    );
  }
  if (envelope.status === "FAILED" || envelope.status === "TIMED_OUT") {
    throw new WebError(
      `TinyFish run ${envelope.runId ?? "?"} ended ${envelope.status}`,
      WEB_PROVIDER_ERROR
    );
  }
  // `output: null` alongside a provider error is Monid reporting an upstream
  // failure as a COMPLETED run. Which of those are worth retrying is a
  // question about the status, not about whether an error object arrived:
  // classifying on presence made every 4xx retryable, so a permanent and
  // user-fixable 400/422 was retried `attempts` times and finally reported as
  // "TinyFish is temporarily unavailable" — advice to wait for something only
  // the request can fix. The direct channel treats that same status as
  // terminal, and the two channels are advertised as interchangeable. The
  // mirror of the same mistake: a bare `{ httpStatus: 429 }` with no error
  // object was not retried at all.
  const provider = envelope.providerResponse;
  const noOutput = envelope.output === undefined || envelope.output === null;
  if (noOutput && provider !== undefined) {
    const status = provider.httpStatus;
    const hasError = provider.error !== undefined && provider.error !== null;
    // An absent status counts as retryable: Monid omits it on the envelopes it
    // builds itself, and those were treated as faults before.
    const retryable = status === undefined || status === 429 || status >= 500;
    if (retryable && (hasError || status !== undefined)) {
      const message = extractProviderMessage(provider.error);
      throw new TransientWebError(
        `TinyFish is temporarily unavailable${message === "" ? "." : `: ${message}`}`,
        WEB_PROVIDER_ERROR
      );
    }
    if (!retryable) {
      const message = extractProviderMessage(provider.error);
      throw new WebError(
        `TinyFish rejected this request (HTTP ${status})${message === "" ? "." : `: ${message}`}`,
        WEB_PROVIDER_ERROR
      );
    }
  }
}

/** Dig a human message out of Monid's nested provider error, if there is one. */
function extractProviderMessage(error: unknown): string {
  // `{ error: { message } }` is the documented shape. Anything else — a bare
  // string, a number, a shape that has since moved — yields no message rather
  // than an exception thrown from inside the error path, where throwing would
  // replace the failure being reported.
  if (!isRecord(error)) return "";
  const outer = error.error;
  return isRecord(outer) && isString(outer.message) ? outer.message : "";
}

/* ------------------------------------------------------------------- fetch */

/** One fetch through the monid channel, polling if the run is async. */
async function fetchMonid(options: {
  key: string;
  base: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  pollMs?: number;
  maxPolls?: number;
}): Promise<TinyfishFetchPayload> {
  const {
    key,
    base,
    body,
    signal,
    pollMs = DEFAULT_POLL_MS,
    maxPolls = DEFAULT_MAX_POLLS,
  } = options;
  const envelope = await runMonid({
    key,
    base,
    endpoint: "/fetch",
    input: { body },
    signal,
    pollMs,
    maxPolls,
  });
  return decodeFetch(envelope.output);
}

/* ------------------------------------------------------------------- api */

/**
 * What the retry loop needs to decide whether another attempt is worthwhile.
 *
 * Parameterised by the operation's result so `retryWhen` receives a typed
 * value: previously it took `unknown` and every caller had to cast the payload
 * back to its own type, which is a round trip through `any` buying nothing.
 */
interface RetryPolicy<T> {
  attempts: number;
  signal?: AbortSignal;
  delayMs?: number;
  retryWhen?: (value: T) => boolean;
  onRetry?: (attempt: number, total: number, error?: WebError) => void;
}

/**
 * Run one operation with a bounded retry.
 *
 * Two transient shapes are worth retrying, and both are observed in practice:
 * a `SERVICE_BUSY`/5xx envelope from the monid channel, and a `/search` that
 * answers a perfectly valid query with zero results (roughly one run in three).
 * The endpoints are $0, so an empty result is worth a couple more attempts
 * before it is believed. A BLOCKED run never retries.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy<T>
): Promise<T> {
  const {
    attempts,
    signal,
    delayMs = DEFAULT_RETRY_DELAY_MS,
    retryWhen,
    onRetry,
  } = policy;
  let lastError: TransientWebError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await operation();
      if (
        retryWhen === undefined ||
        !retryWhen(value) ||
        attempt === attempts
      ) {
        return value;
      }
      // One callback per retry actually taken: this one for a value not worth
      // believing, the catch below for the attempt that failed. Nothing fires
      // for the attempt that ends up returning — an earlier version also
      // reported on every attempt past the first, before it knew whether it
      // was about to return, so two retries arrived as four callbacks and the
      // final one claimed the successful attempt was being retried.
      onRetry?.(attempt, attempts);
    } catch (error) {
      // A cancelled attempt is not a failed attempt: retrying it would spend
      // another call on work the caller has already given up on.
      //
      // The two checks cover the two ways a cancellation arrives: the caller's
      // signal fired, or the transport reported an `AbortError` the signal
      // never saw (a timeout racing an in-flight fetch). Only the first is
      // reachable today, and both are asserted by the suite — but only on the
      // final attempt, because with more attempts the sleep between them watches
      // the same signal and ends the sequence before this decides anything.
      if (signal !== undefined && signal.aborted) {
        throw aborted(signal, error);
      }
      // Belt and braces. `request` converts an `AbortError` into the same
      // cancellation error before anything escapes here, so no fetch-originated
      // abort can reach this line — which is also why no test can cover it.
      // Kept because the loop should not depend on a caller three frames away
      // getting this right; if that line is ever deleted, this becomes live and
      // untested, which is the case worth noticing.
      if (isAbortError(error)) throw aborted(signal, error);
      if (!isTransient(error)) throw error;
      if (attempt === attempts) throw error;
      lastError = error;
      onRetry?.(attempt, attempts, error);
    }
    await sleep(delayMs * attempt, signal);
  }
  throw lastError ?? new WebError("TinyFish gave up", WEB_PROVIDER_ERROR);
}

/** Everything a search call can be pointed at. */
export interface TinyfishSearchOptions extends ResolveApiKeyOptions {
  channel: TinyfishChannel;
  query: string;
  /** Upstream-named filters, already snake_case. */
  filters?: Record<string, string | number>;
  /**
   * Goal statement forwarded as the `purpose` query param; TinyFish treats it
   * as a ranking signal on search just as it does on fetch.
   */
  purpose?: string;
  monidBase?: string;
  searchBase?: string;
  signal?: AbortSignal;
  attempts?: number;
  /** Base backoff between attempts, in ms; grows linearly with the attempt. Default 1200. */
  delayMs?: number;
  onRetry?: (attempt: number, total: number) => void;
  /** Poll cadence for an async Monid run. */
  pollMs?: number;
  maxPolls?: number;
}

/**
 * Fetch body fields that ride every request, in the upstream's vocabulary.
 *
 * The names *are* the upstream body names — `ttl`, `per_url_timeout_ms`,
 * `exclude_selectors` — exactly the way `TinyfishSearchOptions.filters`
 * carries upstream query names: the camelCase→snake_case translation already
 * happened in `resolveOptions`, so nothing downstream re-spells a field. An
 * absent member is omitted from the body rather than sent as `undefined`,
 * because "unset" and "set to zero" are different upstream answers (`ttl: 0`
 * forces a live fetch; an omitted `ttl` accepts any cache age).
 */
export interface TinyfishFetchDefaults {
  /** Cache freshness tolerance in seconds; `0` forces a live fetch. */
  ttl?: number;
  /** Per-URL wall-clock budget in ms (1–110000). */
  per_url_timeout_ms?: number;
  /** CSS selectors removed before extraction (1–20 entries, each ≤1000 chars). */
  exclude_selectors?: readonly string[];
}

/** Everything a fetch call can be pointed at. */
export interface TinyfishFetchOptions extends ResolveApiKeyOptions {
  channel: TinyfishChannel;
  urls: string[];
  /** Goal statement forwarded upstream; TinyFish ranks on it. */
  purpose?: string;
  /** Config-set body defaults, merged into the request body as given. */
  fetchOptions?: TinyfishFetchDefaults;
  monidBase?: string;
  fetchBase?: string;
  signal?: AbortSignal;
  attempts?: number;
  /** Base backoff between attempts, in ms; grows linearly with the attempt. Default 1200. */
  delayMs?: number;
  onRetry?: (attempt: number, total: number) => void;
  /** Poll cadence for an async Monid run. */
  pollMs?: number;
  maxPolls?: number;
}

/**
 * Search TinyFish. Returns the upstream payload for both channels:
 * `{ query, results[], total_results, page }`.
 */
export async function tinyfishSearch(
  options: TinyfishSearchOptions
): Promise<TinyfishSearchPayload> {
  const {
    channel,
    query,
    apiKey,
    apiKeyEnv,
    monidKeyEnv,
    resolveCredential,
    credentialsPath,
    tinyfishConfigPath,
    filters = {},
    purpose,
    monidBase = DEFAULT_MONID_BASE,
    searchBase = DEFAULT_SEARCH_BASE,
    signal,
    attempts = 3,
    delayMs,
    onRetry,
    pollMs = DEFAULT_POLL_MS,
    maxPolls = DEFAULT_MAX_POLLS,
  } = options;

  // The async resolver, so a credential the host stores — the one a user saves
  // from the settings UI — is actually consulted. The synchronous form was
  // used here, which quietly meant the harness credentials service was never
  // reached: the ref, the service and the settings screen's secret field all
  // existed, and no request ever used them. It falls back to the same
  // environment and CLI rungs when no resolver is supplied.
  const key = await resolveApiKeyAsync(channel, {
    apiKey,
    apiKeyEnv,
    monidKeyEnv,
    resolveCredential,
    credentialsPath,
    env: options.env,
    tinyfishConfigPath,
    signal,
  });
  requireKey(channel, key);
  // One params map feeds both channels: the direct channel stringifies it
  // into the query string, the monid channel wraps it as `queryParams`, and
  // neither branch decides membership. `purpose` joins the map the same way
  // filters do — empty is dropped, so an unset goal statement sends nothing.
  const params: Record<string, string | number> = { query, ...filters };
  if (purpose !== undefined && purpose !== "") params.purpose = purpose;

  return withRetry<TinyfishSearchPayload>(
    async (): Promise<TinyfishSearchPayload> =>
      channel === "monid"
        ? searchMonid({
            key,
            base: monidBase,
            params,
            signal,
            pollMs,
            maxPolls,
          })
        : decodeSearch(
            await call(`${searchBase}?${searchQueryString(params)}`, {
              channel: "direct",
              key,
              signal,
              init: { method: "GET" },
            })
          ),
    {
      attempts,
      signal,
      delayMs,
      // A zero-result search is usually the upstream flake, not the answer.
      retryWhen: (payload) =>
        payload.results === undefined || payload.results.length === 0,
      onRetry: (attempt, total) => onRetry?.(attempt, total),
    }
  );
}

/**
 * Fetch up to 10 URLs as clean Markdown. Returns the upstream payload for both
 * channels: `{ results[], errors[] }`.
 */
export async function tinyfishFetch(
  options: TinyfishFetchOptions
): Promise<TinyfishFetchPayload> {
  const {
    channel,
    urls,
    apiKey,
    apiKeyEnv,
    monidKeyEnv,
    resolveCredential,
    credentialsPath,
    tinyfishConfigPath,
    purpose,
    // Defaults to an empty object so the spread below is unconditional: the
    // config layer always sends a group (possibly empty), and a caller that
    // sends none gets the historical body exactly.
    fetchOptions = {},
    monidBase = DEFAULT_MONID_BASE,
    fetchBase = DEFAULT_FETCH_BASE,
    signal,
    attempts = 3,
    delayMs,
    onRetry,
    pollMs = DEFAULT_POLL_MS,
    maxPolls = DEFAULT_MAX_POLLS,
  } = options;

  const key = await resolveApiKeyAsync(channel, {
    apiKey,
    apiKeyEnv,
    monidKeyEnv,
    resolveCredential,
    credentialsPath,
    env: options.env,
    tinyfishConfigPath,
    signal,
  });
  requireKey(channel, key);
  const body: Record<string, unknown> = {
    urls,
    format: "markdown",
    ...fetchOptions,
  };
  if (purpose !== undefined && purpose !== "") body.purpose = purpose;

  return withRetry<TinyfishFetchPayload>(
    async (): Promise<TinyfishFetchPayload> =>
      channel === "monid"
        ? fetchMonid({ key, base: monidBase, body, signal, pollMs, maxPolls })
        : decodeFetch(
            await call(fetchBase, {
              channel: "direct",
              key,
              signal,
              init: { method: "POST", body: JSON.stringify(body) },
            })
          ),
    {
      attempts,
      signal,
      delayMs,
      onRetry: (attempt, total) => onRetry?.(attempt, total),
    }
  );
}
