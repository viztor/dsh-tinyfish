import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { WebError } from "@deepseek-ai/dsh-web";

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

/** Base backoff between attempts; doubles per attempt. */
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
export const WEB_PROVIDER_CREDENTIAL_MISSING = "WEB_PROVIDER_CREDENTIAL_MISSING";
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
   */
  apiKeyEnv?: string;
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
    cause: signal?.aborted ? signal.reason : fallback,
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
  if (signal?.aborted) throw aborted(signal);
};

/**
 * Race an operation against the caller's cancellation.
 *
 * The settlement handlers stay attached after an abort, so a late rejection
 * from the abandoned operation cannot become an unhandled rejection — the
 * usual failure mode of naively wrapping a promise in a race.
 */
export async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);

  // `Promise.race` is sufficient here, and the reason is worth stating: it
  // attaches its own handler to `operation`, so when the abort wins and the
  // operation later rejects, that rejection is already marked handled. A
  // hand-rolled `new Promise` that stopped observing on abort would leak it as
  // an unhandledRejection — the exact bug the naive version of this had.
  const cancelled = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(aborted(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([operation, cancelled]);
}

/** Sleep that rejects promptly when the caller's signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted(signal));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(aborted(signal));
      },
      { once: true },
    );
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
  // [before, indent, name, body, indent, name, body, …] and entry names land on
  // the odd indices.
  const active = /^active_key:\s*(\S+)\s*$/m.exec(text)?.[1];
  const parts = text.split(/^(\s{2,})(\S+):\s*$/m);
  const entries = new Map<string, string>();
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const name = parts[i + 1];
    const body = parts[i + 2];
    if (name !== undefined && body !== undefined) entries.set(name, body);
  }

  const keyIn = (body?: string): string | undefined =>
    /^\s+key:\s*(\S+)\s*$/m.exec(body ?? "")?.[1];

  if (active) {
    const chosen = keyIn(entries.get(active));
    if (chosen) return chosen;
  }
  for (const body of entries.values()) {
    const key = keyIn(body);
    if (key) return key;
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
    if (config && typeof config === "object" && "api_key" in config) {
      const value = (config as { api_key?: unknown }).api_key;
      return typeof value === "string" ? value.trim() : "";
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Resolve the credential for one channel.
 *
 * Explicit config wins, then the environment, then the channel's own
 * credential store. Stores are re-read per call rather than cached at module
 * load: they are a few hundred bytes, and caching would pin a rotated key
 * inside a long-lived host process.
 */
export function resolveApiKey(
  channel: TinyfishChannel,
  options: ResolveApiKeyOptions = {},
): string {
  const explicit = options.apiKey?.trim();
  if (explicit) return explicit;

  const env = options.env ?? process.env;
  if (channel === "monid") {
    const fromEnv = env.MONID_API_KEY ?? env.MONID_MCP_TOKEN;
    if (fromEnv?.trim()) return fromEnv.trim();
    return readMonidCredentials(options.credentialsPath ?? DEFAULT_CREDENTIALS);
  }
  const direct = env.TINYFISH_API_KEY;
  if (direct?.trim()) return direct.trim();
  return readTinyfishConfig(options.tinyfishConfigPath ?? DEFAULT_TINYFISH_CONFIG);
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
  options: ResolveApiKeyOptions = {},
): Promise<string> {
  const explicit = options.apiKey?.trim();
  if (explicit) return explicit;

  const { apiKeyEnv, resolveCredential } = options;
  // Check before *invoking* the resolver, not just before awaiting it. An
  // already-aborted caller should not cause a credential lookup at all, and an
  // unguarded rejection from the abandoned call would surface as an
  // unhandledRejection rather than as a cancellation.
  throwIfAborted(options.signal);
  if (apiKeyEnv && resolveCredential) {
    try {
      const stored = await abortable(Promise.resolve(resolveCredential(apiKeyEnv)), options.signal);
      const trimmed = stored?.trim();
      if (trimmed) return trimmed;
    } catch (error) {
      // A failing credential service must not fail the search: the CLI stores
      // are a working fallback, and treating that as fatal would take out a
      // provider that was fine a moment ago. A cancelled signal still wins.
      if (options.signal?.aborted) throw aborted(options.signal, error);
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
      "The tinyfish provider has no Monid API key. Run `monid keys add` to " +
        "store one in the local credential file, or export MONID_API_KEY, or " +
        "set the web-tinyfish `apiKeyEnv` row in the profile's cordis.patch.yml.",
      WEB_PROVIDER_CREDENTIAL_MISSING,
    );
  }
  throw new WebError(
    "The tinyfish provider has no TinyFish API key. Run `tinyfish auth " +
      "login` to save one, or export TINYFISH_API_KEY, or set the " +
      "web-tinyfish `apiKeyEnv` row in the profile's cordis.patch.yml — or " +
      "switch the provider's channel to 'monid' to use a Monid key instead.",
    WEB_PROVIDER_CREDENTIAL_MISSING,
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
  },
): Promise<unknown> {
  const { channel, key, init, signal } = options;
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...(channel === "monid"
      ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
      : { "X-API-Key": key }),
    ...(init.headers as Record<string, string> | undefined),
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
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw aborted(signal);
    if (isAbortError(error)) throw aborted(signal, error);
    throw new WebError(`TinyFish request to ${url} failed: ${String(error)}`, WEB_PROVIDER_ERROR, {
      cause: error,
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new WebError(
      `TinyFish rejected the ${channel} API key (HTTP ${response.status}). ` +
        "Refresh it, or switch the provider's channel.",
      WEB_PROVIDER_ERROR,
    );
  }
  if (response.status === 429) {
    throw new TransientWebError("TinyFish rate limit reached (HTTP 429).", WEB_PROVIDER_ERROR);
  }
  if (!response.ok) {
    throw new WebError(`TinyFish returned HTTP ${response.status} for ${url}`, WEB_PROVIDER_ERROR);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new WebError(`TinyFish returned a non-JSON body for ${url}`, WEB_PROVIDER_ERROR, {
      cause: error,
    });
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
  let envelope = (await call(`${base}/v1/run`, {
    channel: "monid",
    key,
    signal,
    init: {
      method: "POST",
      body: JSON.stringify({
        provider: "tinyfish",
        endpoint: "/search",
        input: { queryParams: params },
      }),
    },
  })) as MonidEnvelope;

  let polls = 0;
  while (envelope.status === "RUNNING" && polls < maxPolls) {
    throwIfAborted(signal);
    polls += 1;
    await sleep(pollMs, signal);
    envelope = (await call(`${base}/v1/run`, {
      channel: "monid",
      key,
      signal,
      init: { method: "POST", body: JSON.stringify({ runId: envelope.runId }) },
    })) as MonidEnvelope;
  }
  if (envelope.status === "RUNNING") {
    throw new WebError(
      `TinyFish run ${envelope.runId ?? "?"} did not settle within ${polls} polls`,
      WEB_PROVIDER_ERROR,
    );
  }
  assertUsableRun(envelope);
  return (envelope.output ?? {}) as unknown as TinyfishSearchPayload;
}

/** Raise for a BLOCKED / FAILED run, which retrying will not fix. */
function assertUsableRun(envelope: MonidEnvelope): void {
  if (envelope.status === "BLOCKED") {
    const reason = envelope.reason;
    const detail =
      reason && typeof reason === "object"
        ? [reason.reason, ...(reason.hints ?? [])].filter(Boolean).join(" ")
        : String(reason ?? "");
    throw new WebError(
      `The Monid workspace blocked this run${detail ? `: ${detail}` : "."} ` +
        "Top up at https://app.monid.ai/wallet.",
      WEB_PROVIDER_ERROR,
    );
  }
  if (envelope.status === "FAILED" || envelope.status === "TIMED_OUT") {
    throw new WebError(
      `TinyFish run ${envelope.runId ?? "?"} ended ${envelope.status}`,
      WEB_PROVIDER_ERROR,
    );
  }
  // `output: null` with a provider error is Monid reporting an upstream
  // failure (rate limiting, 5xx) as a COMPLETED run. Retryable.
  const provider = envelope.providerResponse;
  if (!envelope.output && (provider?.error || (provider?.httpStatus ?? 0) >= 500)) {
    const message = extractProviderMessage(provider?.error);
    throw new TransientWebError(
      `TinyFish is temporarily unavailable${message ? `: ${message}` : "."}`,
      WEB_PROVIDER_ERROR,
    );
  }
}

/** Dig a human message out of Monid's nested provider error, if there is one. */
function extractProviderMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const outer = error as { error?: { message?: unknown } };
  const message = outer.error?.message;
  return typeof message === "string" ? message : "";
}

/* ------------------------------------------------------------------- fetch */

/** One fetch through the monid channel. */
async function fetchMonid(options: {
  key: string;
  base: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<TinyfishFetchPayload> {
  const { key, base, body, signal } = options;
  const envelope = (await call(`${base}/v1/run`, {
    channel: "monid",
    key,
    signal,
    init: {
      method: "POST",
      body: JSON.stringify({
        provider: "tinyfish",
        endpoint: "/fetch",
        input: { body },
      }),
    },
  })) as MonidEnvelope;
  assertUsableRun(envelope);
  return (envelope.output ?? {}) as unknown as TinyfishFetchPayload;
}

/* ------------------------------------------------------------------- api */

/** What the retry loop needs to decide whether another attempt is worthwhile. */
interface RetryPolicy {
  attempts: number;
  signal?: AbortSignal;
  delayMs?: number;
  retryWhen?: (value: unknown) => boolean;
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
async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  const { attempts, signal, delayMs = DEFAULT_RETRY_DELAY_MS, retryWhen, onRetry } = policy;
  let lastError: TransientWebError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await operation();
      if (attempt > 1) onRetry?.(attempt, attempts, lastError);
      if (!retryWhen?.(value) || attempt === attempts) return value;
      onRetry?.(attempt, attempts);
    } catch (error) {
      // A cancelled attempt is not a failed attempt: retrying it would spend
      // another call on work the caller has already given up on.
      if (signal?.aborted) throw aborted(signal, error);
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
  monidBase?: string;
  searchBase?: string;
  signal?: AbortSignal;
  attempts?: number;
  /** Base backoff between attempts, in ms; doubles per attempt. Default 1200. */
  delayMs?: number;
  onRetry?: (attempt: number, total: number) => void;
  /** Poll cadence for an async Monid run. */
  pollMs?: number;
  maxPolls?: number;
}

/** Everything a fetch call can be pointed at. */
export interface TinyfishFetchOptions extends ResolveApiKeyOptions {
  channel: TinyfishChannel;
  urls: string[];
  /** Goal statement forwarded upstream; TinyFish ranks on it. */
  purpose?: string;
  monidBase?: string;
  fetchBase?: string;
  signal?: AbortSignal;
  attempts?: number;
  /** Base backoff between attempts, in ms; doubles per attempt. Default 1200. */
  delayMs?: number;
  onRetry?: (attempt: number, total: number) => void;
}

/**
 * Search TinyFish. Returns the upstream payload for both channels:
 * `{ query, results[], total_results, page }`.
 */
export async function tinyfishSearch(
  options: TinyfishSearchOptions,
): Promise<TinyfishSearchPayload> {
  const {
    channel,
    query,
    apiKey,
    credentialsPath,
    tinyfishConfigPath,
    filters = {},
    monidBase = DEFAULT_MONID_BASE,
    searchBase = DEFAULT_SEARCH_BASE,
    signal,
    attempts = 3,
    delayMs,
    onRetry,
    pollMs = DEFAULT_POLL_MS,
    maxPolls = DEFAULT_MAX_POLLS,
  } = options;

  const key = resolveApiKey(channel, {
    apiKey,
    credentialsPath,
    tinyfishConfigPath,
  });
  requireKey(channel, key);
  const params: Record<string, string | number> = { query, ...filters };

  return withRetry<TinyfishSearchPayload>(
    () =>
      channel === "monid"
        ? searchMonid({
            key,
            base: monidBase,
            params,
            signal,
            pollMs,
            maxPolls,
          })
        : (call(`${searchBase}?${searchQueryString(params)}`, {
            channel: "direct",
            key,
            signal,
            init: { method: "GET" },
          }) as Promise<TinyfishSearchPayload>),
    {
      attempts,
      signal,
      delayMs,
      // A zero-result search is usually the upstream flake, not the answer.
      retryWhen: (payload) => {
        const value = payload as TinyfishSearchPayload;
        return !Array.isArray(value?.results) || value.results.length === 0;
      },
      onRetry: (attempt, total) => onRetry?.(attempt, total),
    },
  );
}

/**
 * Fetch up to 10 URLs as clean Markdown. Returns the upstream payload for both
 * channels: `{ results[], errors[] }`.
 */
export async function tinyfishFetch(options: TinyfishFetchOptions): Promise<TinyfishFetchPayload> {
  const {
    channel,
    urls,
    apiKey,
    credentialsPath,
    tinyfishConfigPath,
    purpose,
    monidBase = DEFAULT_MONID_BASE,
    fetchBase = DEFAULT_FETCH_BASE,
    signal,
    attempts = 3,
    delayMs,
    onRetry,
  } = options;

  const key = resolveApiKey(channel, {
    apiKey,
    credentialsPath,
    tinyfishConfigPath,
  });
  requireKey(channel, key);
  const body: Record<string, unknown> = { urls, format: "markdown" };
  if (purpose) body.purpose = purpose;

  return withRetry<TinyfishFetchPayload>(
    () =>
      channel === "monid"
        ? fetchMonid({ key, base: monidBase, body, signal })
        : (call(fetchBase, {
            channel: "direct",
            key,
            signal,
            init: { method: "POST", body: JSON.stringify(body) },
          }) as Promise<TinyfishFetchPayload>),
    {
      attempts,
      signal,
      delayMs,
      onRetry: (attempt, total) => onRetry?.(attempt, total),
    },
  );
}
