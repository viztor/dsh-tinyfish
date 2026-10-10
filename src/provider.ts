import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "@deepseek-ai/dsh-web";

import {
  WebError,
  type CredentialResolver,
  WEB_PROVIDER_ERROR,
  type TinyfishChannel,
  type TinyfishFetchDefaults,
  type TinyfishFetchPayload,
  type TinyfishSearchHit,
  type TinyfishSearchPayload,
  resolveApiKey,
  tinyfishFetch,
  tinyfishSearch,
} from "./client.ts";

/**
 * The two `ctx.web` providers.
 *
 * Both are thin: dispatch through the transport, then normalise TinyFish's
 * payload into the seam's vocabulary. The seam owns `maxResults` truncation,
 * cancellation, error codes and the tool card, so nothing here re-implements
 * any of that.
 *
 * @module dsh-tinyfish/provider
 */

/** Stable id these providers register under. */
export const TINYFISH_PROVIDER_ID = "tinyfish";

/** Options a provider snapshots once per operation. */
export interface TinyfishProviderOptions {
  readonly channel: TinyfishChannel;
  /** A literal credential, if the settings row carries one. */
  readonly apiKey?: string;
  /**
   * Name of a stored credential or environment variable to read.
   *
   * Resolved through the harness credentials service when one is present, so
   * the value can be rotated or supplied from Settings without editing a patch
   * file — and without the plugin ever holding a copy.
   */
  readonly apiKeyEnv: string;
  /**
   * The monid channel's stored-credential name.
   *
   * Separate from {@link TinyfishProviderOptions.apiKeyEnv} because the two
   * channels authenticate against different services, so a user who has both
   * keys must be able to save both without one overwriting the other.
   */
  readonly monidKeyEnv: string;
  /**
   * Resolves a stored credential by name, when the host provides a service.
   *
   * Built by `apply` from `ctx`, so the plugin uses the *host's* credentials
   * service instance rather than a private copy — a second instance would have
   * its own store and never see what the user changed in Settings.
   */
  readonly resolveCredential?: CredentialResolver;
  /** Goal statement forwarded upstream; TinyFish ranks on it. */
  readonly purpose?: string;
  /** Upstream-named search filters, already snake_case. Values may be numeric
   * (`recency_minutes`, `pub_year_min` are integers upstream); the direct
   * channel stringifies them into the query string, the monid channel keeps
   * them as JSON numbers in `queryParams`. */
  readonly filters: Readonly<Record<string, string | number>>;
  /** Upstream-named fetch body defaults, already snake_case; see
   * {@link TinyfishFetchDefaults}. Always present, possibly empty. */
  readonly fetchOptions: Readonly<TinyfishFetchDefaults>;
  readonly attempts: number;
  readonly monidBase: string;
  readonly searchBase: string;
  readonly fetchBase: string;

  /**
   * Whether to *offer* this kind. Both providers always register, so a disabled
   * kind reports itself unavailable rather than missing — `dsh-web` distinguishes
   * `WEB_PROVIDER_CONFIGURED_MISSING` (a named id that was never registered,
   * usually a broken install) from `WEB_PROVIDER_UNAVAILABLE` (a registered
   * provider that declined), and the second is what "I turned this off" means.
   */
  readonly search: boolean;
  readonly fetch: boolean;
}

/** Resolves the options for the *next* operation. */
export type TinyfishOptionsSource = () => TinyfishProviderOptions;

/**
 * TinyFish reports dates as human strings ("Apr 30, 2026", "1 year ago"), but
 * `WebSearchSource.publishedAt` is contractually an ISO-8601 string. Rather
 * than pass a value the type does not promise, coerce what parses and drop the
 * rest — a missing date is honest, a malformed one is not.
 *
 * A date carrying no timezone is read as UTC, not local. `Date.parse("Apr 30,
 * 2026")` means local midnight, so `.toISOString()` would shift the day for any
 * host east or west of Greenwich — the same page would report a different
 * `publishedAt` depending on where the Worker ran. These strings are date-only,
 * so UTC midnight is both the stable reading and the one that keeps the day the
 * publisher actually meant.
 */
