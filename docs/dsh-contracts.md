# The DSH contracts this package is built on

Every claim here was read out of the installed harness, not inferred from convention. Where a fact was checked by running something, the command is recorded. Read this before changing the manifest, the config row, or the provider registration — each section is a contract that a change can break.

Installed runtime for all of it: **DSH 0.2.0-rc.1**, `@deepseek-ai/cordis` 4.0.4. The packages live in the pnpm store; `scripts/check.mjs` resolves them the same way the plugin does.

## The manifest is one object, two independent readers

A package's `dsh` field is read by two subsystems that never consult each other:

| key | reader | effect |
| --- | --- | --- |
| `dsh.bundle` | `dsh-app-boot` | the package's patch joins the composition |
| `dsh.client` | `dsh-client-modules` | the web client loads `lib/client.js` |
| `dsh.profile` | `dsh-app-boot` | only meaningful in a profile manifest |

`dsh-app-boot`'s own source documents the first:

> `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (one file, or an ordered list of files)

and `dsh-client-modules` documents the second as "an optional string-array field read from a `dsh.client` declaration".

**Consequence:** one package may declare both. No installed package does, because the upstream monorepo keeps host and client code in separate trees with separate build targets — a layout convention, not a manifest rule. This package relies on that: the provider and its settings UI ship as one install.

The bundle contract itself:

- The loader resolves a bundle by **bare name** from a profile's `node_modules`, so the package must stay unscoped and the exported `name` must equal the manifest `name`. `scripts/check.mjs` enforces both.
- Bundles resolve at **boot**. `patchReload: live` covers a patch change, not a newly mounted bundle, so installing one needs a restart.
- Patch lists apply in `dsh.profile.bundles` order over an empty entry list, then the profile's own patches, then any launch patch. **Later layers win**, which is what makes a host row able to override a bundle's default.

## The web seam

`ctx.web` exposes exactly two provider kinds, and a provider is a plain function interface — not a tool surface:

```ts
interface WebSearchProvider {
  readonly id: string;
  /** Cheap local usability check; must not make network calls. */
  available(): boolean;
  search(
    request: WebSearchRequest,
    signal?: AbortSignal
  ): Promise<WebSearchResult>;
}
interface WebFetchProvider {
  readonly id: string;
  available(): boolean;
  fetch(
    request: WebFetchRequest,
    signal?: AbortSignal
  ): Promise<WebFetchResult>;
}
```

Three details that constrain the implementation:

- **`available()` must be synchronous and must not touch the network.** The seam calls it to choose between providers.
- **`WebSearchRequest` carries `maxResults`**, and its own doc says a provider whose API has a result-count control should apply it at the request layer. The seam truncates and flags `truncated` regardless, so a provider without such a control simply lets the seam do it — which is what this one does.
- **`WebFetchBody` has an `html` and a `text` arm.** Returning `text` is what skips `dsh-tool-web`'s turndown conversion.

Selection is `dsh-web`'s, not the provider's: its config has `searchProvider` and `fetchProvider` as separate fields, so the two kinds are independently pointable at different providers. `search` and `fetch` on this plugin's own row control only whether each registers-and-declines.

Registration errors the seam raises: `WEB_DUPLICATE_PROVIDER` when an id is already registered, and `WEB_PROVIDER_CONFIGURED_MISSING` (a named id never registered — reads as a broken install) versus `WEB_PROVIDER_UNAVAILABLE` (a registered provider that declined). That distinction is why a switched-off kind still registers.

## Errors and credentials

- `WebError` comes from `@deepseek-ai/dsh-web` and carries a machine-routable code. A retryable failure is a **subclass**, so `instanceof` still holds downstream. Codes this package raises: `WEB_PROVIDER_ERROR`, `WEB_PROVIDER_CREDENTIAL_MISSING`, `WEB_ABORTED`.
- `@deepseek-ai/schemastery` is the harness's **fork** (3.18.4). It has `.role()`, `.volatile()` and `.get()`, which the public package does not, and those are what make the settings row work. It is a **runtime dependency**, pinned; the harness peers are ranges.
- `credentialRef(name)` returns the **plain string**, not a wrapper object. A stub that matches `.name` silently never fires.
- The credentials service is reached as `ctx.get("credentials")` and resolves a ref to `{ value }`. `launchEnvironmentOf(ctx)` reads a `launchEnvironment` service and returns an object with `.get(ref)`.
- Both lookups must be guarded: a host mounting neither still has to load this plugin, falling through to the environment and the CLI stores.

## The settings UI is slot-contributed, not schema-rendered

This is the fact that decides whether a config row appears in the GUI, and it is not what the naming suggests.

`dsh-client-ui-settings-plugins` renders a page of tabs and calls `renderSlot`. Its own doc comment:

> Render one Plugins page whose contents arrive from feature-owned tabs; one contribution shows as the page itself.

It never reads a plugin's `Config`. **A page exists only because a package contributed one.** So a plugin with no client bundle has no form, no matter how well its schema is declared — and the harness degrades quietly.

### Registering one

The verified shape, read out of `dsh-client-ui-settings-web-search/lib/client.js`:

```js
const NS = "web-tinyfish"; // spelled here: a client package must not import a Host package

export const inject = [
  "slots",
  "locale",
  "remote",
  "remote.credentials",
  "configForms",
];

