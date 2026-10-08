/**
 * Configuration, specified in one place.
 *
 * Every other test file exercises the code that *uses* the config. Nothing
 * stated what the config *is* — so a field could be added to the schema and
 * never threaded through `resolveOptions`, and it would be silently inert, the
 * same class of defect as the `attempts` bug where a validated row's boxed node
 * read as `NaN` and quietly took the default.
 *
 * Three things are pinned here:
 *
 *   1. **Every schema field has a row** in the table below. The table is checked
 *      against the schema's own key list, so adding a field without deciding its
 *      default and its garbage behaviour fails rather than passing quietly.
 *   2. **The whole credential precedence chain**, one rung at a time, with the
 *      rungs above it disabled. Individual rungs were tested; the order was
 *      not, and the order is the part that decides which key is used.
 *   3. **Layer precedence** — a host patch row overriding the bundle's default
 *      is the thing that makes a preference a preference rather than a release.
 *
 * Hermetic: no network, no credentials, no real store paths.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { afterAll, test } from "vitest";

import {
  resolveApiKey,
  resolveApiKeyAsync,
  type CredentialResolver,
} from "../src/client.ts";
import {
  Config,
  WebError,
  apply,
  resolveOptions,
  type TinyfishFetchProvider,
  type TinyfishProviderOptions,
  type TinyfishSearchProvider,
} from "../src/index.ts";

/* --------------------------------------------------------------- helpers */

const scratch = mkdtempSync(join(tmpdir(), "dsh-config-"));
const store = (name: string, body: string): string => {
  const path = join(scratch, name);
  writeFileSync(path, body);
  return path;
};

const missing = join(scratch, "absent.yaml");
const monidStore = store(
  "monid.yaml",
  "keys:\n  main:\n    key: from_monid_store\n"
);
const tinyfishStore = store(
  "tinyfish.json",
  JSON.stringify({ api_key: "from_tinyfish_store" })
);

/* --------------------------------------------------- 1. the field contract */

/**
 * `default` is what an unset row yields, `junk` what an unusable value yields,
 * and `set` a distinct valid value that must round-trip. The table is checked
 * against the schema's own key list, so a field added to the schema without a
 * row here fails rather than passing quietly.
 */
/**
 * One row of the field contract: the option key under test, the value an
 * unset row yields, a distinct valid value that must round-trip, and the
 * value an unusable value degrades to.
 */
interface FieldFixture {
  name: keyof TinyfishProviderOptions;
  default: unknown;
  set: unknown;
  junk: unknown;
}

const FIELDS: FieldFixture[] = [
  { name: "channel", default: "direct", set: "monid", junk: "direct" },
  {
    name: "apiKeyEnv",
    default: "TINYFISH_API_KEY",
    set: "OTHER_KEY",
    junk: "TINYFISH_API_KEY",
  },
  {
    // The monid channel's own ref, as its own field rather than a second
    // possible value of `apiKeyEnv`, so a user can save both keys at once.
    name: "monidKeyEnv",
    default: "MONID_API_KEY",
    set: "MY_PLATFORM_KEY",
    junk: "MONID_API_KEY",
  },
  // `purpose` is the field that needed the `set` column. Its default and its
  // junk behaviour are both `undefined`, so a `purpose` dropped from the
  // resolver satisfies every other assertion in this test — and a field that is
  // declared but never threaded through is exactly the defect this file exists
  // to catch.
  { name: "purpose", default: undefined, set: "find pricing", junk: undefined },
  { name: "attempts", default: 3, set: 5, junk: 3 },
  { name: "search", default: true, set: false, junk: true },
  { name: "fetch", default: true, set: false, junk: true },
  {
    name: "monidBase",
    default: "https://api.monid.ai",
    set: "https://alt.example",
    junk: "https://api.monid.ai",
  },
  {
    name: "searchBase",
    default: "https://api.search.tinyfish.ai",
    set: "https://alt.example",
    junk: "https://api.search.tinyfish.ai",
  },
  {
    name: "fetchBase",
    default: "https://api.fetch.tinyfish.ai",
    set: "https://alt.example",
    junk: "https://api.fetch.tinyfish.ai",
  },
];

