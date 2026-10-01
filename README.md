<div align="center">
  <img src="assets/tinyfish.svg" alt="TinyFish logo" width="120" />
  <h1>dsh-tinyfish</h1>
  <p><strong>Free web search and fetch for the DeepSeek Harness.</strong><br />Give your agent the live web — at $0 per call.</p>

[![npm](https://img.shields.io/npm/v/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish) [![downloads](https://img.shields.io/npm/dm/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish) [![ci](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/dsh-tinyfish.svg)](https://github.com/viztor/dsh-tinyfish/blob/main/LICENSE)

</div>

---

Your agent can already reason. This gives it something to reason _about_: live search results and clean page content, wired straight into the harness's own `web_search` and `web_fetch` tools. Powered by [TinyFish](https://tinyfish.ai) — both endpoints are free, so the web path on your host stops costing money per call.

| Before | After |
| --- | --- |
| Search bills per call | **$0**, forever |
| Fetched pages arrive as HTML, converted clumsily | **Clean Markdown**, straight from a browser-grade extractor |
| Switching providers means reinstalling | **Two words** in a config file, no reinstall |

## 🚀 Quick start

**1. Install** — in your web profile:

```sh
cd ~/.dsh/profiles/web
npm install dsh-tinyfish   # or: npm install @viztor/dsh-tinyfish — same thing
```

<details>
<summary><strong>📦 Installing from GitHub Packages instead</strong></summary>

<br />

Every release mirrors both names to GitHub Packages — a second source if npmjs.org is unreachable, and what populates the repository sidebar. Unlike npmjs, GitHub Packages requires authentication even for public packages: an unauthenticated request 404s without saying whether the package exists. With a token carrying `read:packages`:

```ini
# project-local .npmrc is better than global for a token
@viztor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx
```

then `npm install @viztor/dsh-tinyfish` resolves from the mirror. Unless npmjs is down, prefer it: no token, no extra configuration.
</details>

**2. Mount it** — add to that profile's `package.json`, then restart DSH:

```jsonc
{
  "dependencies": { "dsh-tinyfish": "^0.3.0" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-tinyfish",
      ],
    },
  },
}
```

> Bundles resolve at boot, so a restart picks it up — reloading the patch alone won't.

**3. Add a key** — pick a channel below, save the key, and ask your agent to search for something. That's the whole install.

## 🔑 Two channels, one plugin

|  | Direct _(default)_ | Via Monid |
| --- | --- | --- |
| What's behind it | TinyFish's own API | The same TinyFish endpoints, through your Monid wallet |
| You need | A free key from [tinyfish.ai](https://tinyfish.ai) | A platform key from [app.monid.ai](https://app.monid.ai) |
| Fastest setup | `tinyfish auth login` | `monid keys add` |
| Costs | $0 | $0 |

The default is `direct`, because the package is named for TinyFish — a fresh install asks for the credential its own name implies. Prefer Monid (it reuses a platform key your Monid MCP mount may already hold)? Pin it in your profile patch:

```yaml
- id: web-tinyfish
  config:
    channel: monid
```

Both keys can live side by side — saving one never overwrites the other, and switching channels loses nothing.

## ⚙️ Settings page

**Settings → Plugins → TinyFish.** Everything editable lives here: the channel picker, your keys, what the search ranks on, retries, and the search/fetch toggles. Changes stage and save together; a key you type is stored by the harness, never in your profile.

The page shows the key for the **selected** channel, plus the saved-or-not status of both — so you always know where you stand without switching back and forth.

> Going back is two words: set `searchProvider`/`fetchProvider` to `deepseek-official` and `http`. The bundle stays mounted and idle.

<details>
<summary><strong>📖 Full configuration reference</strong></summary>

<br />

Everything lives in one row, `web-tinyfish`. The row is validated, so an out-of-range value is rejected with a message rather than silently clamped.

| key | default | meaning |
| --- | --- | --- |
| `channel` | `direct` | `monid` or `direct` |
| `apiKey` | _(unset)_ | literal credential for either channel; prefer a ref |
| `apiKeyEnv` | `TINYFISH_API_KEY` | credential reference, or env var, for `direct` |
| `monidKeyEnv` | `MONID_API_KEY` | credential reference, or env var, for `monid` |
| `purpose` | _(unset)_ | goal statement; TinyFish ranks on it |
| `attempts` | `3` | retries for a transient failure or an empty search (1–5) |
| `filters.domainType` | _(unset)_ | `web` \| `news` \| `research_paper` — patch file only |
| `filters.language` / `.location` | _(unset)_ | geo targeting — patch file only |
| `filters.includeDomains` / `.excludeDomains` | _(unset)_ | comma-separated — patch file only |
| `monidBase` / `searchBase` / `fetchBase` | upstream | endpoint override, for staging |
| `search` / `fetch` | `true` | offer this kind at all; `false` declines without unregistering |

Turning one off reports _unavailable_ rather than _missing_ — the harness tells those apart, and only the second means "the install is broken".

```yaml
- id: web-tinyfish
  config:
    search: true
    fetch: false # keep TinyFish for search, let dsh-web use another fetch
```

### Filters live in the patch file

`filters` is a nested object, and the settings form addresses one flat key per field — so search tuning stays operator-level:

```yaml
- id: web-tinyfish
  config:
    channel: monid
    filters:
      domainType: research_paper
      language: zh
      includeDomains: arxiv.org,openreview.net
```

### Where a credential comes from

Resolved **per call** — a rotated key takes effect on the next search, no restart. First match wins:

1. the `apiKey` literal in the row (a secret in config; prefer 2–3)
2. the credentials service — `apiKeyEnv` (direct) or `monidKeyEnv` (monid), saved from the settings UI
3. the launch environment (exported before DSH started)
4. the live environment (`MONID_API_KEY` / `TINYFISH_API_KEY`)
5. the channel's CLI store (`monid keys add` / `tinyfish auth login`)

A failing service falls through to the next source rather than failing the search.

### Where an endpoint comes from

Row, then environment, then built-in default — so staging can retarget without a patch:

| setting      | environment variable       |
| ------------ | -------------------------- |
| `monidBase`  | `TINYFISH_MONID_BASE_URL`  |
| `searchBase` | `TINYFISH_SEARCH_BASE_URL` |
| `fetchBase`  | `TINYFISH_FETCH_BASE_URL`  |

</details>

<details>
<summary><strong>🔍 Behaviour worth knowing</strong></summary>

<br />

- **A 404 is a result, not an error.** A per-URL fetch failure comes back carrying its status, because that is resource state the model needs.
- **`publishedAt` is honest.** TinyFish reports human dates (`"Apr 30, 2026"`, `"1 year ago"`). What parses becomes ISO-8601; what doesn't is dropped, never invented. Unzoned dates read as UTC, so the same page reports the same day everywhere.
- **Empty searches retry.** The upstream answers a valid query with nothing about one run in three — a blank result is retried up to `attempts` before it is believed.
- **A blocked run is terminal.** If a Monid workspace control stops a run, the error says why and links to top up. Never retried.

TinyFish's `agent` and `browser` surfaces are **not** exposed: metered, wallet-billed, and not a search or a fetch. Use the `tinyfish` CLI directly when a page genuinely needs a real browser.

</details>

<details>
<summary><strong>🛠 Development</strong></summary>

<br />

The toolchain is [Vite+](https://viteplus.dev): `vp pack` builds with tsdown, `vp test` runs Vitest, `vp lint` / `vp fmt` are Oxlint and Oxfmt, type-aware. Lint and format live in `vite.config.ts` — Vite+ ignores standalone configs.

```sh
pnpm install
pnpm test               # 143 hermetic tests — no network, no credential
pnpm run check          # format + lint + types
pnpm run release:gate   # build, then the full gate incl. 11 package checks
pnpm run test:live      # the real APIs, still $0, needs credentials
```

Requires **DSH 0.2.0+** and **Node 22.14+**. Full process and invariants: [`AGENTS.md`](./AGENTS.md). Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

</details>

## License

MIT
