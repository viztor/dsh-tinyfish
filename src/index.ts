import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";

import type { CredentialResolver, TinyfishFetchDefaults } from "./client.ts";
import {
  DEFAULT_FETCH_BASE,
  DEFAULT_MONID_BASE,
  DEFAULT_SEARCH_BASE,
} from "./client.ts";
import { isBoxed, isRecord } from "./guard.ts";
import {
  TinyfishFetchProvider,
  TinyfishSearchProvider,
  type TinyfishProviderOptions,
} from "./provider.ts";

/**
 * `dsh-tinyfish` — TinyFish-backed search and fetch for the DSH web
 * capability seam.
 *
 * Registers two providers under one id, `tinyfish`, and lets the profile pick
 * the channel:
 *
 *   monid  — reach TinyFish through the Monid REST API. Costs nothing on the
 *            Monid wallet, and reuses the credential the MCP mount already
 *            holds, so it keeps working when no TinyFish account is configured.
 *   direct — call TinyFish's own API, using the key the `tinyfish` CLI already
 *            stored in ~/.tinyfish/config.json.
 *
 * Both channels return the same upstream payload, so nothing above this file
 * branches on which one is active.
 *
 * @module dsh-tinyfish
 */

/** Settings namespace, matching the plugin identity. */
export const TINYFISH_SETTINGS_NAMESPACE = "dsh-tinyfish";
export const WEB_TINYFISH_SETTINGS_NAMESPACE = TINYFISH_SETTINGS_NAMESPACE;

/**
 * Upstream's cap on `purpose`, in characters. Both `/search` and `/fetch`
 * declare `maxLength: 2000` and answer a hard 4xx past it — and this field
 * rides every search and fetch, so one over-long goal statement would take
 * both tools down until the row is found. The schema refuses the row; a raw
 * row that skipped validation loses the sentence instead.
 */
const PURPOSE_MAX_CHARS = 2000;

/**
 * The plugin's settings schema.
 *
 * This is the harness's own `@deepseek-ai/schemastery` fork rather than the
 * public package, because the fork is what implements the `.role()`,
 * `.volatile()` and `.get()` surface the loader and the settings UI both rely
 * on, and the public 3.18.x line does not have it. Cordis resolves a plugin's
 * `Config` through `resolveConfig` and falls back to the raw row when a plugin
 * exports none — so exporting this is what makes the row render as a real
 * settings section rather than free-form YAML.
 *
 * - `role("secret")` keeps a literal key out of any redacted dump.
 * - `role("credential-ref")` makes a field a *reference* to a stored
 *   credential, resolved through `ctx.get("credentials")` — the way the shipped
 *   search provider does it, so the value is manageable from Settings instead
 *   of only from a patch file.
 * - `volatile()` marks a field that must be re-read at the start of every
 *   operation. Everything here is: a key can be rotated while the harness is
 *   running, and a provider that captured one at load time would keep sending
 *   a dead credential.
 */