test("every schema field has a stated default and a stated junk behaviour", () => {
  // Driven off the schema itself: `Config({})` is a validated section, and a
  // validated section carries a node for every key the schema declares.
  const validated = Config({});
  const declared = Object.keys(validated).toSorted();

  assert.deepEqual(
    declared.filter(
      (k) => k !== "apiKey" && k !== "filters" && k !== "fetchOptions"
    ),
    FIELDS.map((f) => f.name).toSorted(),
    "the table covers the schema exactly — a new field must be given a default here"
  );

  // The switches are booleans, and their junk case is the interesting one: a
  // schema that yields the string "false" for an unset switch must not read as
  // false, or a malformed row would silently switch a provider off.
  assert.equal(
    resolveOptions({ search: "false" }).search,
    false,
    "an explicit false switches off"
  );
  assert.equal(
    resolveOptions({ search: "" }).search,
    true,
    "blank is not false"
  );
  assert.equal(
    resolveOptions({ search: "no" }).search,
    true,
    "garbage is not false"
  );
  assert.equal(resolveOptions({}).search, true, "and unset is on");
  assert.equal(resolveOptions({ fetch: "false" }).fetch, false);
  assert.equal(resolveOptions({}).fetch, true);

  for (const field of FIELDS) {
    // An empty env, not the ambient one: `monidBase`, `searchBase` and
    // `fetchBase` fall through to `TINYFISH_*_BASE_URL` when the row is
    // silent, so on a machine with those set the "stated default" and
    // "degrades" rows below would be reading the machine, not the code —
    // and passing silently on a host that is configured differently.
    assert.equal(
      resolveOptions(validated, undefined, {})[field.name],
      field.default,
      `${field.name}: an unset row yields the stated default`
    );
    assert.equal(
      resolveOptions({ [field.name]: "" }, undefined, {})[field.name],
      field.junk,
      `${field.name}: an unusable value degrades to the same thing`
    );
    assert.equal(
      resolveOptions({ [field.name]: field.set }, undefined, {})[field.name],
      field.set,
      `${field.name}: an explicit value is honoured, not silently dropped`
    );
  }

  // The one flat member with an upstream length cap. Past it upstream 4xxs
  // the whole request, and this field rides every search and fetch — so the
  // schema refuses a validated row, and a raw one drops the sentence rather
  // than failing every request.
  assert.throws(() => Config({ purpose: "x".repeat(2001) }), /2000/);
  assert.equal(
    resolveOptions({ purpose: "x".repeat(2001) }, undefined, {}).purpose,
    undefined,
    "an over-long purpose degrades to unset instead of failing every request"
  );
});

