<p align="right">
  <a href="README.md">English</a> | <strong>简体中文</strong> | <a href="README.ja.md">日本語</a>
</p>

<div align="center">
  <img src="icon.svg" alt="TinyFish logo" width="120" />
  <h1>dsh-tinyfish</h1>
  <p><strong>为 DeepSeek Harness 提供免费的网页搜索与抓取。</strong><br />让你的 agent 连上实时网络——每次调用只要 $0。</p>

[![npm](https://img.shields.io/npm/v/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish) [![downloads](https://img.shields.io/npm/dm/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish) [![ci](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/dsh-tinyfish.svg)](https://github.com/viztor/dsh-tinyfish/blob/main/LICENSE)

</div>

---

你的 agent 早就学会了推理，现在给它一点可供推理的“材料”：实时搜索结果与干净的页面正文，直连 harness 自带的 `web_search` 与 `web_fetch` 工具。由 [TinyFish](https://agent.tinyfish.ai/sign-up?ref=v1.dXNlcl8zSnh2TDJGaldOV2FQYWhnaDRqbTIzc0dqZTE.KxSdeNUG14oJKVFVFWLkOwn3-Pia7QI5BuaxiJ_iEVY) 驱动——两个端点都免费，你主机上的网络链路从此不再按次计费。

| 之前 | 之后 |
| --- | --- |
| 每次搜索调用都要计费 | **$0**，永久免费 |
| 抓回来的页面是 HTML，转换得磕磕绊绊 | **干净的 Markdown**，来自浏览器级提取器，开箱即用 |
| 换提供方就要重装 | 改配置文件的**两个单词**即可，不用重装 |
| 每个提供方要么接受你的原样查询，要么什么都不接受 | **常驻默认值**——域名、语言、时效、日期上下界、缓存 TTL、选择器 |

## 📊 方案对比

| 适用场景 | 解决方案 | 费用 |
| --- | --- | --- |
| 在原生工具里免费搜索与抓取 | **dsh-tinyfish**，任一通道 | **$0**——直连通道用 TinyFish 密钥，Monid 通道用平台密钥；两种载荷完全一致 |
| 官方默认 | `deepseek-official` + `http` | 按次计费；抓回的 HTML 还要再付一道 turndown 转换 |
| 需要提供方特有的 SERP 细节（地理、流量、排名）或批量查询 | 经 `monid_run` 调用的 Monid SERP 镜像 | 每次 $0.03–$0.12——只在任务真需要这些细节时用 |
| `fetch` 读不了的页面（重 JS、需登录、要交互） | CLI 里的 `tinyfish agent` / `browser` | 按量计费（$0.016/step，$0.002/min）——只在抓取落空后果断升级 |

## 🚀 快速上手

### 方法一：从 Web 界面直接安装（推荐）

DeepSeek Harness 支持直接在 Web 界面安装插件，全程不用碰终端：

1. 打开 DSH Web → **Settings → Plugins**（设置 → 插件）。
2. 点击 **Install Plugin**（添加插件）。
3. 搜索或输入 `dsh-tinyfish`（或 `@viztor/dsh-tinyfish`）。
4. 点击 **Install**（安装）——DSH 会自动从 npm 拉取软件包、构建 bundle 补丁并实时激活，无需重启！
5. 在 **Settings → Plugins → TinyFish**（设置 → 插件 → TinyFish）中选择通道（`direct` 或 `monid`），填入密钥——两个都填也行——然后点击 **Save**（保存）！
6. 安装到此结束——bundle 已把两条网络链路都指向 TinyFish。若想另行选择，参见[选择提供方](#select-it)。
7. 问 agent 一个时效性问题；工具调用应以 `tinyfish` 名义返回。

---

### 方法二：终端 / Profile 的 `package.json`

适用于无头环境、服务器或纳入版本管理的 dotfiles：

```sh
cd ~/.dsh/profiles/web
npm install dsh-tinyfish   # or: npm install @viztor/dsh-tinyfish — same thing
```

认准**一个**名字装一次。两个 tarball 的代码逐字节一致，读取同一份设置（提供方注册为 `tinyfish`，配置挂在行 id `dsh-tinyfish` 下，凭证共用同一对引用）——所以之后改名不丢任何东西，但两个都挂会把 bundle 加载两遍。`dsh-tinyfish` 是 DSH 约定用的名字，本文档也用它。

<details>
<summary><strong>📦 改从 GitHub Packages 安装</strong></summary>

<br />

每次发版都会把 `@viztor/dsh-tinyfish` 镜像到 GitHub Packages——npmjs.org 连不上时的第二来源，也是仓库侧边栏的数据来源。只有带作用域的名字会镜像：GitHub 按所有者作用域把软件包关联到仓库。与 npmjs 不同，GitHub Packages 连公开包也要认证：未认证的请求会 404，且不告诉你这个包是否存在。用带有 `read:packages` 权限的 token：

```ini
# project-local .npmrc is better than global for a token
@viztor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx
```

之后 `npm install @viztor/dsh-tinyfish` 就会从镜像解析。除非 npmjs 宕机，一律优先用它：不用 token，也不用额外配置。
</details>

**挂载它**——加进该 profile 的 `package.json`，然后重启 DSH：

```jsonc
{
  "dependencies": { "dsh-tinyfish": "^0.11.0" },
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

> 经 `package.json` 安装的 bundle 在启动时解析，所以这里要重启 DSH——只重载补丁加载不了它们。

**配一把密钥**——从下面的通道里选一个存好，然后问 agent 一个时效性问题（_who won the last Formula 1 race?_）。工具调用应以 `tinyfish` 名义返回；这个名字本身就是证明：该行已校验通过、凭证已解析、profile 也确实指向了这个提供方。

### 选择提供方

**默认 bundle 会把两条网络链路都指向 TinyFish**，所以全新安装不用改任何补丁就能跑。它通过设置网络 seam 的 `searchProvider` / `fetchProvider` 实现，按行 id 匹配。插件只有这一条路：`dsh-web` 在构造时一次性解析这两个字段，没有给提供方可“自荐”的 API。

若想另行选择，在 profile 的 `cordis.patch.yml` 里覆盖，它在每个 bundle 补丁之后生效，因此优先级最高：

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

搜索和抓取是两个独立字段，所以搜索走 TinyFish、抓取留在官方 `http` 提供方可以，反过来也行。插件保持挂载、静默待命。主机也可以改设 `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER`——它们喂给同一对字段，两边都设时以配置文件为准。

## 🔑 双通道，一个插件

| 特性 | 直连 _(默认)_ | 经 Monid |
| --- | --- | --- |
| 背后是什么 | TinyFish 官方 API | 同样的 TinyFish 端点，经你的 Monid 钱包转发 |
| 需要什么 | [tinyfish.ai](https://agent.tinyfish.ai/sign-up?ref=v1.dXNlcl8zSnh2TDJGaldOV2FQYWhnaDRqbTIzc0dqZTE.KxSdeNUG14oJKVFVFWLkOwn3-Pia7QI5BuaxiJ_iEVY) 的免费密钥 | [app.monid.ai](https://app.monid.ai) 的平台密钥 |
| 最快配法 | `tinyfish auth login` | `monid keys add` |
| 花费 | $0 | $0 |

默认是 `direct`，因为包名就叫 TinyFish——全新安装索取的正是名字里那个凭证。更想用 Monid（你的 Monid MCP 挂载可能已经有一把平台密钥）？在 profile 补丁里钉死：

```yaml
- id: dsh-tinyfish
  config:
    channel: monid
```

两把密钥可以并存——存一个永远不会覆盖另一个，切换通道也不丢任何东西。

## ⚙️ 设置页

**Settings → Plugins → TinyFish**（设置 → 插件 → TinyFish）。所有可编辑项都在这里：TinyFish 是否回答搜索与抓取、通道选择、密钥、搜索排序依据和重试。改动先暂存、一起保存；你输入的密钥由 harness 保管，绝不写入 profile。

两个密钥框同时摆在页面上，各自标明所鉴权的服务，提示里写清保存落到哪个引用——于是可以在 Direct 选中时配 Monid 密钥，不用来回切换也能看清两个密钥各是否存在。

> 这一行只管 TinyFish 的行为，不管选中它。把 `searchProvider`/`fetchProvider` 指向 `tinyfish` 是 profile 补丁里的另一步——参见[选择提供方](#select-it)。改回去也是同样两个单词的事。

<details>
<summary><strong>📖 完整配置参考</strong></summary>

<br />

全都住在同一行 `dsh-tinyfish` 里。该行带校验，越界值会被带着报错信息拒绝，而不是悄悄钳制。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `channel` | `direct` | `monid` 或 `direct` |
| `apiKey` | _(未设置)_ | 两个通道通用的字面凭证；优先用引用 |
| `apiKeyEnv` | `TINYFISH_API_KEY` | `direct` 的凭证引用或环境变量 |
| `monidKeyEnv` | `MONID_API_KEY` | `monid` 的凭证引用或环境变量 |
| `purpose` | _(未设置)_ | 随每次搜索与抓取发送的目标说明；TinyFish 据此排序；最多 2000 个字符 |
| `attempts` | `3` | 瞬时失败或搜索落空时的重试次数（1–5） |
| `filters.domainType` | _(未设置)_ | `web` \| `news` \| `research_paper`——仅补丁文件 |
| `filters.language` / `.location` | _(未设置)_ | 地域定向——仅补丁文件 |
| `filters.includeDomains` / `.excludeDomains` | _(未设置)_ | 逗号分隔——仅补丁文件 |
| `filters.recencyMinutes` | _(未设置)_ | 按分钟计的时效窗口（1–5256000）；上游与 `.afterDate` 互斥——仅补丁文件 |
| `filters.afterDate` | _(未设置)_ | 日期下界，`YYYY-MM-DD`；不适用于 `research_paper`——仅补丁文件 |
| `filters.pubYearMin` | _(未设置)_ | 发表年份下界（0–9999），仅 `research_paper`——仅补丁文件 |
| `fetchOptions.ttl` | _(未设置)_ | 缓存容忍秒数；`0` 强制实时抓取，不设则接受任何缓存——仅补丁文件 |
| `fetchOptions.perUrlTimeoutMs` | _(未设置)_ | 单 URL 耗时上限，毫秒（1–110000）——仅补丁文件 |
| `fetchOptions.excludeSelectors` | _(未设置)_ | 提取前剔除的 CSS 选择器，逗号分隔（1–20 个 × 每个 ≤1000 字符）；直接下载 PDF/CSV 时会被拒绝——仅补丁文件 |
| `monidBase` / `searchBase` / `fetchBase` | 上游默认 | 端点覆盖，给测试环境用 |
| `search` / `fetch` | `true` | 是否提供该种类；`false` 不注销注册，只报告不可用 |

关掉一个报的是“不可用”而非“缺失”——harness 分得清这两者，只有后者意味着“安装坏了”。但“不可用”也不会悄悄 fallback：如果 `searchProvider`/`fetchProvider` 还写着 TinyFish，调用会失败。想用另一个提供方，就把对应工具指向它。

```yaml
- id: dsh-tinyfish
  config:
    search: true
    fetch: false # TinyFish stays registered but unavailable for fetch; point fetchProvider elsewhere to use another fetch
```

#### Manifest 元数据，而非配置

manifest 里还带着 `dsh.compatibility`：显式声明的 Node 与 DSH 范围，外加每个发版的实测结论——`compatible`、`incompatible` 或 `unknown`——供目录核验各 DSH 版本。

**DSH 本体从不读它。**`compatibility` 与 `dshReleases` 在 harness 里无处引用，所以这些字段改变不了插件的加载、注册与行为。它们的存在，是让列表页能如实写清“哪些已被验证”，这里的结论也的确是实测而非期望：`0.2.0-rc.2` 是本仓库每次构建与测试所跑的版本，`0.2.0-rc.1` 虽在 peer 范围内但从未实际跑过，`0.1.7-rc.2` 则低于下限。

### 过滤器与抓取选项写在补丁文件里

`filters` 与 `fetchOptions` 是嵌套对象，而设置表单一个字段只对应一个扁平键——所以搜索与抓取调优留在运维层面：

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

两个分组永远有解析结果：没设就是空分组，不给请求加任何东西；不可用的成员退化为未设置，绝不发往上游。三条上游注意事项按文档行为原样透出，不做强制：

- `recencyMinutes` 与 `afterDate` 在 TinyFish API 里互斥；一行里两个都写就两个都发。
- `excludeSelectors` 对直接下载的 PDF/CSV 无效，带上它会答 `selector_unsupported`。
- 每个日期边界都会按 `domainType` 交叉核验：`recencyMinutes` 与 `afterDate` 不接受 `research_paper`，`pubYearMin` 只属于它，配错任一一对都会让整个搜索被拒绝。

### 凭证从哪里来

**每次调用**现解析——轮换密钥下次搜索即生效，不用重启。先命中先生效：

1. 行里的 `apiKey` 字面量（写在配置里的秘密；优先用 2–3）
2. 凭证服务——`apiKeyEnv`（直连）或 `monidKeyEnv`（Monid），从设置界面保存
3. 启动环境（DSH 启动前 export 的）
4. 实时环境（`MONID_API_KEY` / `MONID_MCP_TOKEN` / `TINYFISH_API_KEY`；任一 Monid 变量都覆盖 `monid` 通道）
5. 各通道的 CLI 存储（`monid keys add` / `tinyfish auth login`）

凭证服务挂了就落到下一个来源，而不是让搜索失败。

### 端点从哪里来

行配置优先，其次环境变量，最后内置默认——测试环境不用改补丁就能换向：

| 设置项       | 环境变量                   |
| ------------ | -------------------------- |
| `monidBase`  | `TINYFISH_MONID_BASE_URL`  |
| `searchBase` | `TINYFISH_SEARCH_BASE_URL` |
| `fetchBase`  | `TINYFISH_FETCH_BASE_URL`  |

</details>

<details>
<summary><strong>🔍 值得了解的行为</strong></summary>

<br />

- **404 是结果，不是错误。**单个 URL 抓取失败会带着状态码回来，因为那是模型需要的资源状态。
- **`publishedAt` 诚实。**TinyFish 报的是人类日期（`"Apr 30, 2026"`、`"1 year ago"`）。能解析的转成 ISO-8601，解析不了的直接丢掉，绝不编造。无时区日期按 UTC 读，所以同一页面在全球报的是同一天。
- **空搜索会重试。**上游大约三跑空一——对合法查询也可能什么都不回；在认定之前，会按 `attempts` 重试空白结果。
- **被拦的 run 是终态。**若 Monid 工作区控制拦停一次运行，错误里会写原因并附充值链接。永不重试。
- **关闭意味着“不可用”，不是“没了”。**关掉的种类保持注册、只是谢绝。若 profile 还把对应工具钉在 Tinyfish 上，调用会大声失败，而不会悄悄改道——想用别的提供方就把工具指向它。什么都没钉时，退出的 Tinyfish 只管让路：自动选择用剩下的人选，关掉其中一种正是把“多提供方歧义”收敛到唯一候选的办法。
- **“不可用”三种成因、一种面孔。**seam 只看到一个布尔值，所以“开关关了”“没凭证”“base URL 写错”在下游读起来一模一样。卡片分得清——去看开关、密钥徽标和端点覆盖。
- **`purpose` 是每次请求的一句话。**seam 的请求没有目标槽位——搜索只有 `{query}`，抓取只有 `{url}`——不动 harness 就不可能有按调用的目标。配置里的那句话会逐字跟随每次搜索与抓取：常驻偏置，而非按任务指令。

TinyFish 的 `agent` 与 `browser` 界面**没有**暴露：按量计费、走钱包，既不是搜索也不是抓取。页面真需要开浏览器时，直接用 `tinyfish` CLI。

</details>

<details>
<summary><strong>🛠 开发</strong></summary>

<br />

工具链是 [Vite+](https://viteplus.dev)：`vp pack` 用 tsdown 构建，`vp test` 跑 Vitest，`vp lint` / `vp fmt` 即 Oxlint 与 Oxfmt，且是类型感知的。Lint 与格式配置住在 `vite.config.ts` 里——Vite+ 会忽略独立配置文件。

```sh
pnpm install
pnpm test               # hermetic — no network, no credential
pnpm run check          # format + lint + types
pnpm run release:gate   # build, then the full gate incl. the package checks
pnpm run test:live      # the real APIs, still $0, needs credentials
```

需要 **DSH `^0.2.0-rc.1`**（0.2.0-rc.1 及之后、0.3.0 之前）与 **Node 24+**。完整流程与不变量：[`AGENTS.md`](./AGENTS.md)。参与贡献：[`CONTRIBUTING.md`](./CONTRIBUTING.md)。

</details>

## 许可证

MIT