export function toIsoDate(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();

  // Already zoned: parse as given. Everything else is read as UTC, which is
  // what this function promises and what the two special cases used to be the
  // only cover for. A clock time was the gap: `\d{1,2}:\d{2}` counted as
  // "zoned", so `2026-04-30T12:00:00` and `Apr 30, 2026 12:00` were parsed as
  // *local* and `.toISOString()` moved the instant by the host's offset —
  // `30 Apr 2026` landed a day early. The suffix differs by shape because `Z`
  // appended to a human date parses as nothing at all.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);

  let candidate = text;
  if (!zoned) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      candidate = `${text}T00:00:00Z`;
    } else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) {
      candidate = `${text.replace(" ", "T")}Z`;
    } else {
      candidate = `${text} UTC`;
    }
  }

  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

/**
 * The absolute http(s) form of `value`, normalized — or `undefined`.
 *
 * Returns `href` rather than a boolean, and that is the point of the function
 * rather than a detail: the caller used to validate the *parsed* URL and then
 * report the *raw* string, so the model could be handed
 * `"  https://a.example/p  "` or `"HTTPS://a.example/p"` — both of which parse,
 * both of which are the same URL the check approved, and neither of which is
 * what got checked. Reporting `href` means the string that ships is the one
 * this function read.
 *
 * A scheme check is still required on top of parseability: `URL` happily
 * parses `javascript:` and `ftp:`, neither of which `web_fetch` can resolve,
 * and it parses `mailto:` about as readily as anything else.
 */
const absoluteHttpUrl = (value: string): string | undefined => {
  const parsed = URL.parse(value);
  if (parsed === null) return undefined;
  const { protocol } = parsed;
  return protocol === "http:" || protocol === "https:"
    ? parsed.href
    : undefined;
};

/**
 * A placeholder origin for parsing a relative redirect reference.
 *
 * RFC 3986 reserves `.invalid` precisely for this: it can never resolve, so a
 * wrapper parsed against it can never be mistaken for a real destination.
 */
const REDIRECT_PARSE_BASE = "https://redirect-parse.invalid";

/**
 * The destination a hit's `url` actually points at, or `undefined`.
 *
 * The live suite is what forced this shape. The monid SERP mirror can answer
 * with a search engine's redirect wrapper instead of the destination:
 *
 *     /url?opi=89978449&q=https%3A%2F%2Fexample.com%2Fpage&sa=U&ved=…
 *
 * Every row comes back that way, so the first attempt — requiring an absolute
 * http(s) URL and dropping whatever failed — turned ten results into zero
 * sources and emptied the channel outright. Worse than the original bug, and
 * only visible by running the live suite.
 *
 * The destination is in a query parameter, so it is unwrapped. `web_fetch`
 * cannot resolve a relative path, the model cannot cite one, and clicking one
 * goes nowhere; reporting the wrapper makes all three worse. Only a row that
 * yields no usable destination is dropped.
 *
 * The parameter names are the ones search engines use for this. Taking the
 * first that is itself an absolute http(s) URL means an unrelated `q` cannot
 * win: the value is checked, not the key.
 */
const targetUrl = (value: string): string | undefined => {
  const direct = absoluteHttpUrl(value);
  if (direct !== undefined) return direct;
  // The base is load-bearing, and omitting it was this function's own first
  // bug: `URL.canParse("/url?q=…")` answers false for a relative reference, so
  // the wrapper bailed out before its query string was ever read and the whole
  // channel stayed empty. Resolved against a placeholder origin that is never
  // dialled — it exists only to give a relative reference something to parse
  // against.
  const parsed = URL.parse(value, REDIRECT_PARSE_BASE);
  if (parsed === null) return undefined;
  for (const key of ["q", "url", "u", "target"]) {
    const candidate = parsed.searchParams.get(key);
    if (candidate === null) continue;
    // Normalized here too, for the same reason as the direct branch: a `q`
    // carrying padded or mixed-case text produced a destination that parsed and
    // was not what shipped.
    const unwrapped = absoluteHttpUrl(candidate);
    if (unwrapped !== undefined) return unwrapped;
  }
  return undefined;
};

