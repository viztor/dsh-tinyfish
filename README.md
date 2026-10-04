<div align="center">
  <img src="icon.svg" alt="TinyFish logo" width="120" />
  <h1>dsh-tinyfish</h1>
  <p><strong>Free web search and fetch for the DeepSeek Harness.</strong><br />Give your agent the live web — at $0 per call.</p>

[![npm](https://img.shields.io/npm/v/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish) [![downloads](https://img.shields.io/npm/dm/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish) [![ci](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/dsh-tinyfish.svg)](https://github.com/viztor/dsh-tinyfish/blob/main/LICENSE)

</div>

---

Your agent can already reason. This gives it something to reason _about_: live search results and clean page content, wired straight into the harness's own `web_search` and `web_fetch` tools. Powered by [TinyFish](https://agent.tinyfish.ai/sign-up?ref=v1.dXNlcl8zSnh2TDJGaldOV2FQYWhnaDRqbTIzc0dqZTE.KxSdeNUG14oJKVFVFWLkOwn3-Pia7QI5BuaxiJ_iEVY) — both endpoints are free, so the web path on your host stops costing money per call.

| Before | After |
| --- | --- |
| Search bills per call | **$0**, forever |
| Fetched pages arrive as HTML, converted clumsily | **Clean Markdown**, straight from a browser-grade extractor |
| Switching providers means reinstalling | **Two words** in a config file, no reinstall |

## 🚀 Quick start

### Method 1: Direct from Web UI (Recommended)

DeepSeek Harness allows installing plugins directly through the Web interface without touching a terminal:

1. Open DSH Web → **Settings → Plugins** (设置 → 插件).
2. Click **Install Plugin** (添加插件).
3. Search or enter `dsh-tinyfish` (or `@viztor/dsh-tinyfish`).
4. Click **Install** — DSH automatically fetches the package from npm, builds the bundle patch, and activates it live without restarting!
5. In **Settings → Plugins → TinyFish**, select your channel (`direct` or `monid`), enter the key for that channel, and hit **Save**!
6. That is the whole install — the bundle points the web path at TinyFish on both kinds. See [Select it](#-select-it) to choose otherwise.

---

### Method 2: Terminal / Profile `package.json`

For headless environments, servers, or version-controlled dotfiles:

```sh
cd ~/.dsh/profiles/web
npm install dsh-tinyfish   # or: npm install @viztor/dsh-tinyfish — same thing
```

Pick **one** name and install it once. Both tarballs carry byte-identical code and read the same settings (providers register as `tinyfish`, configuration lives under the row id `dsh-tinyfish`, credentials under the same two refs) — so switching names later loses nothing, but mounting both loads the bundle twice. `dsh-tinyfish` is the name DSH convention and these docs use.

<details>
<summary><strong>📦 Installing from GitHub Packages instead</strong></summary>

<br />

Every release mirrors `@viztor/dsh-tinyfish` to GitHub Packages — a second source if npmjs.org is unreachable, and what populates the repository sidebar. Only the scoped name mirrors: GitHub links packages to repositories by owner scope. Unlike npmjs, GitHub Packages requires authentication even for public packages: an unauthenticated request 404s without saying whether the package exists. With a token carrying `read:packages`:

```ini
# project-local .npmrc is better than global for a token
@viztor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx
```

then `npm install @viztor/dsh-tinyfish` resolves from the mirror. Unless npmjs is down, prefer it: no token, no extra configuration.
</details>

**Mount it** — add to that profile's `package.json`, then restart DSH:

```jsonc
{
  "dependencies": { "dsh-tinyfish": "^0.5.0" },
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

**Add a key** — pick a channel below, save the key, and ask your agent to search for something.

### Select it

**The bundle selects TinyFish on both web kinds by default**, so a fresh install works with no patch editing. It does that by setting the web seam's `searchProvider` / `fetchProvider`, matched by row id. That is the only route a plugin has: `dsh-web` resolves those two fields once in its constructor and exposes no API by which a provider could elect itself.

To choose differently, override it in the profile's `cordis.patch.yml`, which applies after every bundle patch and therefore wins:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

The two kinds are independent fields, so search can run through TinyFish while fetch stays on the shipped `http` provider, or the other way round. The plugin stays mounted and idle either way. A host can also set `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` instead — those feed the same fields, with the config value winning when both are present.

## 🔑 Two channels, one plugin

|  | Direct _(default)_ | Via Monid |
| --- | --- | --- |
| What's behind it | TinyFish's own API | The same TinyFish endpoints, through your Monid wallet |
| You need | A free key from [tinyfish.ai](https://agent.tinyfish.ai/sign-up?ref=v1.dXNlcl8zSnh2TDJGaldOV2FQYWhnaDRqbTIzc0dqZTE.KxSdeNUG14oJKVFVFWLkOwn3-Pia7QI5BuaxiJ_iEVY) | A platform key from [app.monid.ai](https://app.monid.ai) |
| Fastest setup | `tinyfish auth login` | `monid keys add` |
| Costs | $0 | $0 |

The default is `direct`, because the package is named for TinyFish — a fresh install asks for the credential its own name implies. Prefer Monid (it reuses a platform key your Monid MCP mount may already hold)? Pin it in your profile patch:

```yaml
- id: dsh-tinyfish
  config:
    channel: monid
```

Both keys can live side by side — saving one never overwrites the other, and switching channels loses nothing.

## ⚙️ Settings page

**Settings → Plugins → TinyFish.** Everything editable lives here: whether TinyFish answers search and fetch, the channel picker, your keys, what the search ranks on, and retries. Changes stage and save together; a key you type is stored by the harness, never in your profile.

Both key fields are on the page at once, each labelled with the service it authenticates and each hint naming the reference the save lands on — so you can set the Monid key while Direct is selected, and tell which of the two exists without switching back and forth.

> This row configures how TinyFish behaves; it does not select it. Pointing `searchProvider`/`fetchProvider` at `tinyfish` is a separate step in your profile patch — see [Select it](#-select-it). Reverting is the same two words in reverse.

<details>
<summary><strong>📖 Full configuration reference</strong></summary>

<br />

Everything lives in one row, `dsh-tinyfish`. The row is validated, so an out-of-range value is rejected with a message rather than silently clamped.

| key | default | meaning |
| --- | --- | --- |
| `channel` | `direct` | `monid` or `direct` |
| `apiKey` | _(unset)_ | literal credential for either channel; prefer a ref |
| `apiKeyEnv` | `TINYFISH_API_KEY` | credential reference, or env var, for `direct` |
| `monidKeyEnv` | `MONID_API_KEY` | credential reference, or env var, for `monid` |
| `purpose` | _(unset)_ | goal statement sent with every search and fetch; TinyFish ranks on it; capped at 2000 characters |
| `attempts` | `3` | retries for a transient failure or an empty search (1–5) |
| `filters.domainType` | _(unset)_ | `web` \| `news` \| `research_paper` — patch file only |
| `filters.language` / `.location` | _(unset)_ | geo targeting — patch file only |
| `filters.includeDomains` / `.excludeDomains` | _(unset)_ | comma-separated — patch file only |
| `filters.recencyMinutes` | _(unset)_ | freshness window in minutes (1–5256000); mutually exclusive with `.afterDate` upstream — patch file only |
| `filters.afterDate` | _(unset)_ | lower date bound, `YYYY-MM-DD`; not for `research_paper` — patch file only |
| `filters.pubYearMin` | _(unset)_ | lower publication-year bound (0–9999), `research_paper` only — patch file only |
| `fetchOptions.ttl` | _(unset)_ | cache tolerance in seconds; `0` forces a live fetch, unset accepts any cache — patch file only |
| `fetchOptions.perUrlTimeoutMs` | _(unset)_ | per-URL wall-clock budget in ms (1–110000) — patch file only |
| `fetchOptions.excludeSelectors` | _(unset)_ | comma-separated CSS selectors pruned before extraction (1–20 × ≤1000 chars); direct PDF/CSV downloads reject it — patch file only |
| `monidBase` / `searchBase` / `fetchBase` | upstream | endpoint override, for staging |
| `search` / `fetch` | `true` | provide this kind; `false` reports it unavailable without unregistering |

Turning one off reports _unavailable_ rather than _missing_ — the harness tells those apart, and only the second means "the install is broken". But _unavailable_ is not a silent fall-through: if `searchProvider`/`fetchProvider` still names TinyFish, the call fails. Point that tool at another provider to use one.

#### Manifest metadata, not configuration

The manifest also carries `dsh.compatibility`: the Node and DSH ranges stated explicitly, plus a per-release verdict — `compatible`, `incompatible`, or `unknown` — for the DSH versions a catalog checks.

**DSH itself never reads it.** Neither `compatibility` nor `dshReleases` appears anywhere in the harness, so these fields cannot change how the plugin loads, registers, or behaves. They exist so a listing can state what has actually been verified, and the verdicts here are honest rather than aspirational: `0.2.0-rc.2` is what every build and test in this repository runs against, `0.2.0-rc.1` is admitted by the peer range but never exercised, and `0.1.7-rc.2` sits below that floor.

```yaml
- id: dsh-tinyfish
  config:
    search: true
    fetch: false # TinyFish stays registered but unavailable for fetch; point fetchProvider elsewhere to use another fetch
```

### Filters and fetch options live in the patch file

`filters` and `fetchOptions` are nested objects, and the settings form addresses one flat key per field — so search and fetch tuning stays operator-level:

```yaml
- id: dsh-tinyfish
  config:
    channel: monid
    filters:
      domainType: research_paper
      language: zh
      includeDomains: arxiv.org,openreview.net
      pubYearMin: 2023
    fetchOptions:
      ttl: 0 # force a live fetch instead of accepting a cached page
      excludeSelectors: nav, .cookie-banner
```

Both sections always resolve: an unset one is an empty group that adds nothing to the request, and an unusable member degrades to unset rather than travelling upstream. Three upstream caveats pass through as documented behaviour instead of being enforced — `recencyMinutes` and `afterDate` are mutually exclusive in TinyFish's API (a row setting both sends both), `excludeSelectors` cannot apply to direct PDF/CSV downloads, which answer `selector_unsupported` while it is set, and each date bound is cross-checked against `domainType`: `recencyMinutes` and `afterDate` are refused for `research_paper`, `pubYearMin` exists only for it, and either wrong pairing rejects the whole search while set.

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
- **Off means _unavailable_, not gone.** A switched-off kind stays registered and declines. If the profile still pins that tool to Tinyfish, the call fails loudly instead of silently rerouting — point the tool at another provider to use one. With nothing pinned, a withdrawn Tinyfish simply yields: auto-select picks whoever is left, and switching one kind off is how you resolve an "ambiguous provider" standoff down to a single candidate.
- **_Unavailable_ has three causes and one message.** The seam only sees a boolean, so "switched off", "no credential", and "bad base URL" all read the same downstream. The card can tell them apart — check the switches, the key badges, and the endpoint overrides there.
- **`purpose` is one sentence for every request.** The seam's requests carry no goal slot — `{query}` for search, `{url}` for fetch — so a per-call goal is impossible without a harness change. The configured sentence rides every search and fetch verbatim: a standing bias, not a per-task instruction.

TinyFish's `agent` and `browser` surfaces are **not** exposed: metered, wallet-billed, and not a search or a fetch. Use the `tinyfish` CLI directly when a page genuinely needs a real browser.

</details>

<details>
<summary><strong>🛠 Development</strong></summary>

<br />

The toolchain is [Vite+](https://viteplus.dev): `vp pack` builds with tsdown, `vp test` runs Vitest, `vp lint` / `vp fmt` are Oxlint and Oxfmt, type-aware. Lint and format live in `vite.config.ts` — Vite+ ignores standalone configs.

```sh
pnpm install
pnpm test               # hermetic — no network, no credential
pnpm run check          # format + lint + types
pnpm run release:gate   # build, then the full gate incl. 18 package checks
pnpm run test:live      # the real APIs, still $0, needs credentials
```

Requires **DSH `^0.2.0-rc.1`** (0.2.0-rc.1 and later, below 0.3.0) and **Node 24+**. Full process and invariants: [`AGENTS.md`](./AGENTS.md). Contributing: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

</details>

## License

MIT