export const Config = z.object({
  channel: z
    .union([z.const("monid"), z.const("direct")])
    // `direct`, not `monid`: the package is named for TinyFish, so a fresh
    // install should ask for the credential its own name implies rather than
    // for an account at a different service. Hosts that prefer the Monid
    // envelope pin `channel: monid` in their own patch layer, which is a
    // host decision and belongs there.
    .default("direct")
    .description(
      "Which upstream route to use. `monid` reuses the MCP credential."
    ),
  apiKey: z
    .string()
    .role("secret")
    .volatile()
    .description(
      "Literal credential, overriding both refs. Prefer a credential ref or the environment."
    ),
  apiKeyEnv: z
    .string()
    .role("credential-ref")
    .default("TINYFISH_API_KEY")
    .volatile()
    .description(
      "Stored credential or environment variable for the direct channel."
    ),
  monidKeyEnv: z
    .string()
    .role("credential-ref")
    .default("MONID_API_KEY")
    .volatile()
    .description(
      "Stored credential or environment variable for the monid channel. Kept separate so both keys can be saved at once."
    ),
  purpose: z
    .string()
    .max(PURPOSE_MAX_CHARS)
    .volatile()
    .description(
      "Goal statement sent with every search and fetch; TinyFish ranks on it. Upstream caps it at 2000 characters."
    ),
  attempts: z
    .number()
    .step(1)
    .min(1)
    .max(5)
    .default(3)
    .volatile()
    .description("Attempts for a transient failure or an empty search."),
  filters: z
    .object({
      domainType: z
        .union([z.const("web"), z.const("news"), z.const("research_paper")])
        .description("Restrict the result corpus."),
      language: z
        .string()
        .description("Language code for geo-targeted results."),
      location: z
        .string()
        .description("Location code for geo-targeted results."),
      includeDomains: z
        .string()
        .description("Comma-separated domains to allow."),
      excludeDomains: z
        .string()
        .description("Comma-separated domains to drop."),
      recencyMinutes: z
        .number()
        .step(1)
        .min(1)
        .max(5_256_000)
        .description(
          "Freshness window in minutes (1–5256000). Mutually exclusive with afterDate upstream — a row setting both sends both. Upstream rejects the whole search while set with domainType research_paper."
        ),
      afterDate: z
        .string()
        .pattern(/^\d{4}-\d{2}-\d{2}$/)
        .description(
          "Lower publication-date bound, YYYY-MM-DD. Mutually exclusive with recencyMinutes upstream; with domainType research_paper, upstream rejects the whole search while it is set (scope by year with pubYearMin instead)."
        ),
      pubYearMin: z
        .number()
        .step(1)
        .min(0)
        .max(9999)
        .description(
          "Lower publication-year bound (0–9999); only valid with domainType research_paper — upstream rejects the whole search otherwise."
        ),
    })
    .description("Search filters applied to every query.")
    .volatile(),
  fetchOptions: z
    .object({
      ttl: z
        .number()
        .step(1)
        .min(0)
        .description(
          "Cache freshness tolerance in seconds; 0 forces a live fetch, unset accepts any cached entry."
        ),
      perUrlTimeoutMs: z
        .number()
        .step(1)
        .min(1)
        .max(110_000)
        .description("Per-URL wall-clock budget in ms (1–110000)."),
      excludeSelectors: z
        .string()
        .description(
          "Comma-separated CSS selectors removed before extraction (1–20 entries, each ≤1000 chars); unmatched selectors are a no-op. Direct PDF/CSV downloads have no HTML to prune and fail with selector_unsupported while this is set."
        ),
    })
    .description("Fetch body fields applied to every fetch. Patch file only.")
    .volatile(),
  monidBase: z
    .string()
    .default(DEFAULT_MONID_BASE)
    .description("Monid REST base."),
  searchBase: z
    .string()
    .default(DEFAULT_SEARCH_BASE)
    .description("TinyFish search base."),
  fetchBase: z
    .string()
    .default(DEFAULT_FETCH_BASE)
    .description("TinyFish fetch base."),

  // Per-kind switches. `ctx.web` already keeps two independent registries and
  // `dsh-web` selects each separately, so search and fetch could always be
  // pointed at different providers — but only by editing `dsh-web`'s own row.
  // These make the choice settable in this row, where someone configuring
  // TinyFish is already looking. Both providers always register; a switch
  // that is off only reports that kind unavailable.
  search: z
    .boolean()
    .default(true)
    .description("Provide TinyFish search; off reports it unavailable."),
  fetch: z
    .boolean()
    .default(true)
    .description("Provide TinyFish fetch; off reports it unavailable."),
});

/** Cordis service dependencies. */
export const inject = ["web"];

