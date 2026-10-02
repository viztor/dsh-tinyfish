import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import z from "@deepseek-ai/schemastery";

import type { CredentialResolver } from "./client.ts";
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
    .volatile()
    .description("Goal statement; TinyFish ranks on it."),
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
    })
    .description("Search filters applied to every query.")
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
 * This does NOT have to equal the manifest `name`: `dsh-opencode` ships as
 * `@viztor/dsh-opencode` while exporting `dsh-opencode`, and mounts fine.
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
  const rawFilters = isRecord(section.filters) ? section.filters : {};

  // The harness spells these camelCase; TinyFish's API wants snake_case. The
  // translation happens here, once, so the client and the providers stay in
  // the upstream's vocabulary.
  const filters: Record<string, string> = {};
  const pick = (key: string, upstream: string): void => {
    const value = asScalar(rawFilters[key]);
    if (value) filters[upstream] = value;
  };
  pick("domainType", "domain_type");
  pick("language", "language");
  pick("location", "location");
  pick("includeDomains", "include_domains");
  pick("excludeDomains", "exclude_domains");

  // Environment and credential fallbacks stay here rather than in the
  // provider: every value the provider reads is already fully defaulted by
  // this point, so it never has to decide what "unset" means. Keeping the
  // lookup out also keeps the credential off the provider object entirely.
  const apiKey = readField(section, "apiKey").trim();
  const purpose = readField(section, "purpose").trim();

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
    purpose: purpose || undefined,
    filters,
    // Through `readField` like every other field. `attempts` is the only
    // numeric one, which is exactly why the omission went unnoticed: on a
    // validated section the value is a boxed schema node, `Number(node)` is
    // NaN, and `normalizeAttempts` silently returned the default — so
    // `attempts: 5` in the settings row had no effect at all.
    attempts: normalizeAttempts(readField(section, "attempts")),
    // Config row, then a package-scoped environment variable, then the built-in
    // default — the same three-rung shape the shipped providers use for
    // `$DEEPSEEK_SEARCH_BASE_URL`, so a deployment can retarget the endpoints
    // without writing a patch file. A value that does not parse is dropped by
    // `available()` rather than trusted, which is what makes accepting one from
    // the environment safe.
    monidBase:
      readField(section, "monidBase").length > 0
        ? readField(section, "monidBase")
        : (env.TINYFISH_MONID_BASE_URL ?? DEFAULT_MONID_BASE),
    searchBase:
      readField(section, "searchBase").length > 0
        ? readField(section, "searchBase")
        : (env.TINYFISH_SEARCH_BASE_URL ?? DEFAULT_SEARCH_BASE),
    fetchBase:
      readField(section, "fetchBase").length > 0
        ? readField(section, "fetchBase")
        : (env.TINYFISH_FETCH_BASE_URL ?? DEFAULT_FETCH_BASE),
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
  TinyfishFetchPayload,
  TinyfishSearchPayload,
} from "./client.ts";
export type {
  TinyfishOptionsSource,
  TinyfishProviderOptions,
} from "./provider.ts";
