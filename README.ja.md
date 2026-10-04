<div align="center">
  <img src="icon.svg" alt="TinyFish logo" width="120" />
  <h1>dsh-tinyfish</h1>
  <p><strong>DeepSeek Harness 用の無料 Web 検索・フェッチ。</strong><br />エージェントにライブな Web を — 1回あたり $0 で。</p>

[![npm](https://img.shields.io/npm/v/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish) [![downloads](https://img.shields.io/npm/dm/dsh-tinyfish.svg)](https://www.npmjs.com/package/dsh-tinyfish) [![ci](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml/badge.svg)](https://github.com/viztor/dsh-tinyfish/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/dsh-tinyfish.svg)](https://github.com/viztor/dsh-tinyfish/blob/main/LICENSE)

</div>

---

エージェントはすでに推論できます。このプラグインが与えるのは、推論の _材料_ です。ライブな検索結果ときれいなページ本文を、ハーネス標準の `web_search` と `web_fetch` に直接つなぎます。[TinyFish](https://agent.tinyfish.ai/sign-up?ref=v1.dXNlcl8zSnh2TDJGaldOV2FQYWhnaDRqbTIzc0dqZTE.KxSdeNUG14oJKVFVFWLkOwn3-Pia7QI5BuaxiJ_iEVY) による提供 — 両エンドポイントとも無料なので、ホストの Web 経路が呼び出しごとの課金から解放されます。

| 変更前 | 変更後 |
| --- | --- |
| 検索のたびに課金される | **$0**、ずっと無料 |
| 取得したページは HTML のまま届き、ぎこちなく変換される | ブラウザー級の抽出エンジンから**クリーンな Markdown**を直接取得 |
| プロバイダーの切り替えには再インストールが必要 | 設定ファイルの**2ワード**書き換えだけ、再インストール不要 |
| プロバイダーはクエリしか受け付けない | **常駐のデフォルト** — ドメイン、言語、鮮度、日付範囲、キャッシュ TTL、セレクター |

## 他の手段との比較

| 用途 | 使うもの | コスト |
| --- | --- | --- |
| ネイティブツール内で検索とフェッチを無料で使う | **dsh-tinyfish**、どちらのチャネルでも | **$0** — direct なら TinyFish のキー、Monid ならプラットフォームのキー。ペイロードは同一です |
| 出荷時デフォルト | `deepseek-official` + `http` | 呼び出しごとに課金。取得した HTML には turndown 変換のコストがかかります |
| プロバイダー固有の SERP 詳細（地域・ボリューム・順位）やバルククエリが必要 | `monid_run` 経由の Monid SERP ミラー | 1回あたり $0.03–$0.12 — その詳細が必要なタスクでのみ使います |
| `fetch` では読めないページ（JS 中心、ログイン、操作が必要） | CLI の `tinyfish agent` / `browser` | 従量課金（$0.016/step、$0.002/min）— 空の fetch 結果からのみエスカレーションします |

## 🚀 クイックスタート

### 方法 1: Web UI から直接インストール（推奨）

DeepSeek Harness では、ターミナルに触れずに Web 画面から直接プラグインをインストールできます。

1. DSH Web を開き、**設定 → プラグイン**へ進みます。
2. **プラグインをインストール**をクリックします。
3. `dsh-tinyfish`（または `@viztor/dsh-tinyfish`）を検索または入力します。
4. **インストール**をクリックします — DSH が npm からパッケージを自動取得し、バンドルパッチをビルドして、再起動なしでそのまま有効化します！
5. **設定 → プラグイン → TinyFish**でチャネル（`direct` または `monid`）を選び、キーを入力 — 両方のキーを入力してもかまいません — **保存**を押します！
6. インストールはこれで完了です — バンドルが検索・フェッチ両方の Web 経路を TinyFish に向けます。別の選び方は[選択する](#select-it)を参照してください。
7. エージェントに時事的な質問をしてみましょう。ツール呼び出しが `tinyfish` として返ってくれば成功です。

---

### 方法 2: ターミナル / プロファイルの `package.json`

ヘッドレス環境、サーバー、バージョン管理したい dotfiles 向けの方法です。

```sh
cd ~/.dsh/profiles/web
npm install dsh-tinyfish   # or: npm install @viztor/dsh-tinyfish — same thing
```

**どちらか一方**の名前を選んで一度だけインストールします。両方の tarball はバイト単位で同一のコードを含み、同じ設定を読みます（プロバイダーは `tinyfish` として登録され、設定は行 ID `dsh-tinyfish` の下に、資格情報は同じ2つの参照先に置かれます）— 後から名前を変えても何も失われませんが、両方をマウントするとバンドルが二重に読み込まれます。`dsh-tinyfish` は DSH の慣例に沿った名前であり、このドキュメントでも使います。

<details>
<summary><strong>📦 GitHub Packages からインストールする</strong></summary>

<br />

すべてのリリースは `@viztor/dsh-tinyfish` を GitHub Packages にミラーしています — npmjs.org に届かない場合の第二の取得元であり、リポジトリのサイドバーに表示されるのもこちらです。ミラーされるのはスコープ付きの名前だけです。GitHub はオーナースコープでパッケージをリポジトリにひも付けるからです。npmjs とは異なり、GitHub Packages は公開パッケージでも認証が必須です。認証なしのリクエストはパッケージの有無を示さず 404 になります。`read:packages` 権限を持つトークンがあれば使えます。

```ini
# project-local .npmrc is better than global for a token
@viztor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx
```

`npm install @viztor/dsh-tinyfish` でミラーから解決されるようになります。npmjs が停止中でもない限り、npmjs を使ってください。トークンも追加設定も不要です。
</details>

**マウントします** — そのプロファイルの `package.json` に追加し、DSH を再起動します。

```jsonc
{
  "dependencies": { "dsh-tinyfish": "^0.10.0" },
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

> `package.json` 経由でインストールしたバンドルは起動時に解決されるため、ここでは DSH を再起動してください — パッチのリロードだけでは読み込まれません。

**キーを追加します** — 下からチャネルを選んで保存し、エージェントに時事的な質問をします（_直近の F1 レースで優勝したのは？_）。ツール呼び出しが `tinyfish` として返ってくれば成功です。その名前こそ、行が検証され、資格情報が解決され、プロファイルがこのプロバイダーを指している証拠になります。

### 選択する

**バンドルはデフォルトで両方の Web kind に TinyFish を選択します**。そのため、新規インストールはパッチを編集しなくても動作します。仕組みは、Web シームの `searchProvider` / `fetchProvider` を行 ID で指定することです。これがプラグインに許された唯一の方法です。`dsh-web` はこの2つのフィールドをコンストラクターで一度だけ解決し、プロバイダーが自ら名乗り出るための API は公開していません。

別の選択にするには、プロファイルの `cordis.patch.yml` で上書きします。このファイルはすべてのバンドルパッチの後に適用されるため、こちらが優先されます。

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

2つの kind は独立したフィールドなので、検索は TinyFish 経由、フェッチは出荷時標準の `http` プロバイダーのままにしたり、その逆にしたりできます。どちらの場合もプラグインはマウントされたまま待機します。ホスト側で `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` を設定する方法もあります — 同じフィールドに供給され、両方が指定された場合は設定値が優先されます。

## 🔑 2つのチャネル、1つのプラグイン

|  | Direct _(デフォルト)_ | Monid 経由 |
| --- | --- | --- |
| 背後にあるもの | TinyFish 自身の API | 同じ TinyFish エンドポイントを、Monid ウォレット経由で利用 |
| 必要なもの | [tinyfish.ai](https://agent.tinyfish.ai/sign-up?ref=v1.dXNlcl8zSnh2TDJGaldOV2FQYWhnaDRqbTIzc0dqZTE.KxSdeNUG14oJKVFVFWLkOwn3-Pia7QI5BuaxiJ_iEVY) の無料キー | [app.monid.ai](https://app.monid.ai) のプラットフォームキー |
| 最速のセットアップ | `tinyfish auth login` | `monid keys add` |
| コスト | $0 | $0 |

デフォルトは `direct` です。パッケージ名が TinyFish 由来なので、新規インストールではその名前が示す資格情報を求めます。Monid がよい場合（Monid MCP マウントが保持するプラットフォームキーを再利用できます）は、プロファイルパッチで固定します。

```yaml
- id: dsh-tinyfish
  config:
    channel: monid
```

両方のキーは共存できます — 一方を保存しても他方が上書きされることはなく、チャネルを切り替えても何も失われません。

## ⚙️ 設定ページ

**設定 → プラグイン → TinyFish**です。編集可能なものはすべてここにあります。TinyFish が検索とフェッチに応答するかどうか、チャネル選択、キー、検索のランク付け条件、リトライです。変更はまとめてステージされ、一緒に保存されます。入力したキーはハーネスが保管し、プロファイルには保存されません。

両方のキーフィールドがページ上に同時に表示され、それぞれが認証対象のサービス名でラベル付けされ、ヒントには保存先の参照名が書かれています — そのため Direct 選択中でも Monid キーを設定でき、行ったり来たり切り替えずにどちらが存在するかを確認できます。

> この行は TinyFish の動作を設定するものであり、選択するものではありません。`searchProvider`/`fetchProvider` を `tinyfish` に向けるのはプロファイルパッチでの別ステップです — [選択する](#select-it)を参照してください。元に戻す場合も同じ2ワードを逆向きに書きます。

<details>
<summary><strong>📖 設定の完全リファレンス</strong></summary>

<br />

すべては1つの行 `dsh-tinyfish` に集約されています。この行は検証されるため、範囲外の値は黙って丸められるのではなく、メッセージ付きで拒否されます。

| キー | デフォルト | 意味 |
| --- | --- | --- |
| `channel` | `direct` | `monid` または `direct` |
| `apiKey` | _(unset)_ | どちらのチャネルにも使えるリテラルの資格情報。参照を使うことが推奨されます |
| `apiKeyEnv` | `TINYFISH_API_KEY` | `direct` 用の資格情報参照、または環境変数 |
| `monidKeyEnv` | `MONID_API_KEY` | `monid` 用の資格情報参照、または環境変数 |
| `purpose` | _(unset)_ | すべての検索・フェッチに添える目的文。TinyFish はこれに基づいてランク付けします。最大2000文字 |
| `attempts` | `3` | 一時的な失敗や空の検索に対するリトライ回数（1–5） |
| `filters.domainType` | _(unset)_ | `web` \| `news` \| `research_paper` — パッチファイルでのみ指定 |
| `filters.language` / `.location` | _(unset)_ | 地理ターゲティング — パッチファイルでのみ指定 |
| `filters.includeDomains` / `.excludeDomains` | _(unset)_ | カンマ区切り — パッチファイルでのみ指定 |
| `filters.recencyMinutes` | _(unset)_ | 鮮度ウィンドウ（分単位、1–5256000）。上流では `.afterDate` と相互排他 — パッチファイルでのみ指定 |
| `filters.afterDate` | _(unset)_ | 日付の下限 `YYYY-MM-DD`。`research_paper` には使えません — パッチファイルでのみ指定 |
| `filters.pubYearMin` | _(unset)_ | 出版年の下限（0–9999）。`research_paper` 専用 — パッチファイルでのみ指定 |
| `fetchOptions.ttl` | _(unset)_ | キャッシュ許容秒数。`0` はライブフェッチを強制、未設定はあらゆるキャッシュを許容 — パッチファイルでのみ指定 |
| `fetchOptions.perUrlTimeoutMs` | _(unset)_ | URL ごとの制限時間（ミリ秒、1–110000）— パッチファイルでのみ指定 |
| `fetchOptions.excludeSelectors` | _(unset)_ | 抽出前に除去するカンマ区切りの CSS セレクター（1–20件 × 各1000文字以内）。直接の PDF/CSV ダウンロードでは拒否されます — パッチファイルでのみ指定 |
| `monidBase` / `searchBase` / `fetchBase` | upstream | エンドポイントの上書き。ステージング用です |
| `search` / `fetch` | `true` | この kind を提供するかどうか。`false` は登録解除せずに利用不可として報告します |

一方をオフにすると _missing_ ではなく _unavailable_ として報告されます — ハーネスは両者を区別し、後者のみが「インストールが壊れている」という意味です。ただし _unavailable_ が黙ってフォールスルーすることはありません。`searchProvider`/`fetchProvider` がまだ TinyFish を指している場合、その呼び出しは失敗します。一方を使うには、そのツールを別のプロバイダーに向けてください。

```yaml
- id: dsh-tinyfish
  config:
    search: true
    fetch: false # TinyFish stays registered but unavailable for fetch; point fetchProvider elsewhere to use another fetch
```

#### マニフェストのメタデータであり、設定ではありません

マニフェストには `dsh.compatibility` も含まれています。Node と DSH の対応範囲を明示し、カタログが確認する DSH バージョンごとに `compatible`、`incompatible`、`unknown` のいずれかの判定を付けます。

**DSH 自身はこれを読みません。**`compatibility` も `dshReleases` もハーネス内のどこにも登場しないため、これらのフィールドがプラグインの読み込み・登録・動作を変えることはありません。存在理由は、一覧表示で実際に検証済みの内容を述べられるようにすることです。ここの判定は願望ではなく実測に基づきます。`0.2.0-rc.2` はこのリポジトリのすべてのビルドとテストが対象とするバージョン、`0.2.0-rc.1` はピア範囲内だが実際には検証していないもの、`0.1.7-rc.2` は下限を下回るものです。

### フィルターとフェッチオプションはパッチファイルに書きます

`filters` と `fetchOptions` はネストしたオブジェクトであり、設定フォームはフィールドごとに1つのフラットなキーしか扱いません — そのため検索とフェッチの調整はオペレーターレベルのままです。

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

両セクションは常に解決されます。未設定のセクションはリクエストに何も追加しない空のグループになり、使用できないメンバーは上流に送らず、未設定に落とします。上流由来の3つの注意点は、強制ではなく文書化された動作としてそのまま通します。

- `recencyMinutes` と `afterDate` は TinyFish の API では相互排他です。行に両方を書いた場合は両方とも送られます。
- `excludeSelectors` は直接の PDF/CSV ダウンロードには適用できません。設定中は `selector_unsupported` が返ります。
- 各日付範囲は `domainType` と突き合わせられます。`recencyMinutes` と `afterDate` は `research_paper` では拒否され、`pubYearMin` はこの用途専用です。誤った組み合わせが設定されている間は検索全体が拒否されます。

### 資格情報の取得元

呼び出しごとに解決されます（**per call**）— ローテーションしたキーは次の検索から有効になり、再起動は不要です。最初に一致したものが使われます。

1. 行内の `apiKey` リテラル（設定内のシークレット。2–3が推奨されます）
2. 資格情報サービス — 設定 UI から保存した `apiKeyEnv`（direct）または `monidKeyEnv`（monid）
3. 起動環境（DSH 起動前に export されたもの）
4. ライブ環境（`MONID_API_KEY` / `MONID_MCP_TOKEN` / `TINYFISH_API_KEY`。Monid の変数はどちらでも `monid` チャネルに対応します）
5. チャネルごとの CLI ストア（`monid keys add` / `tinyfish auth login`）

サービスが失敗した場合は検索を失敗させず、次の取得元にフォールスルーします。

### エンドポイントの取得元

行、環境変数、組み込みデフォルトの順です — ステージングはパッチなしで向き先を変えられます。

| 設定         | 環境変数                   |
| ------------ | -------------------------- |
| `monidBase`  | `TINYFISH_MONID_BASE_URL`  |
| `searchBase` | `TINYFISH_SEARCH_BASE_URL` |
| `fetchBase`  | `TINYFISH_FETCH_BASE_URL`  |

</details>

<details>
<summary><strong>🔍 知っておきたい動作</strong></summary>

<br />

- **404 はエラーではなく結果です。**URL ごとのフェッチ失敗はステータス付きで返ります。それはモデルが必要とするリソースの状態だからです。
- **`publishedAt` は正直です。**TinyFish は人間向けの日付（`"Apr 30, 2026"`、`"1 year ago"`）を報告します。パースできたものは ISO-8601 になり、できなかったものは作らずに落とします。タイムゾーンのない日付は UTC として読むため、同じページはどこでも同じ日付で報告されます。
- **空の検索はリトライします。**上流は有効なクエリにも3回に1回ほど空で答えます — 空の結果は `attempts` 回までリトライしてから確定します。
- **ブロックされた実行は終了です。**Monid のワークスペース制御が実行を止めた場合、エラーに理由とチャージ先リンクが示されます。リトライはしません。
- **オフは _unavailable_ であり、消滅ではありません。**オフにした kind は登録されたまま辞退します。プロファイルがそのツールを Tinyfish に固定したままだと、黙って迂回されることなく明示的に失敗します — 一方を使うにはツールを別のプロバイダーに向けてください。何も固定していなければ、退いた Tinyfish は単に譲ります。自動選択が残りのプロバイダーを選び、1つの kind をオフにすることが "ambiguous provider" の膠着を単一候補に解消する方法です。
- **_Unavailable_ には3つの原因と1つのメッセージがあります。**シームが見ているのは真偽値だけなので、"switched off"、"no credential"、"bad base URL" は下流では同じに見えます。カード上では区別できます — スイッチ、キーバッジ、エンドポイントの上書きを確認してください。
- **`purpose` はすべてのリクエストに付く一文です。**シームのリクエストには目的を入れる枠がありません — 検索は `{query}`、フェッチは `{url}` のみ — そのためハーネスを変更しない限り呼び出しごとの目的指定はできません。設定した一文はすべての検索とフェッチにそのまま付きます。タスクごとの指示ではなく、常駐のバイアスです。

TinyFish の `agent` と `browser` サーフェスは**公開していません**。従量課金でウォレット請求であり、検索でもフェッチでもないからです。ページにどうしても実ブラウザーが必要な場合は `tinyfish` CLI を直接使ってください。

</details>

<details>
<summary><strong>🛠 開発</strong></summary>

<br />

ツールチェインは [Vite+](https://viteplus.dev) です。`vp pack` は tsdown でビルド、`vp test` は Vitest を実行、`vp lint` / `vp fmt` は型対応の Oxlint と Oxfmt です。lint と format は `vite.config.ts` にあり — Vite+ は単独の設定ファイルを無視します。

```sh
pnpm install
pnpm test               # hermetic — no network, no credential
pnpm run check          # format + lint + types
pnpm run release:gate   # build, then the full gate incl. the package checks
pnpm run test:live      # the real APIs, still $0, needs credentials
```

**DSH `^0.2.0-rc.1`**（0.2.0-rc.1 以降、0.3.0 未満）と **Node 24+** が必要です。プロセスと不変条件の全体は [`AGENTS.md`](./AGENTS.md)、コントリビュートは [`CONTRIBUTING.md`](./CONTRIBUTING.md) を参照してください。

</details>

## ライセンス

MIT