/**
 * The bundle name, as the code calls itself.
 *
 * The exported `name` is this plugin's identity — log lines, the settings
 * namespace, the service scope — and it stays `dsh-tinyfish` even when the
 * package is installed as `@viztor/dsh-tinyfish`. What must match the
 * installed package name is the cordis row `name` in `cordis.patch.yml`,
 * because the host resolves row names to `node_modules` paths;
 * `scripts/publish-scoped.ts` rewrites that row for the alias, and
 * `dsh-opencode-patch` shipped the failure this avoids — an unscoped row name
 * under a scoped package answers "failed to import".
 *
 * Package identity is the install path (`node_modules/dsh-tinyfish` vs
 * `node_modules/@viztor/dsh-tinyfish`); the providers register as `tinyfish`
 * and the settings live under the row id `dsh-tinyfish`, so either install
 * name reads and writes the same settings. Install exactly one — mounting
 * both loads the bundle twice.
 */
export const name = "dsh-tinyfish";

/**
 * Clamp `attempts` to a range the retry loop can honour.
 *
 * Blank means unset, not zero. The value arrives via `readField`, which turns
 * an absent field into `""`, and `Number("")` is `0` — finite, and therefore
 * clamped up to the minimum of 1 rather than falling back to the default. A
 * field the user never set would have silently become "try once".
 */
function normalizeAttempts(value: unknown): number {
  if (value === "" || value === null || value === undefined) return 3;
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.floor(n)));
}

/**
 * Coerce one config value to a string, refusing anything that is not scalar.
 *
 * A validated section hands out boxed schema nodes; a raw patch row does not.
 * Both have to be readable, because a plugin can be called either way.
 */
function asScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  // The typeof tests are inlined rather than hoisted into a `type` variable so
  // the narrowing survives: `value` is `unknown`, and a stored `type` would
  // leave the compiler — and a type-aware lint rule — unable to tell an object
  // from a number.
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // An object here is a mistake — a nested section read as a scalar, or a
  // typo'd key. Returning "" keeps the rest of the config working rather than
  // poisoning the request with "[object Object]".
  return "";
}

/** Read one field from a section, whether it is boxed (`.get()`) or raw. */
function readField(section: Record<string, unknown>, key: string): string {
  const value = section[key];
  return asScalar(isBoxed(value) ? value.get() : value);
}

/**
 * Read a nested section (`filters`, `fetchOptions`) as a plain record.
 *
 * On a validated row the section itself is a boxed schema node — an object
 * whose members are read through `.get()` — so testing `isRecord` alone finds
 * a plausible-looking object whose fields are all `undefined`, and every value
 * the section carries is silently dropped. That is the `attempts` bug one
 * level down, and it is exactly how a validated `filters` section arrived at
 * this function producing `{}` while the raw row beside it produced the real
 * filters. Unbox first, then decide; a garbled member degrades to an empty
 * section rather than throwing, so one bad key cannot poison the request.
 */
function readSection(
  section: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const node = section[key];
  const value = isBoxed(node) ? node.get() : node;
  return isRecord(value) ? value : {};
}

/**
 * Read one integer field, refusing anything unusable.
 *
 * Blank means unset: `readField` maps an absent field to `""`, trim makes
 * a whitespace-only one the same `""`, and `Number("")` is `0` — an unset
 * `ttl` would silently become "force a live fetch", the same trap the
 * `normalizeAttempts` comment documents. A
 * non-integer or an out-of-range value is dropped rather than clamped: the
 * schema rejects those before anyone sees them, so a value reaching this
 * path arrived in a raw row unvalidated, and clamping it would apply a
 * setting the user never made.
 *
 * @param key - the config spelling (camelCase).
 * @param min - inclusive lower bound, per the upstream reference.
 * @param max - inclusive upper bound; omitted when upstream states none.
 * @returns the value to forward, or `undefined` when it must not be sent.
 */
