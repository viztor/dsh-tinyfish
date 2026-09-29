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

/** Settings namespace, matching the `<kind>-<provider>` convention. */
export const WEB_TINYFISH_SETTINGS_NAMESPACE = "web-tinyfish";

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
    .default("monid")
    .description(
      "Which upstream route to use. `monid` reuses the MCP credential."
    ),
  apiKey: z
    .string()
    .role("secret")
    .volatile()
    .description(
      "Literal credential. Prefer a credential ref or the environment."
    ),
  apiKeyEnv: z
    .string()
    .role("credential-ref")
    .default("TINYFISH_API_KEY")
    .volatile()
    .description("Stored credential or environment variable to read."),
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
});

/** Cordis service dependencies. */
export const inject = ["web"];

/** The bundle name. Must equal the manifest `name`: the loader matches on it. */
export const name = "dsh-tinyfish";

/** Clamp `attempts` to a range the retry loop can honour. */
function normalizeAttempts(value: unknown): number {
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
  const value = section[key] as { get?: () => unknown } | undefined;
  return asScalar(typeof value?.get === "function" ? value.get() : value);
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
  let credentials: CredentialService | undefined;
  try {
    credentials = ctx.get("credentials") as CredentialService | undefined;
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
    if (credentials) {
      const resolved = await credentials.resolve(credentialRef(ref));
      if (resolved?.value) return resolved.value;
    }
    const value = ambient?.get(ref)?.value;
    return value && value.length > 0 ? value : undefined;
  };
}

/** Project one resolved section into the options the next operation serves. */
export function resolveOptions(
  config: unknown,
  ctx?: Context
): TinyfishProviderOptions {
  const section = (config ?? {}) as Record<string, unknown>;
  const rawFilters = (section.filters ?? {}) as Record<string, unknown>;

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
    channel: readField(section, "channel") === "direct" ? "direct" : "monid",
    // Blank means "not configured", so the client falls through to the
    // credentials service, the environment, and then the CLI store.
    apiKey: apiKey || undefined,
    apiKeyEnv: readField(section, "apiKeyEnv") || "TINYFISH_API_KEY",
    resolveCredential: ctx ? credentialLookup(ctx) : undefined,
    purpose: purpose || undefined,
    filters,
    attempts: normalizeAttempts(section.attempts),
    monidBase: readField(section, "monidBase") || DEFAULT_MONID_BASE,
    searchBase: readField(section, "searchBase") || DEFAULT_SEARCH_BASE,
    fetchBase: readField(section, "fetchBase") || DEFAULT_FETCH_BASE,
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
