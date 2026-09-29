# dsh-tinyfish

TinyFish-backed **search** and **fetch** for the DeepSeek Harness web capability seam (`ctx.web`).

Registers TinyFish as the implementation of the harness's own `web_search` and `web_fetch`. Both endpoints are **$0**, so the default web path costs nothing — no paid SERP mirror, no per-call metering.

---

## Requirements

|              |                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------- |
| DSH          | **0.2.0 or later** — the loader refuses a plugin whose peers do not match the runtime     |
| Node         | 22.14+ (the harness supplies the `@deepseek-ai/*` peer packages; you do not install them) |
| A credential | one of two free accounts — see [Credentials](#credentials)                                |

## Install

```sh
cd ~/.dsh/profiles/web
npm install dsh-tinyfish
```

Then add the bundle to that profile's `package.json`:

```jsonc
{
  "dependencies": { "dsh-tinyfish": "^0.2.0" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-tinyfish"],
    },
  },
}
```

`pnpm add link:../../../dev/dsh-tinyfish` works the same way if you are installing from a local checkout.

**Restart DSH.** Bundles are resolved when the harness boots, not on reload — `patchReload` covers a patch change, not a new bundle.

The bundle's own `cordis.patch.yml` selects it, so there is nothing else to configure for the switch itself:

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: tinyfish
    fetchProvider: tinyfish
```

**To go back**, set those two back to `deepseek-official` and `http`. The plugin stays mounted and idle — registration and selection are separate, and only the profile decides which provider wins.

## Verify

Ask the agent to search. A working install returns results from TinyFish with no `WEB_PROVIDER_CREDENTIAL_MISSING` and no `WEB_PROVIDER_UNAVAILABLE`.

To check the wiring without an agent:

```sh
cd ~/.dsh/profiles/web
node -e '
  const m = require("dsh-tinyfish");
  const ctx = { web: { registerSearchProvider(){}, registerFetchProvider(){} }, get: () => undefined };
  m.apply(ctx, m.Config({}));
  console.log("registered:", m.name, "| Config ok |", "no throw above = wired");
'
```

If the provider is unavailable, it means no credential resolved — the next section covers that.

## Credentials

**A fresh install has no credential.** The package ships none, by design: a key inside an npm tarball would be published forever. Both endpoints are free, but both need an account.

### The quick way — in the harness

**Settings → Plugins → web-tinyfish** → set `apiKeyEnv` to a name you have already stored, or paste a key into `apiKey`. The field is a _credential reference_: the harness credentials service stores and rotates it, and the provider picks up a change on the next search with no restart.

### By hand

| channel             | get a key                                       | then                                            |
| ------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `monid` _(default)_ | sign up at [app.monid.ai](https://app.monid.ai) | `monid keys add`, or `export MONID_API_KEY`     |
| `direct`            | [tinyfish.ai](https://tinyfish.ai) → API keys   | `tinyfish auth login` (saves it), or `echo $KEY | tinyfish auth set` for CI |

With no credential the provider reports `WEB_PROVIDER_CREDENTIAL_MISSING` and names the command to run — a distinct code from a provider failure, so the two are never confused.

Resolution order, first match wins:

1. a literal `apiKey` in the row
2. the harness **credentials service**, by the `apiKeyEnv` reference — so a key can be rotated or supplied from Settings without editing a patch file
3. the harness **launch environment** (the snapshot frozen at boot)
4. `MONID_API_KEY` / `MONID_MCP_TOKEN` / `TINYFISH_API_KEY` from the live environment
5. the CLI stores named above

A failing credentials service falls through to the next source rather than failing the search.

---

## Why this exists

`ctx.web` is a provider registry. `dsh-web` picks a search provider and a fetch provider **by name**, and any package implementing `WebSearchProvider` or `WebFetchProvider` can supply one. This package supplies both.

### Fetch is a strict improvement on the default provider

`dsh-tool-web` renders a `kind: "html"` body by running **turndown** to convert HTML to Markdown, behind a depth cap with a `"[HTML content omitted]"` fallback. TinyFish already extracts clean Markdown in a browser-grade extractor, so this provider returns `kind: "text"` and the content reaches the model with no conversion step at all.

---

**Reverting is two words** — change them back to `deepseek-official` and `http`. The plugin stays mounted and idle.

## Channels

TinyFish is reachable two ways, and the payload is the same either way: Monid is a thin envelope whose `output` _is_ the direct response, and it forwards parameter names unchanged. One transport serves both; nothing above it branches.

|            | `monid` (default)                  | `direct`                     |
| ---------- | ---------------------------------- | ---------------------------- |
| search     | `POST api.monid.ai/v1/run`         | `GET api.search.tinyfish.ai` |
| fetch      | `POST api.monid.ai/v1/run`         | `POST api.fetch.tinyfish.ai` |
| auth       | `Authorization: Bearer`            | `X-API-Key`                  |
| credential | `~/.config/monid/credentials.yaml` | `~/.tinyfish/config.json`    |
| cost       | $0, on the Monid wallet            | $0, direct                   |

Both stores are the ones the CLIs already write, so the package holds no secret of its own. Stores are re-read per call — caching would pin a rotated key inside a long-lived host process.

Get a credential with `monid login`, or `tinyfish auth login --source openclaw`.

---

## Configuration

Set on the `web-tinyfish` row in your patch:

The row is validated by a `@deepseek-ai/schemastery` schema, so an out-of-range value is **rejected with a message** rather than silently clamped, and the row renders as a real settings section in the harness instead of free-form YAML.

| key                                         | default            | meaning                                                                     |
| ------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `channel`                                   | `monid`            | `monid` or `direct`                                                         |
| `apiKey`                                    | _(unset)_          | literal credential. Prefer `apiKeyEnv` — a patch file is read on every boot |
| `apiKeyEnv`                                 | `TINYFISH_API_KEY` | stored credential or env var to resolve                                     |
| `purpose`                                   | _(unset)_          | goal statement; TinyFish ranks on it                                        |
| `attempts`                                  | `3`                | retries for a transient failure or an empty search (1–5)                    |
| `filters.domainType`                        | _(unset)_          | `web` \| `news` \| `research_paper`                                         |
| `filters.language` / `filters.location`     | _(unset)_          | geo targeting                                                               |
| `filters.includeDomains` / `excludeDomains` | _(unset)_          | comma-separated                                                             |
| `monidBase` / `searchBase` / `fetchBase`    | upstream defaults  | override for staging                                                        |

## Behaviour worth knowing

**Search** maps `results[]` to citeable sources: `url`, `title`, `snippet`, and `publishedAt` when the date parses. TinyFish reports dates as human strings (`"Apr 30, 2026"`, `"1 year ago"`), and unzoned values are read as **UTC**, not local midnight — otherwise the same page would report a different day depending on where the Worker ran. Values that do not parse are dropped rather than emitted malformed.

**Fetch** returns `kind: "text"` with the extracted Markdown. A per-URL failure comes back as a _result_ carrying its status, not a thrown error: a 404 is resource state the model needs.

### Reliability

Two upstream behaviours are handled because both are observed in practice:

- **`/search` intermittently returns zero results** for a valid query, about one run in three. A completed run with no results is retried up to `attempts` before being believed, so a genuinely empty result is meaningful.
- **Monid reports rate limiting as a `COMPLETED` run** with `output: null` and a `SERVICE_BUSY` / 5xx `providerResponse`. That is retried. A `BLOCKED` run never is — it means a workspace control stopped it, and the error surfaces the reason plus a top-up link.
- Monid sits behind Cloudflare, which 403s the default `curl`/undici user-agent; every request carries a browser UA.

### Out of scope

TinyFish's `agent` and `browser` surfaces are **not** exposed. They cost $0.016/step and $0.002/min, are metered against a wallet, and do not fit `ctx.web` — that seam has exactly two provider kinds, and an agent run is an action, not a search or a fetch. Use the `tinyfish` CLI directly when a page genuinely needs a real browser.

---

## Development

TypeScript 7, strict. The toolchain is [Vite+](https://viteplus.dev) (`vp`): `vp pack` builds the library with tsdown, `vp test` runs Vitest, and `vp lint`/`vp fmt` are Oxlint and Oxfmt reading the tiered rules in `oxlint.config.ts`. The tests still run against `src/` directly, so the normal edit-test loop needs no build step.

```sh
pnpm install            # prepare builds lib/ for the harness
pnpm test               # hermetic unit suite — no network, ~300ms
pnpm run test:live      # real TinyFish + Monid ($0, needs credentials)
pnpm run build          # vp pack -> lib/ (one .mjs + one .d.mts)
pnpm run build:check    # lib/ matches a fresh build of src/
pnpm run typecheck      # tsc --noEmit
pnpm run lint           # vp lint — Oxlint, type-aware (Ultracite presets)
pnpm run format         # vp fmt --check
pnpm run pack:check     # bundle contract, credential scan, tarball budget
pnpm run ci             # everything CI runs
pnpm run release:gate   # build, then ci
```

| path                      | role                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `src/client.ts`           | two-channel transport, retry policy, credential resolution      |
| `src/provider.ts`         | the `WebSearchProvider` / `WebFetchProvider` pair               |
| `src/index.ts`            | cordis `apply` / `inject` / `name`, and config normalisation    |
| `cordis.patch.yml`        | the bundle patch that offers the provider and selects it        |
| `test/`                   | `vp test` suites; `integration/` is the gated, credentialed one |
| `scripts/pack-check.mjs`  | publish validator                                               |
| `scripts/build-check.mjs` | proves `lib/` is not stale                                      |
| `vite.config.ts`          | the `pack` (library build) and `test` blocks                    |
| `vite.live.config.ts`     | the credentialed live suite, run separately                     |
| `oxlint.config.ts`        | lint tiers read by `vp lint`: gates fail, debt warns, style off |
| `AGENTS.md`               | invariants and process — read before changing `src/`            |

`lib/` is gitignored and generated, so it can never be a committed stale copy — but that means it can silently lag `src/`, which the tests would not notice. `build:check` rebuilds into a scratch directory and diffs it, so the artifact DSH loads is provably the one this source produces.

Types are generated from the source, so there is no hand-written declaration file to drift. The single runtime dependency is the harness's own schemastery fork: the public package compiles but lacks `.role()`, `.volatile()` and `.get()`, which is what makes the settings row and the credential ref work. CI runs the full gate on every push and publishes to npm from a `v*` tag with OIDC provenance.

## Runtime compatibility

Requires **DSH 0.2.0 or later**; tested against 0.2.0-rc.1.

The `@deepseek-ai/dsh-*` peers are `^0.2.0-rc.1`. Two failures bracket that choice, and both are now guarded by a check:

- **Too tight** — an exact pin turns every DSH prerelease into a plugin the loader refuses, with a per-machine `dsh plugin allow-version` exemption as the only remedy. That is not something a consumer should have to run.
- **Unparseable** — `workspace:^` satisfies DSH's loader and is the obvious next answer, but it is a pnpm/yarn protocol, so `npm install` answers `EUNSUPPORTEDPROTOCOL`. The package was, briefly, uninstallable. That is worse than needing a range bump on a DSH minor release, which is a ten-second edit and is what dependabot and `contract:check` exist for.

Because a range cannot follow DSH by itself, drift is caught explicitly: `pnpm run contract:check` asserts every harness surface this package depends on still exists with the shape the code assumes, and `pnpm run install:check` proves the packed tarball still installs and loads under plain npm. Both run in CI.

## Release

```sh
pnpm run release:gate              # build, then the full gate
git tag v0.2.0 && git push origin v0.2.0
```

The publish runs from CI on the tag, with provenance, after re-checking that the tag matches `package.json`. Authentication is either npm trusted publishing (OIDC, no stored secret) or an npm **automation** token in the `NPM_TOKEN` secret — an automation token specifically, because a web-login session stops at a one-time-password prompt that CI cannot answer.

## License

MIT
