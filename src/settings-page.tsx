/**
 * `dsh-tinyfish` settings page — the client half of the bundle.
 *
 * The harness renders a plugin's settings form only when a client bundle
 * contributes a slot to the Plugins page. It never reads the plugin's `Config`
 * schema, so a package with no client half has no form however well its schema
 * is declared, and the harness degrades quietly rather than saying so.
 *
 * This is that half. It is bundled separately from `src/index.ts` — the host
 * half — into `lib/client.cjs`, wrapped in the `window.__ModuleLoader__.load`
 * call the web client expects, and the manifest declares both `dsh.bundle` and
 * `dsh.client`. Those two keys are read by different subsystems and never
 * consult each other, so one package can carry both and the user installs once.
 *
 * Nothing here writes as the user types. The form stages drafts and writes them
 * on save, so what is on screen is exactly what a save would store.
 *
 * @module dsh-tinyfish/settings-page
 */

import {
  SettingsForm,
  SettingsFormModel,
  SettingsSecretField,
  SettingsValueField,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldSpec,
  type SettingsFormScope,
} from "@deepseek-ai/dsh-client-ui-primitives";

/**
 * The settings namespace, spelled rather than imported.
 *
 * A client package must not depend on a Host package, so this string is
 * duplicated on purpose. It must equal the exported `name` of `src/index.ts`:
 * that is what the Plugins page keys the row by.
 */
export const NS = "web-tinyfish";

/**
 * Client-side services this page needs.
 *
 * `configForms` supplies the form scope, `slots` is how the page is
 * contributed, `locale` carries the dictionaries, and the two `remote` entries
 * are the credential reference and its invalidation events.
 */
export const inject = [
  "slots",
  "locale",
  "remote",
  "remote.credentials",
  "configForms",
];

/** English copy. */
const en = {
  title: "TinyFish",
  description: "TinyFish-backed web search and fetch, at $0.",
  channel: "Channel",
  channelHint:
    "direct calls TinyFish with its own key; monid routes through a Monid key.",
  apiKey: "API key",
  apiKeyHint:
    "Stored outside the settings file. Leave blank to keep the current key.",
  apiKeySet: "A key is configured.",
  apiKeyUnset: "No key is configured, so searches fail until one is set.",
  purpose: "Purpose",
  purposeHint: "Optional goal statement; TinyFish ranks results against it.",
  attempts: "Attempts",
  attemptsHint: "Retries for a transient failure or an empty result, 1 to 5.",
  search: "Offer search",
  searchHint: "false stops this plugin being chosen for web_search.",
  fetch: "Offer fetch",
  fetchHint: "false stops this plugin being chosen for web_fetch.",
  boolHint: "Type true or false.",
  overridden: "Overridden",
  reset: "Reset to default",
  invalidNumber: "Enter a whole number, or leave blank to use the default.",
  invalidBoolean: "Enter true or false, or leave blank to use the default.",
  invalidText: "This value was not accepted; leave blank to use the default.",
  readOnly: "This deployment stores settings read-only.",
  unavailable:
    "This plugin is not loaded, so it cannot be configured right now.",
  save: "Save",
  saving: "Saving…",
  saveFailed:
    "The deployment did not accept these values; they were left for you to correct.",
};

/** Simplified Chinese copy, for the profile locale this bundle was written in. */
const zh = {
  title: "TinyFish",
  description: "基于 TinyFish 的网页搜索与抓取，零成本。",
  channel: "通道",
  channelHint: "direct 使用 TinyFish 自己的密钥；monid 通过 Monid 密钥转发。",
  apiKey: "API Key",
  apiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
  apiKeySet: "已配置密钥。",
  apiKeyUnset: "未配置密钥，搜索会失败，直到设置为止。",
  purpose: "目标说明",
  purposeHint: "可选的目标描述；TinyFish 会据此排序结果。",
  attempts: "尝试次数",
  attemptsHint: "瞬时失败或结果为空时的重试次数，1 到 5。",
  search: "提供搜索",
  searchHint: "设为 false 后不再被选为 web_search 的提供方。",
  fetch: "提供抓取",
  fetchHint: "设为 false 后不再被选为 web_fetch 的提供方。",
  boolHint: "请输入 true 或 false。",
  overridden: "已覆盖",
  reset: "恢复默认",
  invalidNumber: "请填整数；留空表示使用默认值。",
  invalidBoolean: "请填 true 或 false；留空表示使用默认值。",
  invalidText: "该值未被接受；留空表示使用默认值。",
  readOnly: "本部署的设置为只读。",
  unavailable: "该插件当前未加载，暂时无法配置。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "本部署没有接受这些值，已保留供你修改。",
};