test("the nested sections have a stated default and a stated junk behaviour", () => {
  // The flat table above cannot see *inside* `filters` and `fetchOptions`, so
  // their members need the same contract it gives top-level fields: unset
  // yields the empty group, an explicit value round-trips in the upstream's
  // spelling, and an unusable value degrades to unset rather than travelling
  // as garbage. The set case runs in both row shapes — a validated row boxes
  // the *section*, and reading members off the box was how every filter was
  // once dropped in silence while the raw row beside it resolved.
  //
  // The junk cases run raw only — but for two different reasons. The
  // out-of-range and mistyped values are rejected by the schema itself, so a
  // validated row carrying them cannot exist (the test below this one pins
  // that rejection); a blank in a plain string member is schema-valid, and
  // only `resolveOptions` drops it. Either way the row never reaches a
  // request as garbage.
  interface NestedFixture {
    label: string;
    section: "filters" | "fetchOptions";
    /** A row carrying exactly this member with a valid value. */
    set: Parameters<typeof Config>[0];
    /** What that row must resolve the section to — the upstream's spelling. */
    expected: Record<string, unknown>;
    /** One unusable variant per entry, as an unvalidated raw row. */
    junk: Record<string, Record<string, unknown>>[];
  }

  const NESTED: NestedFixture[] = [
    {
      label: "filters.domainType",
      section: "filters",
      set: { filters: { domainType: "news" } },
      expected: { domain_type: "news" },
      junk: [{ filters: { domainType: "" } }],
    },
    {
      label: "filters.language",
      section: "filters",
      set: { filters: { language: "fr" } },
      expected: { language: "fr" },
      junk: [{ filters: { language: "" } }],
    },
    {
      label: "filters.location",
      section: "filters",
      set: { filters: { location: "US" } },
      expected: { location: "US" },
      junk: [{ filters: { location: "" } }],
    },
    {
      label: "filters.includeDomains",
      section: "filters",
      set: { filters: { includeDomains: "a.com,b.com" } },
      expected: { include_domains: "a.com,b.com" },
      junk: [{ filters: { includeDomains: "" } }],
    },
    {
      label: "filters.excludeDomains",
      section: "filters",
      set: { filters: { excludeDomains: "c.com" } },
      expected: { exclude_domains: "c.com" },
      junk: [{ filters: { excludeDomains: "" } }],
    },
    {
      // Numeric members differ in what zero means: `recency_minutes: 0` is
      // below the upstream floor of 1 and must be dropped, while
      // `fetchOptions.ttl: 0` is a meaningful setting and must survive — see
      // the fetch case below. One shared "falsy is unset" rule would get
      // either the filters or the cache policy wrong.
      label: "filters.recencyMinutes",
      section: "filters",
      set: { filters: { recencyMinutes: 60 } },
      expected: { recency_minutes: 60 },
      // Three unusable forms: below the floor, fractional, and non-numeric.
      // `readInteger` forwards only in-range integers, so all three degrade
      // to unset instead of reaching upstream as `0`, `60.5`, or `NaN`.
      junk: [
        { filters: { recencyMinutes: 0 } },
        { filters: { recencyMinutes: 60.5 } },
        { filters: { recencyMinutes: "60 minutes" } },
      ],
    },
    {
      label: "filters.afterDate",
      section: "filters",
      set: { filters: { afterDate: "2026-01-01" } },
      expected: { after_date: "2026-01-01" },
      junk: [{ filters: { afterDate: "soon" } }],
    },
    {
      label: "filters.pubYearMin",
      section: "filters",
      set: { filters: { pubYearMin: 2017 } },
      expected: { pub_year_min: 2017 },
      junk: [
        { filters: { pubYearMin: 999_999 } },
        // Whitespace is blank: untrimmed it becomes the floor of `0`, a
        // publication-year bound the operator never set.
        { filters: { pubYearMin: " " } },
      ],
    },
    {
      // The case the falsy rules exist for: `ttl: 0` means "force a live
      // fetch" and must ride as the number zero, while a blank `ttl` means
      // "never set" and must send nothing — `Number("")` is `0`, so without
      // the blank check an unset row would silently force every fetch live.
      label: "fetchOptions.ttl",
      section: "fetchOptions",
      set: { fetchOptions: { ttl: 0 } },
      expected: { ttl: 0 },
      junk: [
        { fetchOptions: { ttl: "" } },
        // Whitespace is blank too: without the trim in `readInteger`,
        // `Number(" ")` is `0` and this row would force every fetch live.
        { fetchOptions: { ttl: " " } },
        { fetchOptions: { ttl: -1 } },
        // `ttl` has no upper bound, so this row is the one where the
        // non-integer guard matters most: without it `Number("soon")` is
        // `NaN`, both comparisons fall through, and the body ships
        // `ttl: NaN` → JSON `null` on every fetch.
        { fetchOptions: { ttl: "soon" } },
      ],
    },
    {
      label: "fetchOptions.perUrlTimeoutMs",
      section: "fetchOptions",
      set: { fetchOptions: { perUrlTimeoutMs: 30_000 } },
      expected: { per_url_timeout_ms: 30_000 },
      junk: [
        { fetchOptions: { perUrlTimeoutMs: 999_999 } },
        // `step(1)` is a schema rule; the raw row has no schema, so the
        // fraction must be dropped here rather than rounded — rounding
        // would apply a budget the user never set.
        { fetchOptions: { perUrlTimeoutMs: 30_000.5 } },
      ],
    },
    {
      // Dropped as a whole set, never trimmed down to fit: an out-of-range
      // selector list is a mistake in the row, and half a list the user never
      // wrote would be worse than none.
      label: "fetchOptions.excludeSelectors",
      section: "fetchOptions",
      set: { fetchOptions: { excludeSelectors: "nav, footer" } },
      expected: { exclude_selectors: ["nav", "footer"] },
      junk: [
        { fetchOptions: { excludeSelectors: " , " } },
        // The length guard, not just the count: 1001 chars is still ONE
        // entry, so the count check passes and only `every(length <= 1000)`
        // can drop it — upstream answers 422 to a selector this long.
        { fetchOptions: { excludeSelectors: "x".repeat(1001) } },
        {
          fetchOptions: {
            excludeSelectors: Array.from(
              { length: 21 },
              (_, i) => `.ad-${i}`
            ).join(","),
          },
        },
      ],
    },
  ];

  // One fixture member per member the schema declares — the nested twin of
  // the flat table's "the table covers the schema exactly". Nested members
  // are filtered out of that guard (a whole section is one top-level key),
  // so a member declared here but threaded nowhere — the `attempts` defect
  // class — would pass every other assertion in this file. The declaration
  // side comes from the schema node itself, not from a validated output:
  // an unset section unboxes to `{}` and cannot enumerate what it leaves out.
  interface ObjectNodeLike {
    dict?: Record<string, unknown>;
  }
  const declaredMembers = (section: "filters" | "fetchOptions"): string[] => {
    const root = Config as unknown as { dict: Record<string, unknown> };
    return Object.keys(
      (root.dict[section] as ObjectNodeLike).dict ?? {}
    ).toSorted();
  };
  for (const section of ["filters", "fetchOptions"] as const) {
    const covered = NESTED.flatMap((fixture) =>
      fixture.section === section
        ? Object.keys(fixture.set?.[section] ?? {})
        : []
    ).toSorted();
    assert.deepEqual(
      covered,
      declaredMembers(section),
      `${section}: one fixture member per schema-declared member`
    );
  }

  assert.deepEqual(
    resolveOptions({}, undefined, {}).filters,
    {},
    "filters: an unset row yields the empty group"
  );
  assert.deepEqual(
    resolveOptions({}, undefined, {}).fetchOptions,
    {},
    "fetchOptions: an unset row yields the empty group"
  );

  for (const fixture of NESTED) {
    assert.deepEqual(
      resolveOptions(fixture.set, undefined, {})[fixture.section],
      fixture.expected,
      `${fixture.label}: an explicit value is honoured, in the upstream's spelling`
    );
    assert.deepEqual(
      resolveOptions(Config(fixture.set), undefined, {})[fixture.section],
      fixture.expected,
      `${fixture.label}: a validated section carries its value too`
    );
    for (const row of fixture.junk) {
      assert.deepEqual(
        resolveOptions(row, undefined, {})[fixture.section],
        {},
        `${fixture.label}: an unusable value degrades to the empty group`
      );
    }
  }
});