/** A row reduced to what the seam needs: the destination, and its own fields. */
interface CiteableRow {
  readonly url: string;
  readonly row: TinyfishSearchHit;
}

/**
 * A result row the seam can report.
 *
 * A row with no URL has nowhere to link, so it is dropped before the mapping
 * rather than reported with a placeholder. Written as a projection rather than a
 * boolean test, because the usable URL is not always `row.url`: a redirect
 * wrapper has to be unwrapped first, and a type predicate cannot carry that.
 */
const citable = (row: TinyfishSearchHit): CiteableRow | undefined => {
  if (typeof row.url !== "string") return undefined;
  const url = targetUrl(row.url);
  return url === undefined ? undefined : { url, row };
};

/**
 * TinyFish search through the `ctx.web` search seam.
 *
 * The seam's request is only `{query, maxResults}`; everything else
 * (`domainType`, `location`, `includeDomains`, `purpose`, …) comes from plugin
 * config and applies to every query, which is the shape these filters
 * actually want.
 */
export class TinyfishSearchProvider implements WebSearchProvider {
  readonly id = TINYFISH_PROVIDER_ID;

  // Declared and assigned rather than a parameter property: this module runs
  // under Node's type stripping (the tests import it as TypeScript), which
  // permits only erasable syntax. A constructor parameter property is not
  // erasable — it compiles to an assignment the stripper cannot emit.
  private readonly resolveOptions: TinyfishOptionsSource;

  /**
   * @param resolveOptions - a thunk, not a value: the plugin's settings section
   *   can change between searches, and re-registering the provider to carry a
   *   new config would make the seam's selection flicker for the user.
   */
  constructor(resolveOptions: TinyfishOptionsSource) {
    this.resolveOptions = resolveOptions;
  }

  /**
   * Cheap local usability check. Must not make network calls — the seam calls
   * this to decide between providers, and a network call here would turn
   * selection into a latency spike on every search.
   *
   * Checks the same things the shipped providers do, and only those: a
   * credential is resolvable *and* the endpoint *this channel dials* parses
   * as a URL. A misconfigured base is a setup mistake worth surfacing at
   * selection time rather than as a 404 later. The other channel's base is
   * deliberately not required — no request reads it, so demanding it refused
   * a working provider over a setting nothing uses.
   */
  available(): boolean {
    const options = this.resolveOptions();
    // `Boolean(...)`: `&&` yields the first falsy *operand*, not `false`, so an
    // unset flag made this return `undefined` from a method the seam declares as
    // `available(): boolean`. The live suite caught it — an untyped test fixture
    // omitted the flag and got `undefined` instead of a clean `false`.
    //
    // `search` is typed as required, so the conversion below looks redundant to
    // the type checker. What it defends is the seam contract, and the suite
    // asserts a strict boolean for a malformed row. Silenced for this one line
    // rather than obeyed by deleting the guard.
    // oxlint-disable-next-line typescript/no-unnecessary-type-conversion
    return Boolean(
      options.search &&
      hasCredential(options) &&
      // Only the base this channel dials. Requiring the direct base for a
      // monid config refused a provider whose request path never reads it —
      // dsh-web turns that into WEB_PROVIDER_CONFIGURED_UNAVAILABLE, so a
      // working setup read as a broken install. Same reasoning as the fetch
      // side, where a bad `searchBase` once disabled a good fetch.
      (options.channel === "monid"
        ? URL.canParse(options.monidBase)
        : URL.canParse(options.searchBase))
    );
  }

