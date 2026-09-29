# Agent notes for `dsh-tinyfish`

## Project identity

- Local source: `~/dev/dsh-tinyfish` · npm package: **`dsh-tinyfish`** (unscoped) · GitHub: `viztor/dsh-tinyfish`
  `scripts/check.mjs` enforces both against the _built_ entry.
- **Registering a provider is not selecting it.** This plugin only _offers_ `tinyfish`; `dsh-web`'s `searchProvider` / `fetchProvider` decide. Reverting is two words in the profile — change them back to `deepseek-official` / `http` and the plugin stays mounted and idle. Do not "fix" selection by editing the plugin.

## Stack

| concern   | tool                                                | why this one                                                          |
| --------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| toolchain | **Vite+** (`vp`)                                    | one entry point over Vite, Rolldown, Vitest, tsdown, Oxlint and Oxfmt |
| language  | TypeScript 7, `strict` + `noUncheckedIndexedAccess` | the seam's types are the contract; JS gave them up                    |
| build     | `vp pack` (tsdown) → `lib/`                         | a **library** build, not an app build; the harness resolves `main`    |
| tests     | `vp test` (Vitest 5)                                | the same 70 tests, with watch and V8 coverage built in                |
| lint      | `vp lint` — Oxlint, **type-aware**, Ultracite       | the `typescript/*` gates are real defect classes                      |
| format    | `vp fmt` — Oxfmt                                    | same preset family as the linter, same tiered rules                   |

Lint and format both follow the three tiers in `~/.grok/rules/lint-format-oxc-ultracite.md`. `oxlint.config.ts` keeps **gates at `error`**, accepted debt at `warn`, and style at `off` — no gate has been demoted to greenwash a build. Every `warn` there is a candidate to promote, not a permanent exemption.

### The `.ts` import extension is deliberate

Source imports carry the real `.ts` extension and `tsconfig` sets `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`. That combination is what lets the tests import `src/` directly and run under Node's type stripping — **the tests exercise the source, with no build in the loop.** Importing `lib/` instead would test a build the gate has to remember to produce first.

The tests still import `src/` directly rather than `lib/`, so the build is out of the edit-test loop. `vp pack` is a bundler, which adds a property worth knowing: a source change that is **not reachable from the entry** is tree-shaken out and therefore does not make `lib/` stale. That is correct — such a change genuinely does not alter the artifact DSH loads — but it means the freshness check is a timestamp comparison rather than a rebuild, and it is proved against a change that reaches the bundle, not a comment.

## What this is

TinyFish backs the harness's native `web_search` and `web_fetch`. Both endpoints are **$0**, which is the point: the default web path on this host costs nothing.

| channel            | search                       | fetch                        | auth                    | credential store                   |
| ------------------ | ---------------------------- | ---------------------------- | ----------------------- | ---------------------------------- |
| `direct` (default) | `GET api.search.tinyfish.ai` | `POST api.fetch.tinyfish.ai` | `X-API-Key`             | `~/.tinyfish/config.json`          |
| `monid`            | `POST api.monid.ai/v1/run`   | same                         | `Authorization: Bearer` | `~/.config/monid/credentials.yaml` |
| `direct`           | `GET api.search.tinyfish.ai` | `POST api.fetch.tinyfish.ai` | `X-API-Key`             | `~/.tinyfish/config.json`          |

**The two channels return the same payload.** Monid is a thin envelope whose `output` is TinyFish's response verbatim, and it forwards parameter names unchanged. That is why one transport serves both and nothing above it branches — a test asserts the top hit matches across channels. If that stops being true, `test/integration/live.test.mjs` fails first.

## What the harness taught us

The reference implementation for this seam is the shipped `@deepseek-ai/dsh-web-search-deepseek`. It is worth reading before changing anything here, and four of its decisions were initially wrong on this side:

| adopted                                            | why                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WebError`, not a private error class              | a package that invents its own codes is invisible to `dsh-tool-web`, which puts the code in structured error metadata  |
| `@deepseek-ai/schemastery`, not the public one     | the public 3.18.x line has no `.role()`/`.volatile()`/`.get()`; the fork is what makes the settings row a real section |
| `role("credential-ref")` + the credentials service | a key is then rotatable from Settings, not only from a patch file                                                      |
| `redirect: "error"` on every request               | a provider configured for one endpoint should not silently follow it elsewhere                                         |

Two conventions from the same package that are now house style here: exports carry `"./src/*"`, and JSDoc uses `@param x -` with a hyphen.

**On Effect: deliberately absent.** Effect appears in **zero** of the 516 packages in the harness dependency tree. Cordis has its own `Effect` type, and it means something unrelated — a disposer, or an iterable of disposers, for plugin lifecycle. It is not a functional-effects runtime and brings none of that machinery. Adding it here would be a foreign runtime dependency for a plugin with two providers and no concurrency to model. If a future change needs structured concurrency, the harness's own primitive is `ctx.effect()`.

## Releasing

Publishing is a tag, not a local command. The publish job only runs on a `v*` tag, and it re-checks that the tag matches `package.json` first — a tag and a manifest that disagree means a consumer cannot tell which version they installed.

```sh
pnpm install            # prepare runs vp pack, so lib/ exists for the harness
pnpm run build          # vp pack -> lib/ (one .mjs + one .d.mts)
pnpm run check          # vp check: format + lint + types in one pass
pnpm test               # vp test — hermetic, no network, no credential
pnpm run test:live      # real TinyFish + Monid, $0, needs credentials
pnpm run lint           # vp lint  — Oxlint, type-aware
pnpm run format         # vp fmt --check
pnpm run ci             # check + test + the six package checks below
pnpm run ci             # check + test + the four build/runtime checks
pnpm run release:gate   # build, then ci
```

### Getting the publish to authenticate

A plain `npm publish` from a web-login session stops at **EOTP** — a one-time-password prompt, with the URL only ever printed to stdout. That is why publishing is done from CI instead. Two routes, both already supported by the workflow:

| route                  | setup                                                                                                       | note                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Automation token**   | npmjs.com → Access Tokens → Generate → type **Automation**, then `gh secret set NPM_TOKEN`                  | one command, works immediately. An automation token does not trigger EOTP — that prompt is specific to web-login sessions |
| **Trusted publishing** | npmjs.com → package → Trusted Publisher → GitHub Actions → allow this workflow and the `npm publish` action | no secret at all; npm detects the OIDC environment and uses it in preference to a token                                   |

Trusted publishing is the better end state — nothing to store, nothing to rotate, nothing to leak. The token route is the one that works today without any npmjs.com configuration. The workflow supports both, because the CLI prefers OIDC and only falls back to `NODE_AUTH_TOKEN` when it is set.

### Version discipline

`version` in `package.json` is the source of truth; the tag is derived from it. Follow semver for this package:

- **patch** — a fix with no contract change
- **minor** — a new config key, provider behaviour, or harness surface
- **major** — a change to what a config row means, or to the error codes the seam routes on

Every version bump goes with the gate passing, because the harness-surface check inside `scripts/check.mjs` is what will tell you a harness upgrade landed underneath the code.

## Runtime compatibility

DSH ships prereleases often — 0.1.7-rc.2 became 0.2.0-rc.1 — and the loader refuses to load a plugin whose `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peers do not satisfy the running version. It checks those prefixes and nothing else, so `@deepseek-ai/cordis` can stay exactly pinned.

A checked peer must be a **range npm can parse**: `^0.2.0-rc.1`, not an exact version and not a workspace protocol. Both wrong answers have shipped here, and both are now guarded. An **exact pin** orphaned the plugin the moment DSH shipped 0.2.0; the only remedy was a per-machine `dsh plugin allow-version` exemption, which is not something a consumer should have to run. `workspace:^` fixes the loader and is the obvious next guess — it means "the current runtime" — but it is a pnpm/yarn protocol, so `npm install` answered `EUNSUPPORTEDPROTOCOL` and the package was, briefly, **uninstallable**. That is worse than needing a range bump on a DSH minor release.

That choice gives up _automatic_ detection of a genuine break, so detection is bought back explicitly:

- The **harness-surface check** asserts, against the installed runtime, that every surface `src/` imports or implements still exists: both provider interfaces, the result shapes, `WebError`, the `text` arm of `WebFetchBody`, `credentialRef`, `credentials.resolve`, and `launchEnvironmentOf`. Each failure names what moved rather than reporting a bare mismatch.
- The **peer-range check** rejects both wrong shapes — a range npm cannot parse, and an exact pin. DSH reports a version mismatch loudly at boot on its own, so re-deriving its verdict here bought nothing; npm's inability to parse a `workspace:` protocol is the part DSH cannot tell you about.
- The **install check** packs the tarball and installs it with **plain npm** into a scratch project, then loads it and drives the plugin surface. Every other check runs against the working tree; this is the only one that exercises what a consumer actually receives, and it is the check that found `workspace:^`.

The checks are proved, not assumed. Every one of the six is fired by planting what it guards: renaming `WebFetchBody`'s `text` arm fails the surface check, re-pinning a peer fails the range check, `workspace:^` fails both that and the install check, a planted key fails the scanner, and deleting `dsh.bundle.patch` fails the bundle check. A check that cannot fail is not a check.

When DSH moves, the work is: `pnpm add -D` the new `@deepseek-ai/dsh-*` versions, run `release:gate`, and read what the contract check says. If it passes, nothing in `src/` needs to change.

## Safety

- **Never read, log, echo, or commit a credential.** The package holds no secret of its own by design: each channel reads the store its CLI already writes. `scripts/check.mjs` scans the tree for key-shaped strings and self-tests its own patterns, so a scanner that silently stopped working cannot pass.
- **`apiKey` belongs in the environment, never in a patch file.** The plugin's config accepts one for a test or a staging host, but a `cordis.patch.yml` is read on every boot.
- **Retries spend money only on the metered surfaces.** Search and fetch are $0, so a blind retry is safe here and would not be on `agent` ($0.016/step) or `browser` ($0.002/min). Do not add an `agent_config` without checking entitlement — `max_steps` is beta-gated and answers 403.
- **A `BLOCKED` run is terminal.** It means a workspace control stopped it (budget or run cap). Surface the reason and the top-up link; never retry it.
- Do not tidy unrelated infrastructure from this repo. It ships one thing.

## TDD

- `pnpm test` is hermetic and free: 57 unit tests, no network, ~300ms. `fetch` is stubbed per test through `test/helpers.mjs`; add a case there rather than reaching the real API.
- `pnpm run test:live` talks to both real APIs and is a **separate Vitest config** (`vite.live.config.ts`), not a flag on the default run. An inline `projects` entry looked like the tidier answer and was not: it inherited the parent's `include` and re-ran all 70 unit tests under a second name. It is still skipped without `DSH_TINYFISH_LIVE=1`, and it still costs $0, so run it before a release — but never make a gate of it that blocks an offline machine.
- Unit tests pin behaviour a stub cannot prove: retry boundaries, `BLOCKED` being terminal, blank-credential fallthrough, `publishedAt` coercion.
- Prefer a failing test that names the defect over editing an assertion to match new behaviour. The suite has already caught `requireKey` swallowing the credential, `active_key` never being honoured, and unzoned dates parsing as local midnight.
- The tests are `.mjs` on purpose. `src/` is type-checked and lint-gated type-aware; making the tests TypeScript would add a second surface to keep in sync for no extra safety, and the fleet's script override already accounts for untyped test code. Assertions stayed on `node:assert` through the Vitest migration on purpose: changing the runner and the assertion library in one commit means a red suite could be either, and neither would be knowable.

## Invariants worth defending

Load-bearing and cheap to break. Each has a test.

1. **The seam owns truncation and error codes.** Providers return `truncated: false` and never pre-truncate to `maxResults`.
2. **A per-URL fetch failure is a result, not a throw.** A 404 is resource state the model needs; only a genuine transport failure is a `TinyfishError`.
3. **Fetch returns `kind: "text"`.** TinyFish already extracts Markdown, so `dsh-tool-web` passes it through. Returning `html` would reintroduce a turndown conversion for nothing.
   The package check asserts a Config is exported.