test("the schema rejects the nested junk, the other half of the contract", () => {
  // Every junk row above proves `resolveOptions` drops an unusable value from
  // a raw row; this proves the stated ranges are schema-enforced too, the
  // way `attempts` is pinned in `test/plugin.test.ts`. Without it a loosened
  // bound — someone deleting `.max(9999)` — fails no test while the README
  // still advertises the range.
  //
  // Blanks in the plain string members are deliberately absent: the schema
  // accepts those and `resolveOptions` drops them, which is the contract the
  // junk rows above pin. So are the two `excludeSelectors` rows — a long or
  // empty CSV is a well-typed string, and only the length/count checks in
  // `resolveOptions` can drop it.
  // Rows the schema's input type cannot express are the point of the test,
  // so they are untyped here and cast once at the `Config` boundary — the
  // same move `test/plugin.test.ts` makes for the bad channel.
  const rejected: unknown[] = [
    { filters: { domainType: "" } },
    { filters: { recencyMinutes: 0 } },
    { filters: { recencyMinutes: "60 minutes" } },
    { filters: { afterDate: "soon" } },
    { filters: { pubYearMin: 999_999 } },
    { fetchOptions: { ttl: "" } },
    { fetchOptions: { ttl: -1 } },
    { fetchOptions: { ttl: "soon" } },
    { fetchOptions: { perUrlTimeoutMs: 0 } },
    { fetchOptions: { perUrlTimeoutMs: 999_999 } },
    { fetchOptions: { perUrlTimeoutMs: 30_000.5 } },
  ];
  for (const row of rejected) {
    assert.throws(
      () => Config(row as Parameters<typeof Config>[0]),
      JSON.stringify(row)
    );
  }
});

