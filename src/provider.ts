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
  /** Upstream-named search filters, already snake_case. */
  readonly filters: Readonly<Record<string, string>>;
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

  // Already zoned, or carries a clock time: parse as given.
  const zoned =
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || /\d{1,2}:\d{2}/.test(text);

  let candidate = text;
  if (!zoned) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      candidate = `${text}T00:00:00Z`;
    } else if (/^[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}$/.test(text)) {
      candidate = `${text} UTC`;
    }
  }

  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

/**
 * A result row the seam can report.
 *
 * A row with no URL has nowhere to link, so it is dropped before the mapping
 * rather than reported with a placeholder. Written as a *type predicate* and
 * not a boolean: the same `typeof row.url === "string"` test inline gives TS
 * nothing to narrow, which is precisely what used to force an
 * `as string` on the very next line.
 */
const hasUrl = (
  row: TinyfishSearchHit
): row is TinyfishSearchHit & { readonly url: string } =>
  typeof row.url === "string" && row.url !== "";

/**
 * TinyFish search through the `ctx.web` search seam.
 *
 * The seam's request is only `{query, maxResults}`; everything else
 * (`domainType`, `location`, `includeDomains`, …) comes from plugin config and
 * applies to every query, which is the shape these filters actually want.
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
   * Checks the same things the shipped providers do: a credential is
   * resolvable *and* both endpoints parse as URLs. A misconfigured base is a
   * setup mistake worth surfacing at selection time rather than as a 404 later.
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
      URL.canParse(options.searchBase) &&
      (options.channel === "direct" || URL.canParse(options.monidBase))
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
      sources: results.filter(hasUrl).map((row) => {
        const source: {
          url: string;
          title?: string;
          snippet?: string;
          publishedAt?: string;
        } = { url: row.url };
        if (row.title !== "" && row.title !== undefined) {
          source.title = row.title;
        }
        // Monid names the snippet `snippet`; the direct API documents it
        // the same way, but accept `description` in case that ever shifts.
        const snippet = row.snippet ?? row.description;
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
   * Checks the same things the shipped providers do: a credential is
   * resolvable *and* both endpoints parse as URLs. A misconfigured base is a
   * setup mistake worth surfacing at selection time rather than as a 404 later.
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
      URL.canParse(options.fetchBase) &&
      (options.channel === "direct" || URL.canParse(options.monidBase))
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
    const failure = errors.find((row) => sameUrl(row?.url, request.url));
    if (!results.length && failure) {
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

    const page = results[0];
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
 * True when this configuration can produce a credential without a network
 * call: a literal key, the environment, or a credential the CLIs already
 * stored. A `credential-ref` resolved by the harness service is not visible
 * from here, so a plugin that relies on one stays available through the
 * service-backed path in the client.
 */
function hasCredential(options: TinyfishProviderOptions): boolean {
  // The active channel's ref, not a shared one: a direct-channel check that
  // consulted the monid ref would report "configured" off a Monid key.
  const ref =
    options.channel === "monid" ? options.monidKeyEnv : options.apiKeyEnv;
  return Boolean(
    resolveApiKey(options.channel, {
      apiKey: options.apiKey,
      monidKeyEnv: options.monidKeyEnv,
      env: {
        // The channel's ref is checked under both the harness convention and
        // the per-channel variable, because a ref may name either.
        TINYFISH_API_KEY: process.env[ref],
        MONID_API_KEY: process.env[ref],
        MONID_MCP_TOKEN: process.env[ref],
      },
    })
  );
}

/** Compare URLs ignoring a trailing slash, so `/a` and `/a/` match. */
function sameUrl(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const strip = (value: string): string => value.replace(/\/+$/, "");
  return strip(a) === strip(b);
}