function readInteger(
  section: Record<string, unknown>,
  key: string,
  min: number,
  max?: number
): number | undefined {
  const text = readField(section, key).trim();
  if (text === "") return undefined;
  const n = Number(text);
  if (!Number.isInteger(n)) return undefined;
  if (n < min) return undefined;
  if (max !== undefined && n > max) return undefined;
  return n;
}

/**
 * Build the credential lookup for one operation.
 *
 * Two sources, in the harness's own order of trust: the credentials service
 * first, then the launch environment — the snapshot the harness froze at
 * boot, which is what makes a value stable across a `chdir` or a workspace
 * switch mid-session.
 *
 * Both are optional at runtime. A host that has neither still works, because
 * the client falls through to the environment and then the CLI stores.
 */
function credentialLookup(ctx: Context): CredentialResolver | undefined {
  // Every lookup is guarded, because this runs during registration: a missing
  // service must degrade the credential path, not fail the plugin load. A host
  // without either service still works, because the client then falls through
  // to the ambient environment and the CLI stores.
  // Typed by shape rather than by `Context["get"]`, which is `any` — an
  // annotation over that would claim a precision the platform does not offer.
  interface CredentialService {
    resolve: (ref: unknown) => Promise<{ value: string } | undefined>;
  }
  /**
   * A service, or nothing. Checked rather than asserted: `ctx.get` is typed
   * `any` by the platform, so casting it would launder a guess about the host
   * into a guarantee at exactly the point where a wrong guess throws inside a
   * search rather than at registration.
   */
  const isCredentialService = (value: unknown): value is CredentialService => {
    if (!isRecord(value)) return false;
    const member: unknown = Reflect.get(value, "resolve");
    return typeof member === "function";
  };
  let credentials: CredentialService | undefined;
  try {
    const found: unknown = ctx.get("credentials");
    credentials = isCredentialService(found) ? found : undefined;
  } catch {
    credentials = undefined;
  }
  let ambient: ReturnType<typeof launchEnvironmentOf> | undefined;
  try {
    ambient = launchEnvironmentOf(ctx);
  } catch {
    ambient = undefined;
  }
  if (!credentials && !ambient) return undefined;

  return async (ref: string): Promise<string | undefined> => {
    // The service first: it is the layer a user can edit from Settings, so a
    // value there is more deliberate than one that happens to be exported.
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(credentialRef(ref));
      // Three distinct answers, and only the first is one: a missing entry,
      // an entry with nothing behind it, and an entry that names a value. The
      // middle case is why this is not `if (resolved?.value !== "")` — a store
      // holding the ref with a blank value must fall through to the launch
      // environment rather than return the blank as if it were the key.
      const value = resolved?.value;
      if (value !== undefined && value !== "") return value;
    }
    const ambientValue = ambient?.get(ref)?.value;
    return ambientValue === undefined || ambientValue.length === 0
      ? undefined
      : ambientValue;
  };
}