test("a validated row and a raw row resolve identically", () => {
  // The two shapes reach `resolveOptions` from different layers: the harness
  // validates a patch row before the plugin sees it, while a row this plugin
  // never validated arrives raw. They must not disagree about a default.
  // Typed as the schema's own input so each row is checked where it is
  // written; an untyped array would widen to a union the schema rejects.
  const cases: Parameters<typeof Config>[0][] = [
    {},
    { channel: "monid" },
    { attempts: 5 },
    { apiKeyEnv: "X" },
    // Both nested sections at once: the shape that used to disagree, because
    // a validated section boxed its members away from a plain-object read.
    { filters: { domainType: "news", recencyMinutes: 60 } },
    { fetchOptions: { ttl: 0, excludeSelectors: "nav" } },
  ];
  for (const row of cases) {
    const label = JSON.stringify(row);
    assert.deepEqual(
      resolveOptions(Config(row)),
      resolveOptions(row),
      `${label}: validated and raw agree`
    );
  }
});

/* ------------------------------------------ 2. the credential precedence chain */

/**
 * The order, once, as a comment worth having in code:
 *
 *   1. `apiKey` in the row        — a literal, which nothing should use
 *   2. `ctx.credentials`          — what a user typed into Settings
 *   3. the launch environment     — the shell as it was at boot
 *   4. the live environment       — the shell as it is now
 *   5. the channel's CLI store    — `monid keys add` / `tinyfish auth login`
 *
 * The harness services sit above the environment on purpose: a value someone
 * typed into Settings is a more deliberate choice than one that merely happens
 * to be exported. Rungs 2 and 3 are ordered *inside* the resolver closure and
 * are tested in section 2b, where the real order is observable.
 */

test("1. a literal apiKey outranks every other source", async () => {
  const key = await resolveApiKeyAsync("monid", {
    apiKey: "  literal  ",
    env: { MONID_API_KEY: "env" },
    apiKeyEnv: "MY_KEY",
    resolveCredential: async () => "settings",
    credentialsPath: monidStore,
  });
  assert.equal(key, "literal", "trimmed, and nothing below it is consulted");
});

test("the live environment outranks the CLI store", async () => {
  const key = await resolveApiKeyAsync("monid", {
    env: { MONID_API_KEY: "env" },
    resolveCredential: async () => {},
    credentialsPath: monidStore,
  });
  assert.equal(key, "env");
});

test("the CLI store is the last resort, and is per-channel", async () => {
  assert.equal(
    await resolveApiKeyAsync("monid", {
      env: {},
      resolveCredential: async () => {},
      credentialsPath: monidStore,
    }),
    "from_monid_store"
  );
  assert.equal(
    await resolveApiKeyAsync("direct", {
      env: {},
      resolveCredential: async () => {},
      credentialsPath: monidStore,
      tinyfishConfigPath: tinyfishStore,
    }),
    "from_tinyfish_store"
  );
});

test("no source means no key, and no throw", () => {
  for (const channel of ["monid", "direct"] as const) {
    assert.equal(
      resolveApiKey(channel, {
        env: {},
        credentialsPath: missing,
        tinyfishConfigPath: missing,
      }),
      "",
      `${channel}: an absent store is empty, not an exception`
    );
  }
});

test("the two channels never read each other's environment or store", () => {
  // A `monid` key must not satisfy a `direct` request. If it did, a host with
  // only one of the two configured would appear to work and then fail at the
  // first request, which is the expensive kind of wrong.
  assert.equal(
    resolveApiKey("direct", {
      env: { MONID_API_KEY: "m" },
      tinyfishConfigPath: missing,
    }),
    ""
  );
  assert.equal(
    resolveApiKey("monid", {
      env: { TINYFISH_API_KEY: "t" },
      credentialsPath: missing,
    }),
    ""
  );
});

test("MONID_MCP_TOKEN is accepted, so a host's existing Monid mount suffices", () => {
  // The platform key a Monid MCP mount already holds is the same credential.
  // Requiring a second copy of it would make this plugin's credential
  // configuration strictly harder than the MCP server's.
  assert.equal(
    resolveApiKey("monid", {
      env: { MONID_MCP_TOKEN: "mcp" },
      credentialsPath: missing,
    }),
    "mcp"
  );
  assert.equal(
    resolveApiKey("monid", {
      env: { MONID_API_KEY: "primary", MONID_MCP_TOKEN: "mcp" },
      credentialsPath: missing,
    }),
    "primary",
    "MONID_API_KEY is the more specific name and wins"
  );
});