export function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "…: dictionaries");

  const card = new CardController(ctx.configForms.get(NS), ctx);
  ctx.effect(() => () => card.dispose(), "…: form subscription");
  ctx.effect(
    () =>
      ctx.remote.$on("credentials/reference-updated", (ref) =>
        card.refreshCredential(ref)
      ),
    "…: credential invalidations"
  );

  ctx.effect(
    () =>
      ctx.configForms.whileServed([NS], () =>
        ctx.slots.inject("plugins.item", () =>
          ctx.slots.register(
            {
              name: "plugins.item",
              id: "tinyfish",
              order: 40,
              label: () => t("title"),
              locale: NS,
              inject: () => card.inject(),
            },
            Card
          )
        )
      ),
    "…: page"
  );
}
```

Two things that were hard to find and are easy to get wrong:

- **The scope is `ctx.configForms.get(namespace)`** — a `ConfigForm`, passed straight to `SettingsFormModel`. There is no separate scope object.
- **The slot key is `"plugins.item"`**, not `settings.plugins.tab`. The latter is the tab list declared by `dsh-client-ui-settings`; `plugins.item` is the per-entry slot, declared by **`dsh-client-ui-plugin-manager`** as `{ kind: 'list', scope: 'root', owner: PluginConfigViewProps }`. Registration is gated on `configForms.whileServed([NS], …)` (`whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => …)`) so the page disappears when the Host plugin is not loaded — which is why the shipped copy can say _"This plugin is not loaded, so it cannot be configured right now."_
- The credential invalidation event is **`credentials/reference-updated`**; `credentials/record-updated` is its sibling. A page that shows whether a key is configured has to refresh on both, or it goes stale after a rotation.

Slot declarations are `declare module` augmentations of `SlotMap`, and declaring a slot is claiming it: registering into an undeclared slot throws at load.

### The form API

```ts
configForms.get<T>(entryId: string): ConfigForm<T>
interface ConfigForm<T> {
  getSnapshot(): ConfigFormSnapshot<T>;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>;
}
```

Every name above was confirmed present in the installed packages: `SettingsFormModel` (a class), `settingsTextField`, `settingsNumberField`, `SettingsForm`, `SettingsSecretField`, `SettingsValueField`, `whileServed`, and the `plugins.item` declaration itself.

### The form API, in full

Read out of `dsh-client-ui-primitives/lib/types/settings-form/form-model.d.ts`. `configForms.get(ns)` returns exactly a `SettingsFormScope`, so it is passed straight to the model — there is no separate scope object to construct:

```ts
interface SettingsFormScope<T> {
  getSnapshot(): {
    status: "loading" | "ready" | "unavailable";
    value: T | undefined;
    base: unknown;
    user: unknown;
    writable: boolean;
    revision: number | undefined;
  };
  subscribe(listener: () => void): () => void;
  mutate(
    ops: readonly SettingsFormPathOp[],
    expectedRevision?: number
  ): Promise<boolean>;
}

class SettingsFormModel<T> {
  constructor(
    scope: SettingsFormScope<T>,
    specs: SettingsFieldSpec[],
    secrets?: SettingsSecretSpec[]
  );
  bind<S>(project: () => S): SnapshotStore<S>;
  shell(): SettingsFormShell; // { available, writable, dirty, invalid, saving, failed }
  field(field: string): SettingsFieldState; // { text, overridden, invalid }
  actions(): SettingsFormActions; // { edit, resetField, save, discard }
  save(): Promise<void>;
  dispose(): void;
}

interface SettingsFieldSpec {
  field: string;
  format: (v: unknown) => string;
  parse: (
    t: string
  ) => { kind: "set"; value: unknown } | { kind: "clear" } | undefined;
}
interface SettingsSecretSpec {
  field: string;
  write: (text: string) => Promise<boolean>;
}
```

`settingsTextField(field)` and `settingsNumberField(field)` build the two shipped specs. **There is no boolean spec** — a boolean control needs a hand-written `SettingsFieldSpec`, and `parse` returning `undefined` is what blocks a save on a typo rather than silently dropping the edit.

A field is marked overridden by **presence in the user layer**, not by comparing values: an override equal to the composition default is still an override. `base` is what a field reverts to when cleared.

Credentials are written outside the section, because a literal never rides a response:

```js
ctx.remote.credentials.describe([ref])      // is one configured?
ctx.remote.credentials.set(ref, value)      // write it
ctx.remote.$on("credentials/reference-updated", …)   // and refresh on rotation
```

Components come from `@deepseek-ai/dsh-client-ui-primitives`: `SettingsForm` (`{labels, state, onSave, onDiscard, children}`), `SettingsSecretField`, `SettingsValueField` (`numeric`), and `SettingsFormModel(scope, [settingsTextField(…), settingsNumberField(…)], [credentialWriter])`.

Client packages are bundled with **tsdown** (`scripts.bundle`), which is what `vp pack` already is, and emit a `window.__ModuleLoader__.load({ id, factory })` wrapper. Their manifest declares `dsh.client.inject`, `dsh.client.platform: "web"`, and a `./client` export.

## Runtime compatibility

The loader checks only peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`; `@deepseek-ai/cordis` is not checked. `workspace:^`/`~`/`*` mean "current runtime" and always pass; any other range goes through `semver.satisfies(runtime, range, { includePrerelease: true })`.

Both wrong answers have shipped here and both are guarded in `scripts/check.mjs`: an **exact pin** orphans the plugin on every DSH prerelease, and **`workspace:^`** satisfies the loader while making `npm install` answer EUNSUPPORTEDPROTOCOL.