/** Project one resolved section into the options the next operation serves. */
export function resolveOptions(
  config: unknown,
  ctx?: Context,
  env: Record<string, string | undefined> = process.env
): TinyfishProviderOptions {
  const section = isRecord(config) ? config : {};
  const rawFilters = readSection(section, "filters");
  const rawFetch = readSection(section, "fetchOptions");

  // The harness spells these camelCase; TinyFish's API wants snake_case. The
  // translation happens here, once, so the client and the providers stay in
  // the upstream's vocabulary.
  const filters: Record<string, string | number> = {};
  const pick = (key: string, upstream: string): void => {
    // Through `readField`, not `asScalar` directly: a member of a validated
    // section may itself be a boxed node, and the box is read per field.
    const value = readField(rawFilters, key);
    if (value) filters[upstream] = value;
  };
  pick("domainType", "domain_type");
  pick("language", "language");
  pick("location", "location");
  pick("includeDomains", "include_domains");
  pick("excludeDomains", "exclude_domains");

  // The three numeric/date bounds ride as numbers where upstream types them
  // as integers — the monid channel forwards `queryParams` as JSON, and the
  // direct channel stringifies the same map into its query string — so the
  // two channels keep sending the identical payload.
  const pickNumber = (
    key: string,
    upstream: string,
    min: number,
    max?: number
  ): void => {
    const n = readInteger(rawFilters, key, min, max);
    if (n !== undefined) filters[upstream] = n;
  };
  pickNumber("recencyMinutes", "recency_minutes", 1, 5_256_000);
  pickNumber("pubYearMin", "pub_year_min", 0, 9999);

  // A formatted bound, not a number: forwarded verbatim once it is shaped the
  // way upstream documents. The schema enforces the pattern for a validated
  // row; a raw row reaches here unvalidated, and a date-shaped typo must not
  // ride along on every search until upstream rejects it.
  const afterDate = readField(rawFilters, "afterDate");
  if (/^\d{4}-\d{2}-\d{2}$/.test(afterDate)) filters.after_date = afterDate;

  // Fetch body defaults, in the upstream's own field names from here on. The
  // same blank-is-unset and range rules as the filters apply; the group is
  // always present (possibly empty) so the provider can pass it through
  // unconditionally.
  const fetchOptions: TinyfishFetchDefaults = {};
  const ttl = readInteger(rawFetch, "ttl", 0);
  if (ttl !== undefined) fetchOptions.ttl = ttl;
  const perUrlTimeoutMs = readInteger(rawFetch, "perUrlTimeoutMs", 1, 110_000);
  if (perUrlTimeoutMs !== undefined) {
    fetchOptions.per_url_timeout_ms = perUrlTimeoutMs;
  }
  const excludeSelectors = readField(rawFetch, "excludeSelectors");
  if (excludeSelectors !== "") {
    const entries = excludeSelectors
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    // Upstream accepts 1–20 selectors of up to 1000 characters each and 422s
    // outside those limits. A standing default that failed every fetch would
    // take the whole fetch path down with it, so an out-of-range list is
    // dropped as if unset: the mistake stays visible in the row instead of
    // surfacing on every request. Invalid CSS *within* the limits is not
    // checked here — upstream rejects it with the 422 that names the
    // selector, which is a better error than a silent local guess.
    const usable =
      entries.length >= 1 &&
      entries.length <= 20 &&
      entries.every((entry) => entry.length <= 1000);
    if (usable) fetchOptions.exclude_selectors = entries;
  }

  // Environment and credential fallbacks stay here rather than in the
  // provider: every value the provider reads is already fully defaulted by
  // this point, so it never has to decide what "unset" means. Keeping the
  // lookup out also keeps the credential off the provider object entirely.
  const apiKey = readField(section, "apiKey").trim();
  const purpose = readField(section, "purpose").trim();

  // One three-rung shape for all three endpoints: config row, then a
  // package-scoped environment variable, then the built-in default — the same
  // rungs the shipped providers use for `$DEEPSEEK_SEARCH_BASE_URL`, so a
  // deployment can retarget the endpoints without writing a patch file. A
  // value that does not parse is dropped by `available()` rather than trusted,
  // which is what makes accepting one from the environment safe. It used to be
  // spelled out three times, each reading the row once to compare it against
  // `""` and again to use it; one helper keeps the rungs in step and reads
  // each row once.
  const base = (field: string, variable: string, fallback: string): string => {
    // Blank counts as unset on both rungs, the rule the credential rungs
    // already follow. `length > 0` let a whitespace-only row through and `??`
    // accepted an exported-but-empty variable; `URL.canParse` is false for
    // both, so `available()` reported the provider unavailable over a value
    // nobody set — with an error naming neither the row nor the variable, and
    // the built-in default sitting right there.
    const value = readField(section, field).trim();
    if (value.length > 0) return value;
    const fromEnv = env[variable]?.trim();
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : fallback;
  };

  return {
    // Inverted from the obvious form on purpose: anything that is not an
    // explicit `"monid"` is `direct`, so an unset or garbled value takes the
    // same path as the schema default instead of silently preferring the other
    // channel.
    channel: readField(section, "channel") === "monid" ? "monid" : "direct",
    // Blank means "not configured", so the client falls through to the
    // credentials service, the environment, and then the CLI store.
    apiKey: apiKey || undefined,
    apiKeyEnv: readField(section, "apiKeyEnv") || "TINYFISH_API_KEY",
    // A second ref, not a second `apiKey`: the two channels authenticate
    // against different services, so a user who has both keys must be able to
    // save both. The literal `apiKey` above still overrides either channel,
    // which is the operator escape hatch for a patch file.
    monidKeyEnv: readField(section, "monidKeyEnv") || "MONID_API_KEY",
    resolveCredential: ctx ? credentialLookup(ctx) : undefined,
    // The schema refuses an over-long row, so this is defence for a raw
    // one: upstream rejects the whole request past the cap, and this field
    // rides every search and fetch — losing the sentence fails softer than
    // failing every request.
    purpose:
      purpose === "" || purpose.length > PURPOSE_MAX_CHARS
        ? undefined
        : purpose,
    filters,
    fetchOptions,
    // Through `readField` like every other field. `attempts` is the only
    // numeric one, which is exactly why the omission went unnoticed: on a
    // validated section the value is a boxed schema node, `Number(node)` is
    // NaN, and `normalizeAttempts` silently returned the default — so
    // `attempts: 5` in the settings row had no effect at all.
    attempts: normalizeAttempts(readField(section, "attempts")),
    monidBase: base("monidBase", "TINYFISH_MONID_BASE_URL", DEFAULT_MONID_BASE),
    searchBase: base(
      "searchBase",
      "TINYFISH_SEARCH_BASE_URL",
      DEFAULT_SEARCH_BASE
    ),
    fetchBase: base("fetchBase", "TINYFISH_FETCH_BASE_URL", DEFAULT_FETCH_BASE),
    // A switch is off only when it says so. Anything absent or unusable means
    // "on", so a malformed value cannot silently disable a provider — the same
    // rule the channel default follows.
    search: readField(section, "search") !== "false",
    fetch: readField(section, "fetch") !== "false",
  };
}