test("an aborted caller never gets a key, even from a service that would answer", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolveApiKeyAsync("monid", {
      env: { MONID_API_KEY: "env" },
      signal: controller.signal,
      apiKeyEnv: "MY_KEY",
      resolveCredential: async () => "settings",
      credentialsPath: monidStore,
    }),
    (error: unknown) =>
      (error instanceof Error && error.name === "AbortError") ||
      (error instanceof WebError && error.code === "WEB_ABORTED"),
    "the guard runs before the resolver is invoked, so a cancelled lookup never starts"
  );
});

/* ---------------------------------------- 2b. the order inside the resolver */

/*
 * Rungs 2 and 3 both live inside the closure `credentialLookup` builds, because
 * the launch environment is a harness service rather than something the client
 * can reach. So the order between them is only observable through the plugin:
 * apply it against a context carrying both services, then read the resolver off
 * the registered provider.
 */

/** Arguments for the harness-context stub; every service is optional. */
interface CtxWithArgs {
  credential?: string;
  ambient?: string;
  withCredentials?: boolean;
  withLaunch?: boolean;
}

/** The slice of `Context` the plugin's `apply` actually touches. */
interface CtxStub {
  get: (name: string) => unknown;
}

/** The slice of `ctx.web` the plugin registers into, plus what was kept. */
interface WebStub {
  registerSearchProvider: (p: TinyfishSearchProvider) => void;
  registerFetchProvider: (p: TinyfishFetchProvider) => void;
  __search?: TinyfishSearchProvider;
  __fetch?: TinyfishFetchProvider;
}

function ctxWith({
  credential,
  ambient,
  withCredentials = true,
  withLaunch = true,
}: CtxWithArgs): CtxStub {
  const services = {
    // `credentialRef(name)` returns the plain string, not a wrapper object — an
    // earlier version of this stub looked for `.name` and matched nothing, which
    // read as the launch environment winning when the service simply never fired.
    credentials: {
      resolve: async (
        ref: string
      ): Promise<{ value: string | undefined } | undefined> =>
        ref === "MY_KEY" ? { value: credential } : undefined,
    },
    launchEnvironment: {
      get: (ref: string): { value: string | undefined } | undefined =>
        ref === "MY_KEY" ? { value: ambient } : undefined,
    },
  };
  return {
    get: (name: string): unknown => {
      if (name === "credentials") {
        if (!withCredentials) throw new Error("service not mounted");
        return services.credentials;
      }
      if (name === "launchEnvironment") {
        if (!withLaunch) throw new Error("service not mounted");
        return services.launchEnvironment;
      }
      throw new Error(`unknown service ${name}`);
    },
  };
}

async function resolverFrom(base: CtxStub): Promise<CredentialResolver> {
  const web: WebStub = {
    registerSearchProvider: (p) => {
      web.__search = p;
    },
    registerFetchProvider: (p) => {
      web.__fetch = p;
    },
  };
  const ctx = {
    get: base.get,
    web,
  };
  const registered: { search?: unknown } = {};
  // A stub, not a `Context`: `as` is the alternative to redeclaring Cordis.
  apply(ctx as unknown as Context, {}); // `apply(ctx, config)` — the seam comes from the context.
  registered.search = ctx.web.__search;
  // `resolveOptions` is private on the provider; read it through a structural
  // cast rather than widening the class for the test.
  const provider = registered.search as
    | { resolveOptions: () => TinyfishProviderOptions }
    | undefined;
  return provider?.resolveOptions().resolveCredential as CredentialResolver;
}

test("2. the credentials service outranks the launch environment", async () => {
  // The layer a user edits from Settings is more deliberate than one frozen at
  // boot, so it is consulted first.
  const resolve = await resolverFrom(
    ctxWith({ credential: "settings", ambient: "boot" })
  );
  assert.equal(await resolve("MY_KEY"), "settings");
});

test("3. the launch environment is used when no credentials service answers", async () => {
  const resolve = await resolverFrom(
    ctxWith({ credential: undefined, ambient: "boot" })
  );
  assert.equal(await resolve("MY_KEY"), "boot");
});

