# dsh-tinyfish

[![npm](https://img.shields.io/npm/v/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish)
[![downloads](https://img.shields.io/npm/dm/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish)
[![ci](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-tinyfish.svg)](https://github.com/viztor/dsh-tinyfish/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.14-5FA04E.svg)](https://nodejs.org)

**Search and fetch for the DeepSeek Harness, at $0.**

A DSH bundle that makes [TinyFish](https://tinyfish.ai) the implementation of the harness's own `web_search` and `web_fetch` tools. Both endpoints are free, so the web path on your host stops costing money per call.

|                     | `dsh-web`'s default | with `dsh-tinyfish`                               |
| ------------------- | ------------------- | ------------------------------------------------- |
| search              | `deepseek-official` | TinyFish `/search` via Monid, **$0**              |
| fetch               | `http`              | TinyFish `/fetch`, **$0**, returns clean Markdown |
| turndown conversion | yes, on every fetch | **no** — the content is already Markdown          |
| reversibility       | —                   | two words, no reinstall                           |

## Install

```sh
cd ~/.dsh/profiles/web
npm install dsh-tinyfish
```

Add the bundle to that profile's `package.json`, then restart DSH:

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

That is the whole install. The bundle's own `cordis.patch.yml` selects itself:

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: tinyfish
    fetchProvider: tinyfish
```

Restarting matters: bundles are resolved when the harness boots, so `patchReload` will not pick up a newly mounted one.

**To go back**, set those two back to `deepseek-official` and `http`. The bundle stays mounted and idle — registration and selection are separate, and only your profile decides which provider wins.

**Requirements:** DSH **0.2.0+**, Node **22.14+**, and a credential (below). The harness supplies the `@deepseek-ai/*` peer packages; you do not install them.

## Verify

Ask the agent to search for something. Or check the wiring without an agent:

```sh
cd ~/.dsh/profiles/web
node -e '
  const m = require("dsh-tinyfish");
  const ctx = { web: { registerSearchProvider(){}, registerFetchProvider(){} }, get: () => undefined };
  m.apply(ctx, m.Config({}));
  console.log("registered:", m.name, "| no throw above = wired");
'
```

If search reports `WEB_PROVIDER_CREDENTIAL_MISSING` or `WEB_PROVIDER_UNAVAILABLE`, that is the next section.

## Credentials

A fresh install has none, and never will — a key inside an npm tarball would be published forever. Both endpoints are free, but both need an account.

**In the profile patch (no restart needed).** The `web-tinyfish` row in your profile's `cordis.patch.yml` sets `apiKeyEnv`, which the harness resolves through its credentials service and the launch environment, and re-reads on every call — so a change takes effect on the next search.

**By hand:**

| channel          | get a key                                     | then                                                       |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `direct` default | [tinyfish.ai](https://tinyfish.ai) → API keys | `tinyfish auth login`, or `echo $KEY \| tinyfish auth set` |
| `monid`          | [app.monid.ai](https://app.monid.ai)          | `monid keys add`, or `export MONID_API_KEY`                |

The default is `direct` because the package is named for TinyFish: a fresh install asks for the credential its own name implies rather than for an account at a different service. If you would rather go through Monid — it reuses a platform key a Monid MCP mount already holds, and costs the same — pin it in your own profile patch, which is a host decision and does not need a new release of this plugin:

```yaml
- id: web-tinyfish
  config:
    channel: monid
```

Resolution order, first match wins: a literal `apiKey` in the settings row → the harness credentials service → the launch environment → the live environment → the CLI stores. A failing credential service falls through to the next source rather than failing the search.

## Configuration

Everything lives in one row, `web-tinyfish`, edited in your profile's `cordis.patch.yml`. The row is validated, so an out-of-range value is rejected with a message rather than silently clamped.

> **There is no Settings page for this plugin yet.** The harness renders a settings form only for packages that ship a client UI bundle and contribute a slot to the Plugins page. The shipped DeepSeek provider does; `dsh-tinyfish` does not. The row is edited in the patch file, and nothing about the row is wrong — it is simply not in the GUI.

| key                                          | default            | meaning                                                        |
| -------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `channel`                                    | `direct`           | `monid` or `direct`; see [Credentials](#credentials)           |
| `apiKey`                                     | _(unset)_          | literal credential; prefer `apiKeyEnv`                         |
| `apiKeyEnv`                                  | `TINYFISH_API_KEY` | credential reference, or env var, to resolve                   |
| `purpose`                                    | _(unset)_          | goal statement; TinyFish ranks on it                           |
| `attempts`                                   | `3`                | retries for a transient failure or an empty search (1–5)       |
| `filters.domainType`                         | _(unset)_          | `web` \| `news` \| `research_paper`                            |
| `filters.language` / `.location`             | _(unset)_          | geo targeting                                                  |
| `filters.includeDomains` / `.excludeDomains` | _(unset)_          | comma-separated                                                |
| `monidBase` / `searchBase` / `fetchBase`     | upstream           | endpoint override, for staging                                 |
| `search` / `fetch`                           | `true`             | offer this kind at all; `false` declines without unregistering |

Search and fetch are switched independently. Both always register, so turning one off makes it report _unavailable_ rather than _missing_ — the harness tells those apart, and only the second means "I turned this off" rather than "the install is broken".

```yaml
- id: web-tinyfish
  config:
    search: true
    fetch: false # keep TinyFish for search, let dsh-web use another fetch
```

### Where a value comes from

Every setting resolves in the same three rungs — **row, then environment, then built-in default** — so a deployment can be retargeted without writing a patch file. This is the shape the shipped providers use for `$DEEPSEEK_SEARCH_BASE_URL`.

| setting      | environment variable       |
| ------------ | -------------------------- |
| `monidBase`  | `TINYFISH_MONID_BASE_URL`  |
| `searchBase` | `TINYFISH_SEARCH_BASE_URL` |
| `fetchBase`  | `TINYFISH_FETCH_BASE_URL`  |

An endpoint that does not parse makes the provider report itself unavailable rather than being trusted.

### The credential, in order

Resolved **per call**, so a key rotated anywhere below takes effect on the next search with no restart. First match wins:

| #   | source                  | set it by                                    |
| --- | ----------------------- | -------------------------------------------- |
| 1   | the `apiKey` literal    | the row — a secret in config; prefer 2–3     |
| 2   | the credentials service | the profile's `web-tinyfish` `apiKeyEnv` row |
| 3   | the launch environment  | exported before DSH started                  |
| 4   | the live environment    | `MONID_API_KEY` / `TINYFISH_API_KEY`         |
| 5   | the channel's CLI store | `monid keys add` / `tinyfish auth login`     |

The harness services sit above the environment on purpose: a value someone typed into Settings is a more deliberate choice than one that merely happens to be exported. A failing service falls through to the next source rather than failing the search, and a host that mounts neither still works.

## Why the fetch path is a real improvement

`dsh-tool-web` renders a `kind: "html"` body by running **turndown** to convert HTML to Markdown, behind a depth cap with a `"[HTML content omitted]"` fallback. TinyFish already extracts clean Markdown in a browser-grade extractor, so this provider returns `kind: "text"` and the content reaches the model with no conversion step at all.

## Two channels, one payload

Monid is a thin envelope whose `output` is the direct response verbatim, and it forwards parameter names unchanged. One transport serves both, and nothing above it branches on which is active — a test asserts the two agree on the top hit for the same query.

|        | `direct` (default)           | `monid`                    |
| ------ | ---------------------------- | -------------------------- |
| search | `GET api.search.tinyfish.ai` | `POST api.monid.ai/v1/run` |
| fetch  | `POST api.fetch.tinyfish.ai` | `POST api.monid.ai/v1/run` |
| auth   | `X-API-Key`                  | `Authorization: Bearer`    |
| cost   | $0, direct                   | $0, on the Monid wallet    |

## Behaviour worth knowing

- **A 404 is a result, not an error.** A per-URL fetch failure comes back carrying its status, because that is resource state the model needs.
- **`publishedAt` is honest.** TinyFish reports dates as human strings (`"Apr 30, 2026"`, `"1 year ago"`). What parses is coerced to ISO-8601; what does not is dropped rather than invented. Unzoned dates are read as UTC, so the same page reports the same day regardless of where the Worker ran.
- **Search retries an empty result.** The upstream answers a valid query with nothing about one run in three, so a blank result is retried up to `attempts` before it is believed.
- **A blocked run is terminal.** If a Monid workspace control stops a run, the error says why and links to top up. It is never retried.

## Not included

TinyFish's `agent` and `browser` surfaces are **not** exposed. They cost $0.016/step and $0.002/min, are metered against a wallet, and do not fit `ctx.web` — that seam has exactly two provider kinds, and an agent run is an action, not a search or a fetch. Use the `tinyfish` CLI directly when a page genuinely needs a real browser.

## Development

The toolchain is [Vite+](https://viteplus.dev): `vp pack` builds the library with tsdown, `vp test` runs Vitest, and `vp lint` / `vp fmt` are Oxlint and Oxfmt.

```sh
pnpm install
pnpm test               # 78 hermetic tests — no network, no credential
pnpm run check          # format + lint + types
pnpm run release:gate   # build, then the full gate
pnpm run test:live      # the real APIs, still $0, needs credentials
```

`pnpm run ci` ends in one script, `scripts/check.mjs`, that runs six package checks in a single pass: `lib/` freshness, peer ranges npm can parse, the bundle contract, the harness surfaces still being present, no credentials in the tree, and — the one that earns its keep — packing the tarball, installing it with plain npm, and loading it. Each is proved by planting the regression it guards, and CI runs all of it.

Full process and invariants: [`AGENTS.md`](./AGENTS.md).

## Compatibility

Requires **DSH 0.2.0+**; tested against 0.2.0-rc.1. The `@deepseek-ai/dsh-*` peers are `^0.2.0-rc.1`, so a DSH patch release will not orphan the plugin, and a 0.3 contract change still fails loudly rather than silently.

## License

MIT