/**
 * Register both providers with `ctx.web`.
 *
 * Selection stays the profile's call: this plugin only offers `tinyfish`, and
 * `dsh-web`'s `searchProvider` / `fetchProvider` decide whether it is used.
 * Reverting is two words in the patch, with this plugin still mounted.
 */
export function apply(ctx: Context, config?: unknown): void {
  // A thunk, not a value: the settings section can change between searches,
  // and re-registering the provider to carry a new config would make the
  // seam's selection flicker for the user.
  const options = (): TinyfishProviderOptions => resolveOptions(config, ctx);
  ctx.web.registerSearchProvider(new TinyfishSearchProvider(options));
  ctx.web.registerFetchProvider(new TinyfishFetchProvider(options));
}

export {
  DEFAULT_FETCH_BASE,
  DEFAULT_MONID_BASE,
  DEFAULT_SEARCH_BASE,
  WebError,
  WEB_ABORTED,
  WEB_PROVIDER_CREDENTIAL_MISSING,
  WEB_PROVIDER_ERROR,
  resolveApiKey,
  tinyfishFetch,
  tinyfishSearch,
} from "./client.ts";
export {
  TINYFISH_PROVIDER_ID,
  TinyfishFetchProvider,
  TinyfishSearchProvider,
  toIsoDate,
} from "./provider.ts";
export type {
  TinyfishChannel,
  TinyfishFetchDefaults,
  TinyfishFetchPayload,
  TinyfishSearchPayload,
} from "./client.ts";
export type {
  TinyfishOptionsSource,
  TinyfishProviderOptions,
} from "./provider.ts";