test("a host with neither service still loads, and falls through to the stores", async () => {
  // Registration must not fail because a service is absent — that would make
  // the plugin unloadable on a host that mounts neither.
  const resolve = await resolverFrom(
    ctxWith({ withCredentials: false, withLaunch: false })
  );
  assert.equal(resolve, undefined, "no resolver is offered at all");
  assert.equal(
    resolveApiKey("monid", {
      env: { MONID_API_KEY: "env" },
      credentialsPath: monidStore,
    }),
    "env",
    "so the environment and the CLI store still apply"
  );
});

test("an unknown credential ref yields nothing rather than the wrong key", async () => {
  const resolve = await resolverFrom(
    ctxWith({ credential: "settings", ambient: "boot" })
  );
  assert.equal(await resolve("SOME_OTHER_KEY"), undefined);
});

/* ----------------------------------------------------- 3. layer precedence */

test("a host patch row overrides the bundle default", () => {
  // The bundle ships no `channel`, so the schema default (`direct`) stands. A
  // host that prefers the Monid envelope adds `channel: monid` to its own patch
  // layer, and DSH's precedence makes the host win. That is the whole reason
  // the default is a default and not a pin.
  assert.equal(resolveOptions({}).channel, "direct", "the bundle default");
  assert.equal(
    resolveOptions({ channel: "monid" }).channel,
    "monid",
    "the host override"
  );
  assert.equal(
    resolveOptions(Config({ channel: "monid" })).channel,
    "monid",
    "and it survives schema validation, which is what a patch row goes through"
  );
});

test("a blank endpoint setting is unset, not a value that disables the provider", () => {
  // Invariant 5, which both rungs of the three-rung shape violated: a
  // whitespace-only row passed `length > 0`, and `??` accepted an
  // exported-but-empty variable. `URL.canParse` is false for either, so
  // `available()` answered false and dsh-web raised
  // WEB_PROVIDER_CONFIGURED_UNAVAILABLE for a provider whose default was
  // sitting right there — with an error naming neither the row nor the
  // variable, so the cause was invisible from the message.
  assert.equal(
    resolveOptions({ searchBase: "   " }, undefined, {}).searchBase,
    "https://api.search.tinyfish.ai",
    "a whitespace-only row falls through to the default"
  );
  assert.equal(
    resolveOptions({}, undefined, { TINYFISH_SEARCH_BASE_URL: "" }).searchBase,
    "https://api.search.tinyfish.ai",
    "an exported-but-empty variable falls through to the default"
  );
  assert.equal(
    resolveOptions({ searchBase: "   " }, undefined, {
      TINYFISH_SEARCH_BASE_URL: "https://env.example",
    }).searchBase,
    "https://env.example",
    "and a blank row lets the environment through"
  );
});

test("endpoints resolve config row, then environment, then built-in default", () => {
  // The three-rung shape the shipped providers use for
  // `$DEEPSEEK_SEARCH_BASE_URL`. A deployment can retarget without a patch file.
  assert.equal(
    resolveOptions({}, undefined, {
      TINYFISH_SEARCH_BASE_URL: "https://staging.example",
    }).searchBase,
    "https://staging.example",
    "environment applies when the row is silent"
  );
  assert.equal(
    resolveOptions({ searchBase: "https://row.example" }, undefined, {
      TINYFISH_SEARCH_BASE_URL: "https://env.example",
    }).searchBase,
    "https://row.example",
    "the row outranks the environment"
  );
  assert.equal(
    resolveOptions({}, undefined, {}).searchBase,
    "https://api.search.tinyfish.ai",
    "and the built-in default stands when both are silent"
  );
  // Typed as option keys so the indexing below stays checked; a typo'd
  // field name fails here rather than reading `undefined` at runtime.
  const endpointFields: [keyof TinyfishProviderOptions, string][] = [
    ["monidBase", "TINYFISH_MONID_BASE_URL"],
    ["searchBase", "TINYFISH_SEARCH_BASE_URL"],
    ["fetchBase", "TINYFISH_FETCH_BASE_URL"],
  ];
  for (const [field, variable] of endpointFields) {
    assert.equal(
      resolveOptions({}, undefined, { [variable]: "https://env.example" })[
        field
      ],
      "https://env.example",
      `${variable} retargets ${field}`
    );
  }
});

// Cleanup has to be a hook, not top-level code: a bare call here runs at
// *import*, before any test, so it deleted the stores the tests read. That is
// what the unused-import warning was pointing at — the cleanup was missing — and
// putting it back in the wrong place broke the suite instead of fixing it.
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