  async search(
    request: WebSearchRequest,
    signal?: AbortSignal
  ): Promise<WebSearchResult> {
    const options = this.resolveOptions();
    const payload: TinyfishSearchPayload = await tinyfishSearch({
      channel: options.channel,
      apiKey: options.apiKey,
      // The stored-credential path. Without these two the Settings credential
      // is never consulted and a key saved from the UI is silently ignored in
      // favour of the environment and the CLI stores.
      apiKeyEnv: options.apiKeyEnv,
      monidKeyEnv: options.monidKeyEnv,
      resolveCredential: options.resolveCredential,
      query: request.query,
      // The goal statement rides search as well as fetch: TinyFish uses it as
      // ranking signal for both, and the seam offers no per-request place to
      // put one — this is the standing default the config row sets.
      purpose: options.purpose,
      filters: { ...options.filters },
      monidBase: options.monidBase,
      searchBase: options.searchBase,
      signal,
      attempts: options.attempts,
    });

    const results = Array.isArray(payload?.results) ? payload.results : [];
    return {
      // TinyFish returns ranked results, not a generated answer. `content`
      // stays unset rather than being filled with the query echo.
      sources: results
        .map(citable)
        .filter((entry): entry is CiteableRow => entry !== undefined)
        .map(({ row, url }) => {
          const source: {
            url: string;
            title?: string;
            snippet?: string;
            publishedAt?: string;
          } = { url };
          if (row.title !== "" && row.title !== undefined) {
            source.title = row.title;
          }
          // Monid names the snippet `snippet`; the direct API documents it
          // the same way, but accept `description` in case that ever shifts.
          // An empty `snippet` is upstream saying it has none, so the alias is
          // the better answer. `??` accepted the empty string and dropped the
          // description with it.
          const snippet =
            row.snippet === undefined || row.snippet === ""
              ? row.description
              : row.snippet;
          if (snippet !== "" && snippet !== undefined) {
            source.snippet = snippet;
          }
          const publishedAt = toIsoDate(row.date);
          if (publishedAt !== undefined) source.publishedAt = publishedAt;
          return source;
        }),
      // The seam truncates to `maxResults` and owns this flag.
      truncated: false,
    };
  }
}

/**
 * TinyFish fetch through the `ctx.web` fetch seam.
 *
 * Returns `kind: "text"` on purpose: TinyFish already extracts clean Markdown,
 * so `dsh-tool-web` passes it straight through. The `http` provider instead
 * returns `kind: "html"` and pays for a turndown conversion this path skips.
 */
export class TinyfishFetchProvider implements WebFetchProvider {
  readonly id = TINYFISH_PROVIDER_ID;

  /** A thunk, not a value; see {@link TinyfishSearchProvider} for why. */
  private readonly resolveOptions: TinyfishOptionsSource;

  constructor(resolveOptions: TinyfishOptionsSource) {
    this.resolveOptions = resolveOptions;
  }

  /**
   * Cheap local usability check. Must not make network calls — the seam calls
   * this to decide between providers, and a network call here would turn
   * selection into a latency spike on every search.
   *
   * Checks the same things the shipped providers do, and only those: a
   * credential is resolvable *and* the endpoint *this channel dials* parses
   * as a URL. A misconfigured base is a setup mistake worth surfacing at
   * selection time rather than as a 404 later. The other channel's base is
   * deliberately not required — no request reads it, so demanding it refused
   * a working provider over a setting nothing uses.
   */
  available(): boolean {
    const options = this.resolveOptions();
    // Its own switch and its own endpoint. This checked `search` and
    // `searchBase` until the switch tests forced the question: a typo'd
    // `fetchBase` reported the provider available and then failed at request
    // time, and a bad `searchBase` disabled a perfectly good fetch.
    // oxlint-disable-next-line typescript/no-unnecessary-type-conversion
    return Boolean(
      options.fetch &&
      hasCredential(options) &&
      // As above: the base this channel dials, and no other.
      (options.channel === "monid"
        ? URL.canParse(options.monidBase)
        : URL.canParse(options.fetchBase))
    );
  }

  async fetch(
    request: WebFetchRequest,
    signal?: AbortSignal
  ): Promise<WebFetchResult> {
    const options = this.resolveOptions();
    const payload: TinyfishFetchPayload = await tinyfishFetch({
      channel: options.channel,
      apiKey: options.apiKey,
      // The stored-credential path. Without these two the Settings credential
      // is never consulted and a key saved from the UI is silently ignored in
      // favour of the environment and the CLI stores.
      apiKeyEnv: options.apiKeyEnv,
      monidKeyEnv: options.monidKeyEnv,
      resolveCredential: options.resolveCredential,
      urls: [request.url],
      purpose: options.purpose,
      fetchOptions: options.fetchOptions,
      monidBase: options.monidBase,
      fetchBase: options.fetchBase,
      signal,
      attempts: options.attempts,
    });

    const results = Array.isArray(payload?.results) ? payload.results : [];
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];