/** Field names in one place, so the form and its specs cannot drift apart. */
const FIELD = {
  channel: "channel",
  apiKey: "apiKey",
  apiKeyEnv: "apiKeyEnv",
  purpose: "purpose",
  attempts: "attempts",
  search: "search",
  fetch: "fetch",
};

/** Reads one key out of the page's dictionary. */
type Translate = (key: keyof typeof en) => string;

/** One field as the card renders it. */
interface CardField {
  text: string;
  overridden: boolean;
  invalid: boolean;
}

/** The card's published state. */
interface CardState {
  shell: {
    available: boolean;
    writable: boolean;
    dirty: boolean;
    invalid: boolean;
    saving: boolean;
    failed: boolean;
  };
  fields: Record<string, CardField>;
  key: { text: string; named: boolean };
}

/** What the slot hands the card: the view asked for, copy, state, and actions. */
interface CardProps {
  view?: "summary" | "page";
  t: Translate;
  useTinyfishCard: <S>(select: (state: CardState) => S) => S;
  edit: (field: string, text: string) => void;
  resetField: (field: string) => void;
  save: () => void;
  discard: () => void;
}

/** The client services this page reaches for, by shape. */
interface ClientContext {
  effect: (body: () => (() => void) | undefined, label: string) => void;
  locale: {
    bind: (ns: string) => Translate;
    register: (ns: string, dictionaries: { en: unknown; zh: unknown }) => void;
  };
  configForms: {
    get: (ns: string) => SettingsFormScope<unknown>;
    whileServed: (
      namespaces: string[],
      register: (served: Set<string>) => void
    ) => void;
  };
  slots: {
    inject: (slot: string, register: () => void) => void;
    register: (
      entry: Record<string, unknown>,
      component: (props: CardProps) => unknown
    ) => void;
  };
  remote: {
    $on: (event: string, listener: () => void) => () => void;
    credentials: { set: (ref: string, value: string) => Promise<boolean> };
  };
}

/** Credential reference the provider falls back to when the section names none. */
const DEFAULT_API_KEY_REF = "TINYFISH_API_KEY";

/**
 * A boolean field.
 *
 * The primitives ship a text and a number spec but no boolean one, and the Host
 * validates the stored value regardless — this only decides what a draft means.
 * `parse` returning `undefined` is what blocks the save on a typo instead of
 * silently discarding the edit, which is the difference between a visible
 * mistake and a setting that quietly did not apply.
 *
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
/** What each accepted boolean draft stages. Anything absent blocks the save. */
const BOOLEAN_DRAFTS: Record<
  string,
  { kind: "set"; value: boolean } | { kind: "clear" }
> = {
  "": { kind: "clear" },
  true: { kind: "set", value: true },
  false: { kind: "set", value: false },
};

function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) =>
      typeof value === "boolean" || typeof value === "number"
        ? String(value)
        : "",
    // One expression, so there is no path that returns nothing: a draft the
    // field does not accept resolves to `undefined`, which blocks the save.
    parse: (text) => BOOLEAN_DRAFTS[text.trim().toLowerCase()],
  };
}

/** The section fields this card edits, in render order. */
const SPECS = [
  settingsTextField(FIELD.channel),
  settingsTextField(FIELD.purpose),
  settingsNumberField(FIELD.attempts),
  settingsBooleanField(FIELD.search),
  settingsBooleanField(FIELD.fetch),
];

/**
 * The credential reference the section currently names.
 *
 * Read from the accepted section rather than from a draft, because the reference
 * is what the *provider* will resolve — a key typed against a reference that is
 * not yet saved would be stored where nothing looks for it.
 *
 * @param snapshot - the form scope's current snapshot.
 * @returns the reference name, or the provider's default.
 */
function refOf(snapshot: { value?: unknown } | undefined) {
  const section = snapshot?.value as Record<string, unknown> | undefined;
  const named = section?.[FIELD.apiKeyEnv];
  return typeof named === "string" && named.trim() !== ""
    ? named.trim()
    : DEFAULT_API_KEY_REF;
}

/** The labels the shared form frame renders. */
const formLabels = (t: Translate) => ({
  unavailable: t("unavailable"),
  readOnly: t("readOnly"),
  saveFailed: t("saveFailed"),
  save: t("save"),
  saving: t("saving"),
});

/**
 * Render the Plugins list's one-line summary, or the settings form.
 *
 * @param props - the view asked for, locale copy, the form snapshot, its
 * actions, and the credential's configured state.
 * @returns the summary, or the form.
 */