4. **Credential stores are re-read per call, never cached at module load.** Caching pins a rotated key inside a long-lived host process.
5. **Blank means unconfigured.** A whitespace `apiKey` must fall through to the environment, not travel as a credential-shaped nothing.
6. **`erasableSyntaxOnly` stays on.** It is what keeps the source runnable under Node's type stripping, which is what removes the build from the test loop. A parameter property or an enum in `src/` breaks the tests immediately — that is the guard, not an accident.

## Commands

```sh
pnpm install            # prepare runs vp pack, so lib/ exists for the harness
pnpm run build          # vp pack -> lib/ (one .mjs + one .d.mts)
pnpm run check          # vp check: format + lint + types in one pass
pnpm test               # vp test — hermetic, no network, no credential
pnpm run test:live      # real TinyFish + Monid, $0, needs credentials
pnpm run lint           # vp lint  — Oxlint, type-aware
pnpm run format         # vp fmt --check
pnpm run ci             # vp check + vp test + the package checks
```

Run `release:gate` before every commit that touches `src/`, `cordis.patch.yml`, or `package.json`. `ci` is what CI runs and what a pre-push hook should run.

## Credentials

Resolution order, first match wins:

1. a literal `apiKey` in the settings row
2. the harness **credentials service**, by the `apiKeyEnv` reference
3. the harness **launch environment** — the snapshot frozen at boot, which is what keeps a value stable across a `chdir` or a workspace switch
4. `MONID_API_KEY` / `MONID_MCP_TOKEN` / `TINYFISH_API_KEY` from the live env
5. the CLI stores — `~/.config/monid/credentials.yaml`, `~/.tinyfish/config.json`

Both harness services are **peers, not dependencies**, pinned to the exact harness version. That is deliberate: a private copy would be a second service instance with its own store, and the user changing a key in Settings would never be seen. `apply` builds the lookup from `ctx.get("credentials")` and `launchEnvironmentOf(ctx)`; both are optional at runtime and both lookups are guarded, because a missing service must degrade the credential path rather than fail plugin registration.

A **failing** credentials service falls through rather than failing the search; the CLI stores are a working fallback. An **aborted** caller does not — the guard runs _before_ the resolver is invoked, so a cancelled lookup never starts and never leaks an unhandled rejection.

`available()` must stay synchronous: the seam calls it to choose between providers, so a network call there would turn selection into a latency spike on every search. That is why `resolveApiKeyAsync` is a separate entry point, for the credential lookup only.

## The build and `lib/`

`lib/` is gitignored, so nobody can commit a stale copy — but that means it can silently fall behind `src/`, which is invisible because the tests read `src/` and only the harness would ever see the old artifact. The package check closes that with a timestamp comparison: `lib/` older than `src/` is a failure. It is deliberately not a rebuild-and-diff, because every flow it runs in has already rebuilt — comparing against that would be comparing a build to itself, which is how the previous 118-line version managed to be both elaborate and incapable of failing.

The scratch directory has to sit inside the project at the same depth as `lib/`. TypeScript writes a source map's `sources` relative to the output directory, so building to `/tmp` makes every map differ for a reason that has nothing to do with staleness.

## Changing the config surface

`src/index.ts` holds the only normalisation: `channel` and `attempts` are clamped, filters are translated from the harness's camelCase to the upstream's snake_case, and `apiKey` / `purpose` are trimmed. Adding a filter means touching `resolveOptions` **and** `test/plugin.test.mjs` in the same change — the translation is the contract, not an implementation detail.

Validated sections hand back **boxed schema nodes**, not plain values, and not uniformly: a `union` of consts resolves to a bare value while a `default(...).volatile()` field stays a node. `readField` in `src/index.ts` handles both and refuses to stringify an object — a typo'd key must not become `"[object Object]"` in a request.

The schema **rejects** out-of-range values rather than clamping, which is better: a silently clamped `attempts: 99` looks applied and is not. The clamp in `resolveOptions` is defence for a raw row that reached it unvalidated.

## Docs

`README.md` is the public API reference and the npm landing page. Types are generated from `src/` — there is no hand-written `.d.ts` to fall out of sync, which was the whole point of the conversion.