    // A per-URL failure is a result, not a WebError: the seam's contract says
    // a non-2xx response is part of the fetched resource state, and the model
    // needs the status to reason about it (a 404 is information, not a fault).
    // Match the page to *this* request rather than trusting position. Testing
    // `results.length` meant a results[] entry for some other URL was returned
    // as this one's content with statusCode 200, hiding the 4xx that had been
    // reported for the URL actually asked for. `url` is the requested URL and
    // `final_url` the post-redirect one, so `url` matches first and the
    // fallback only covers a row that omitted it. A failure row with no `url`
    // counts as this request's: the transport sends exactly one URL.
    const failure = errors.find(
      (row) => row.url === undefined || sameUrl(row.url, request.url)
    );
    const page = results.find((row) =>
      sameUrl(row.url ?? row.final_url, request.url)
    );
    if (!page && failure) {
      const status = Number(failure.status);
      return {
        url: request.url,
        statusCode: Number.isFinite(status) && status > 0 ? status : 502,
        body: {
          kind: "text",
          content:
            `Could not retrieve this page: ${failure.error ?? "fetch failed"}` +
            ` (HTTP ${failure.status ?? "?"}).`,
        },
        truncated: false,
      };
    }

    if (!page) {
      // Neither a result nor an error entry: the upstream answered, but with
      // nothing usable. That is a provider fault, not a resource state.
      throw new WebError(
        `TinyFish returned no content for ${request.url}`,
        WEB_PROVIDER_ERROR
      );
    }

    return {
      url: page.final_url ?? page.url ?? request.url,
      // TinyFish does not surface the origin's status on success. Anything
      // that reached this branch came back 2xx.
      statusCode: 200,
      body: { kind: "text", content: page.text ?? "" },
      truncated: false,
    };
  }
}

/**
 * True when this configuration can produce a credential, answering the way
 * the request that follows it will.
 *
 * The synchronous rungs — a literal key, the environment, the credential the
 * CLI already stored — go through `resolveApiKey` with the real environment,
 * so the check and the request cannot disagree about them. The harness
 * credentials service is the one rung this cannot consult: `resolve` is async
 * and `available()` must answer synchronously, because `dsh-web` calls it to
 * choose between providers. A wired resolver therefore answers "possibly"
 * rather than the "no" a local miss would give.
 *
 * That matters because the service is the documented home for both keys
 * (README's second rung, and where the settings page saves one). Reporting a
 * Settings-saved key as absent made `dsh-web` throw
 * WEB_PROVIDER_CONFIGURED_UNAVAILABLE before `resolveApiKeyAsync` ever got the
 * chance to resolve it — a hard failure on a working configuration. A
 * genuinely absent key is still reported, and reported better: `requireKey`
 * raises WEB_PROVIDER_CREDENTIAL_MISSING, which names where to save the key,
 * where "registered but unavailable" reads as a broken install.
 */
function hasCredential(options: TinyfishProviderOptions): boolean {
  // Forwarded, never rebuilt: `resolveApiKey` picks the active channel's ref
  // itself (`monidKeyEnv` for monid, `apiKeyEnv` otherwise), reads that ref
  // first, and then the channel's conventional names. Deriving a synthetic env
  // instead dropped the configured-ref rung and looked each conventional name
  // up under the wrong variable — two rungs the request path honours and this
  // check could not see.
  return (
    Boolean(
      resolveApiKey(options.channel, {
        apiKey: options.apiKey,
        apiKeyEnv: options.apiKeyEnv,
        monidKeyEnv: options.monidKeyEnv,
      })
    ) ||
    // Presence, not a value: the resolver is never invoked here, because a
    // lookup this function cannot await would be a promise nobody settles.
    options.resolveCredential !== undefined
  );
}

/** Compare URLs ignoring a trailing slash, so `/a` and `/a/` match. */
function sameUrl(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const strip = (value: string): string => value.replace(/\/+$/, "");
  return strip(a) === strip(b);
}