function TinyfishCard(props: CardProps) {
  const { t } = props;
  if (props.view === "summary") return t("description");

  const state = props.useTinyfishCard((snapshot) => snapshot);
  const disabled = !state.shell.writable;
  const { named } = state.key;
  const field = (name: string) => ({
    id: `plugin-config-tinyfish-${name}`,
    disabled,
    overriddenLabel: t("overridden"),
    resetLabel: t("reset"),
    ...(state.fields[name] as CardField),
    onEdit: (text: string) => {
      props.edit(name, text);
    },
    onReset: () => {
      props.resetField(name);
    },
  });

  return (
    <SettingsForm
      labels={formLabels(t)}
      state={state.shell}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SettingsValueField
        {...field(FIELD.channel)}
        label={t("channel")}
        hint={t("channelHint")}
        invalidLabel={t("invalidText")}
        placeholder="direct"
      />
      <SettingsSecretField
        id={`plugin-config-tinyfish-${FIELD.apiKey}`}
        label={t("apiKey")}
        hint={t("apiKeyHint")}
        text={state.key.text}
        disabled={disabled}
        configured={named}
        stateLabel={named ? t("apiKeySet") : t("apiKeyUnset")}
        onEdit={(text: string) => {
          props.edit(FIELD.apiKey, text);
        }}
      />
      <SettingsValueField
        {...field(FIELD.purpose)}
        label={t("purpose")}
        hint={t("purposeHint")}
        invalidLabel={t("invalidText")}
      />
      <SettingsValueField
        {...field(FIELD.attempts)}
        label={t("attempts")}
        hint={t("attemptsHint")}
        invalidLabel={t("invalidNumber")}
        numeric
      />
      <SettingsValueField
        {...field(FIELD.search)}
        label={t("search")}
        hint={`${t("searchHint")} ${t("boolHint")}`}
        invalidLabel={t("invalidBoolean")}
      />
      <SettingsValueField
        {...field(FIELD.fetch)}
        label={t("fetch")}
        hint={`${t("fetchHint")} ${t("boolHint")}`}
        invalidLabel={t("invalidBoolean")}
      />
    </SettingsForm>
  );
}

/**
 * Mount the TinyFish settings page while the Host serves its namespace.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext) {
  ctx.effect(() => {
    ctx.locale.register(NS, { zh, en });
  }, "dsh-tinyfish: dictionaries");

  // `configForms.get(namespace)` returns exactly the scope `SettingsFormModel`
  // takes — both are `{ getSnapshot, subscribe, mutate }` — so there is no
  // separate scope object to build.
  const scope = ctx.configForms.get(NS);

  // Whether a key exists is a question for the credentials domain, and its
  // answer arrives asynchronously — so the card does not ask it. What it can
  // answer synchronously, and what actually decides where a key is looked up, is
  // which reference the section names. The control reports that instead of
  // claiming a key is present when it has not checked.
  const model = new SettingsFormModel(scope, SPECS, [
    {
      field: FIELD.apiKey,
      write: async (text) => {
        try {
          await ctx.remote.credentials.set(refOf(scope.getSnapshot()), text);
          return true;
        } catch {
          // A refused write surfaces through the form's own failed state;
          // throwing here would take the page down instead of showing it.
          return false;
        }
      },
    },
  ]);

  const store = model.bind(() => ({
    shell: model.shell(),
    fields: Object.fromEntries(
      SPECS.map((spec) => [spec.field, model.field(spec.field)])
    ),
    key: {
      text: model.field(FIELD.apiKey).text,
      // Synchronous: does the accepted section name a reference of its own?
      named: refOf(scope.getSnapshot()) !== DEFAULT_API_KEY_REF,
    },
  }));

  ctx.effect(
    () => () => {
      model.dispose();
    },
    "dsh-tinyfish: form subscription"
  );

  ctx.effect(() => {
    // Gated on the Host serving the namespace, so the page disappears when the
    // plugin is not loaded rather than rendering a form that cannot save.
    ctx.configForms.whileServed([NS], () => {
      // `plugins.bundle.config`, NOT `plugins.item`. The item slot is the list
      // of official plugins rendered beside the official bundles; a
      // third-party bundle's own page renders `plugins.bundle.config`,
      // filtered by `entryKey: pkg.name` — which is why the key below is the
      // package name, spelled here rather than imported for the same reason
      // the namespace is. A keyed slot requires `options.key`; the list-slot
      // fields (`id`, `order`, `label`) do not apply here.
      ctx.slots.inject("plugins.bundle.config", () => {
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: "dsh-tinyfish",
            locale: NS,
            // The hook key becomes the `useTinyfishCard` prop; the actions
            // spread in as `edit` / `resetField` / `save` / `discard`.
            inject: () => ({
              hooks: { tinyfishCard: store },
              ...model.actions(),
            }),
          },
          TinyfishCard
        );
      });
    });
  }, "dsh-tinyfish: page");
}
