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
  SegmentedControl,
  SettingsForm,
  SettingsFormModel,
  SettingsSecretField,
  SettingsValueField,
  Switch,
  Tag,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldSpec,
  type SettingsFormScope,
} from "@deepseek-ai/dsh-client-ui-primitives";

import { isRecord } from "./guard.ts";

/**
 * The settings namespace, spelled rather than imported.
 *
 * A client package must not depend on a Host package, so this string is
 * duplicated on purpose. It must equal the exported `name` of `src/index.ts`:
 * that is what the Plugins page keys the row by.
 */
export const NS = "dsh-tinyfish";

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
  apiKey: "TinyFish API key",
  apiKeyHint:
    "Stored outside the settings file. Leave blank to keep the current key.",
  monidApiKey: "Monid platform key",
  monidApiKeyHint:
    "Stored separately from the TinyFish key. `monid keys add` also works and takes precedence over this.",
  apiKeySet: "A key is configured.",
  apiKeyUnset: "No key is configured, so searches fail until one is set.",
  purpose: "Purpose",
  purposeHint: "Optional goal statement; TinyFish ranks results against it.",
  attempts: "Attempts",
  attemptsHint: "Retries for a transient failure or an empty result, 1 to 5.",
  search: "Offer search",
  fetch: "Offer fetch",
  offer: "Offer",
  searchName: "web_search",
  fetchName: "web_fetch",
  offerHint: "When off, that tool falls through to another provider.",
  channelDirect: "Direct",
  channelMonid: "Monid",
  bothOff:
    "Both providers are off, so this plugin is registered but answers nothing. Turn one back on to use it.",
  overridden: "Overridden",
  reset: "Reset to default",
  invalidNumber: "Enter a whole number, or leave blank to use the default.",
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
  apiKey: "TinyFish 密钥",
  apiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
  monidApiKey: "Monid 平台密钥",
  monidApiKeyHint:
    "与 TinyFish 密钥分开保存。也可运行 `monid keys add`，其优先级高于此项。",
  apiKeySet: "已配置密钥。",
  apiKeyUnset: "未配置密钥，搜索会失败，直到设置为止。",
  purpose: "目标说明",
  purposeHint: "可选的目标描述；TinyFish 会据此排序结果。",
  attempts: "尝试次数",
  attemptsHint: "瞬时失败或结果为空时的重试次数，1 到 5。",
  search: "提供搜索",
  fetch: "提供抓取",
  offer: "提供",
  searchName: "web_search",
  fetchName: "web_fetch",
  offerHint: "关闭后，对应工具会转由其他提供方处理。",
  channelDirect: "直连",
  channelMonid: "Monid",
  bothOff:
    "搜索与抓取均已关闭，此插件已注册但不再响应任何请求。重新开启其中一个即可恢复使用。",
  overridden: "已覆盖",
  reset: "恢复默认",
  invalidNumber: "请填整数；留空表示使用默认值。",
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
  monidApiKey: "monidApiKey",
  monidKeyEnv: "monidKeyEnv",
  purpose: "purpose",
  attempts: "attempts",
  search: "search",
  fetch: "fetch",
};

/**
 * The id the offer row's heading carries, so its `role="group"` can point at
 * the text a sighted reader already sees rather than repeating it.
 */
const OFFER_LABEL_ID = "plugin-config-tinyfish-offer";

/** Reads one key out of the page's dictionary. */
type Translate = (key: keyof typeof en) => string;

/** One field as the card renders it. */
interface CardField {
  text: string;
  overridden: boolean;
  invalid: boolean;
}

/**
 * What to render when a field the card asks for has no published state.
 *
 * Only reachable if a field name and `SPECS` disagree, which the projection
 * is built from the same `SPECS` to prevent — so this is a floor, not a
 * fallback path. It exists because `Record<string, CardField>` read through
 * `noUncheckedIndexedAccess` is `CardField | undefined`, and spreading that
 * would quietly make `text` optional all the way into the primitive's props.
 */
const EMPTY_CARD_FIELD: CardField = {
  text: "",
  overridden: false,
  invalid: false,
};

/** What `credentials.describe` reports about one channel's key. */
interface ChannelCredentialState {
  configured: boolean;
  writable: boolean;
  ref: string;
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
  /**
   * One entry per channel, both rendered. The channel switch decides which
   * one a request will send; it does not decide which one the page may be
   * edited — hiding the other would mean the only way to set a key for the
   * channel you are not using is to change the channel you are using.
   */
  keys: Record<string, { text: string; named: boolean; ref: string }>;
}

/** What the slot hands the card: the view asked for, copy, state, and actions. Exported so tests stay in sync by construction. */
export interface CardProps {
  view?: "summary" | "page";
  t: Translate;
  useTinyfishCard: <S>(select: (state: CardState) => S) => S;
  edit: (field: string, text: string) => void;
  resetField: (field: string) => void;
  save: () => void;
  discard: () => void;
}

/** The client services this page reaches for, by shape. Exported so tests stay in sync by construction. */
export interface ClientContext {
  effect: (body: () => (() => void) | undefined, label: string) => void;
  locale: {
    bind: (ns: string) => Translate;
    register: (
      ns: string,
      dictionaries: { en: unknown; zh: unknown }
    ) => (() => void) | undefined;
  };
  configForms: {
    get: (ns: string) => SettingsFormScope<unknown>;
    whileServed: (
      namespaces: string[],
      register: (served: Set<string>) => (() => void) | undefined
    ) => (() => void) | undefined;
  };
  slots: {
    inject: (
      slot: string,
      register: () => (() => void) | undefined
    ) => (() => void) | undefined;
    register: (
      entry: Record<string, unknown>,
      component: (props: CardProps) => unknown
    ) => () => void;
  };
  remote: {
    $on: (event: string, listener: () => void) => () => void;
    credentials: {
      set: (ref: string, value: string) => Promise<boolean>;
      describe?: (refs: string[]) => Promise<{
        ok: boolean;
        value: Record<string, { configured?: boolean; writable?: boolean }>;
      }>;
    };
  };
}

/** Credential references the provider falls back to when the section names none. */
const DEFAULT_API_KEY_REF = "TINYFISH_API_KEY";
const DEFAULT_MONID_KEY_REF = "MONID_API_KEY";

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
 * @param which - which channel's reference to read.
 * @returns the reference name, or that channel's default.
 */
function refOf(
  snapshot: { value?: unknown } | undefined,
  which: "direct" | "monid"
) {
  // The snapshot's `value` is the schema-resolved section, but it arrives as
  // `unknown` and the page runs on a Host it does not control: a typo'd row,
  // a no longer-registered field, or a raw value from an older manifest can
  // land here as anything at all. Narrowing rather than asserting keeps a
  // malformed section on the same path as an absent one — the default —
  // instead of handing a primitive to an indexed read and reading back
  // `undefined` anyway, one assertion worse off.
  const raw: unknown = snapshot?.value;
  const section = isRecord(raw) ? raw : undefined;
  const field = which === "monid" ? FIELD.monidKeyEnv : FIELD.apiKeyEnv;
  const named = section?.[field];
  const fallback =
    which === "monid" ? DEFAULT_MONID_KEY_REF : DEFAULT_API_KEY_REF;
  return typeof named === "string" && named.trim() !== ""
    ? named.trim()
    : fallback;
}

/**
 * Component-local styles matching DSH settings fields.
 *
 * Renders as an in-tree `<style>` element so React removes it when unmounted;
 * nothing is appended to `document.head`. Uses standard `--dsw-*` tokens so
 * typography, colors, and borders match injected `SettingsValueField` exactly.
 */
const STYLES = `
.dsh-tf-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsh-tf-field + .dsh-tf-field {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-tf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-tf-label {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-tf-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-tf-badges {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.dsh-tf-toggles {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px 20px;
}
.dsh-tf-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.dsh-tf-toggle-name {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-tf-reset {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-tf-reset:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.dsh-tf-reset:disabled {
  cursor: default;
}
`;

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
/**
 * Resolve a boolean switch to its effective value.
 *
 * The draft text is authoritative when present; a blank draft means untouched,
 * so it falls back to the schema default (on for both switches). The Switch
 * only ever writes "true" or "false", so any other text cannot occur through
 * the UI — but the fallback keeps the control honest if the section arrives
 * in an unexpected shape.
 */
function switchValue(text: string): boolean {
  if (text === "false") return false;
  return true;
}

function TinyfishCard(props: CardProps) {
  const { t } = props;
  if (props.view === "summary") return t("description");

  const state = props.useTinyfishCard((snapshot) => snapshot);
  const disabled = !state.shell.writable;
  const field = (name: string) => ({
    id: `plugin-config-tinyfish-${name}`,
    disabled,
    overriddenLabel: t("overridden"),
    resetLabel: t("reset"),
    // Every entry the card renders is one the projection published, so this
    // misses only if a field name and `SPECS` have drifted apart — and the
    // defaults below make that an empty control rather than an undefined
    // spread. Reading the index with a fallback instead of asserting it also
    // leaves the optionality where a reader can see it.
    ...(state.fields[name] ?? EMPTY_CARD_FIELD),
    onEdit: (text: string) => {
      props.edit(name, text);
    },
    onReset: () => {
      props.resetField(name);
    },
  });

  // The channel draft, or the schema default when untouched. SegmentedControl
  // needs exactly one of its option values — never blank.
  const channelText = state.fields[FIELD.channel]?.text ?? "";
  const channel = channelText === "monid" ? "monid" : "direct";

  // Both keys render, whether or not the channel using them is selected.
  // They used to hide behind the channel switch, which made that switch two
  // things at once: a live setting, and the only way to reach the other key
  // field. Configuring a Monid key while Direct was in use meant staging a
  // channel change you did not want, typing into it, then staging it back —
  // and with Direct selected there was no way to tell whether the Monid key
  // existed at all.
  //
  // The mix-up the hiding was guarding against is answered by the labels
  // instead: each field names the service it authenticates, and its hint
  // names the reference the save lands on.
  //
  // Falls back to an empty entry rather than crashing: the store always
  // publishes both, so a missing one means the shapes drifted, and a settings
  // page that throws on a shape drift takes down the whole Plugins page with
  // it. An empty field that saves nowhere is the honest degradation.
  const keyField = (side: "direct" | "monid") => {
    const entry = state.keys[side] ?? {
      text: "",
      named: false,
      ref: side === "monid" ? DEFAULT_MONID_KEY_REF : DEFAULT_API_KEY_REF,
    };
    const name = side === "monid" ? FIELD.monidApiKey : FIELD.apiKey;
    return (
      <SettingsSecretField
        id={`plugin-config-tinyfish-${name}`}
        label={side === "monid" ? t("monidApiKey") : t("apiKey")}
        hint={`${side === "monid" ? t("monidApiKeyHint") : t("apiKeyHint")} (${entry.ref})`}
        text={entry.text}
        disabled={disabled}
        configured={entry.named}
        stateLabel={entry.named ? t("apiKeySet") : t("apiKeyUnset")}
        onEdit={(text: string) => {
          props.edit(name, text);
        }}
      />
    );
  };

  // Effective switch states, driving both the controls and what renders below.
  const searchOn = switchValue(state.fields[FIELD.search]?.text ?? "");
  const fetchOn = switchValue(state.fields[FIELD.fetch]?.text ?? "");

  // A reset control matching the form's visual language, for the custom
  // controls that SettingsValueField would otherwise provide one for.
  const resetControl = (name: string, overridden: boolean) =>
    overridden ? (
      <span className="dsh-tf-badges">
        <Tag tone="neutral">{t("overridden")}</Tag>
        {!disabled && (
          <button
            type="button"
            className="dsh-tf-reset"
            onClick={() => {
              props.resetField(name);
            }}
          >
            {t("reset")}
          </button>
        )}
      </span>
    ) : null;

  /**
   * One switch of the pair that shares a row.
   *
   * The visible name is the tool's own identifier, not "Offer search": the
   * group label to the left already says Offer, `web_search` is what the
   * hint, the provider and the docs all call this thing, and two copies of
   * the word "offer" on one line said nothing either way. `t("search")`
   * stays as the control's accessible name, where the full sentence is what
   * a screen reader should hear.
   */
  const toggle = (name: string, displayName: string, on: boolean) => (
    <span className="dsh-tf-toggle">
      <span className="dsh-tf-toggle-name">{displayName}</span>
      {resetControl(name, state.fields[name]?.overridden ?? false)}
      <Switch
        label={name === FIELD.search ? t("search") : t("fetch")}
        checked={on}
        onChange={(next) => {
          props.edit(name, String(next));
        }}
        disabled={disabled}
      />
    </span>
  );

  return (
    <SettingsForm
      labels={formLabels(t)}
      state={state.shell}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <style>{STYLES}</style>
      <div className="dsh-tf-field">
        <div className="dsh-tf-head">
          <label
            className="dsh-tf-label"
            htmlFor={`plugin-config-tinyfish-${FIELD.channel}`}
          >
            {t("channel")}
          </label>
          {resetControl(
            FIELD.channel,
            state.fields[FIELD.channel]?.overridden ?? false
          )}
        </div>
        <SegmentedControl
          id={`plugin-config-tinyfish-${FIELD.channel}`}
          label={t("channel")}
          value={channel}
          options={[
            { value: "direct", label: t("channelDirect") },
            { value: "monid", label: t("channelMonid") },
          ]}
          onChange={(next) => {
            props.edit(FIELD.channel, next);
          }}
          disabled={disabled}
        />
        <p className="dsh-tf-hint">{t("channelHint")}</p>
      </div>
      {/* No summary line above either field. `SettingsSecretField` renders
          `stateLabel` unconditionally — configured or not, the tag on the
          label row IS the state — and `hint` already carries the reference,
          so a paragraph of our own printed each of them twice in a card this
          size. And there is nothing to show *in* the field instead: this
          control is write-only by contract (the value never rides a
          response, and it starts blank), which is also why there is no
          default value to prefill — the key is not in the page to show. */}
      {keyField("direct")}
      {keyField("monid")}
      {searchOn && (
        <SettingsValueField
          {...field(FIELD.purpose)}
          label={t("purpose")}
          hint={t("purposeHint")}
          invalidLabel={t("invalidText")}
        />
      )}
      <SettingsValueField
        {...field(FIELD.attempts)}
        label={t("attempts")}
        hint={t("attemptsHint")}
        invalidLabel={t("invalidNumber")}
        numeric
      />
      {/* One row for both switches. They were two rows, each with its own
          label, its own reset badge and a hint repeating the same sentence
          with a different tool name in it — three lines of chrome per
          boolean. The pair is never configured independently of its hint,
          so one row states the rule once and names both tools it governs. */}
      <div className="dsh-tf-field">
        <div className="dsh-tf-head">
          <span className="dsh-tf-label" id={OFFER_LABEL_ID}>
            {t("offer")}
          </span>
          <div
            className="dsh-tf-toggles"
            role="group"
            aria-labelledby={OFFER_LABEL_ID}
          >
            {toggle(FIELD.search, t("searchName"), searchOn)}
            {toggle(FIELD.fetch, t("fetchName"), fetchOn)}
          </div>
        </div>
        <p className="dsh-tf-hint">{t("offerHint")}</p>
      </div>
      {!searchOn && !fetchOn && <p className="dsh-tf-hint">{t("bothOff")}</p>}
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
    try {
      return ctx.locale.register(NS, { zh, en });
    } catch {
      return undefined;
    }
  }, "dsh-tinyfish: dictionaries");

  // `configForms.get(namespace)` returns exactly the scope `SettingsFormModel`
  // takes — both are `{ getSnapshot, subscribe, mutate }` — so there is no
  // separate scope object to build.
  const scope = ctx.configForms.get(NS);

  // Asynchronously queries the host credentials service via `credentials.describe`
  // so the card badges whether a key is actually saved in ~/.dsh/.credentials.yaml
  // rather than checking reference strings.
  //
  // Keyed by the two channel names rather than `Record<string, …>`: every
  // access below is `.direct` or `.monid`, and a string index signature makes
  // each of those reads `T | undefined` for no gain — the keys are fixed, so
  // the compiler can prove all of them exist.
  const credentialsState: Record<"direct" | "monid", ChannelCredentialState> = {
    direct: {
      configured: false,
      writable: true,
      ref: refOf(scope.getSnapshot(), "direct"),
    },
    monid: {
      configured: false,
      writable: true,
      ref: refOf(scope.getSnapshot(), "monid"),
    },
  };

  const model = new SettingsFormModel(scope, SPECS, [
    {
      field: FIELD.apiKey,
      write: async (text) => {
        try {
          const ref = refOf(scope.getSnapshot(), "direct");
          await ctx.remote.credentials.set(ref, text);
          credentialsState.direct.configured = true;
          await readCredentials();
          return true;
        } catch {
          // A refused write surfaces through the form's own failed state;
          // throwing here would take the page down instead of showing it.
          return false;
        }
      },
    },
    {
      field: FIELD.monidApiKey,
      write: async (text) => {
        try {
          const ref = refOf(scope.getSnapshot(), "monid");
          await ctx.remote.credentials.set(ref, text);
          credentialsState.monid.configured = true;
          await readCredentials();
          return true;
        } catch {
          return false;
        }
      },
    },
  ]);

  const projection = () => ({
    shell: model.shell(),
    fields: Object.fromEntries(
      SPECS.map((spec) => [spec.field, model.field(spec.field)])
    ),
    keys: {
      direct: {
        text: model.field(FIELD.apiKey).text,
        named: credentialsState.direct.configured,
        ref: credentialsState.direct.ref,
      },
      monid: {
        text: model.field(FIELD.monidApiKey).text,
        named: credentialsState.monid.configured,
        ref: credentialsState.monid.ref,
      },
    },
  });

  const store = model.bind(projection);

  const readCredentials = async () => {
    const directRef = refOf(scope.getSnapshot(), "direct");
    const monidRef = refOf(scope.getSnapshot(), "monid");
    credentialsState.direct.ref = directRef;
    credentialsState.monid.ref = monidRef;

    if (typeof ctx.remote?.credentials?.describe !== "function") {
      // Test environment fallback: maintain named state if describe is not stubbed
      credentialsState.direct.configured = directRef !== DEFAULT_API_KEY_REF;
      credentialsState.monid.configured = monidRef !== DEFAULT_MONID_KEY_REF;
      store.set(projection());
      return;
    }

    try {
      const response = await ctx.remote.credentials.describe([
        directRef,
        monidRef,
      ]);
      // `describe` answers with `{ok, value}` and both are non-optional, so
      // the old `response && response.ok && response.value` read as three
      // guards and meant one: whether the Host ran the call at all. What is
      // genuinely optional is the entry for *each* reference — a reference no
      // key has ever been stored under is answered by its absence — so the
      // object is narrowed once above and tested for per channel below.
      const described = response.ok ? response.value : undefined;
      if (described !== undefined) {
        const direct = described[directRef];
        if (direct !== undefined) {
          credentialsState.direct.configured = direct.configured ?? false;
          credentialsState.direct.writable = direct.writable ?? true;
        }
        const monid = described[monidRef];
        if (monid !== undefined) {
          credentialsState.monid.configured = monid.configured ?? false;
          credentialsState.monid.writable = monid.writable ?? true;
        }
        store.set(projection());
      }
    } catch {
      // Degrade quietly
    }
  };

  const unsubscribeScope = scope.subscribe(() => {
    void readCredentials();
  });

  ctx.effect(
    () =>
      ctx.remote.$on?.("credentials/reference-updated", () => {
        void readCredentials();
      }),
    "dsh-tinyfish: credential invalidations"
  );

  ctx.effect(
    () => () => {
      unsubscribeScope();
      model.dispose();
    },
    "dsh-tinyfish: form subscription"
  );

  void readCredentials();

  ctx.effect(() => {
    // `plugins.bundle.config`, NOT `plugins.item`: a third-party bundle's own
    // page renders the former, filtered by `entryKey: pkg.name` — which is why
    // the key below is the package name. Gated on the Host serving the
    // namespace, so the page disappears when the plugin is not loaded rather
    // than rendering a form that cannot save.
    // The watcher is owned by this effect, and the registration it performs
    // returns its own disposer: `whileServed` re-runs the callback on every
    // mirror sync while watched, and re-registering the same key without
    // disposing the previous entry throws inside a store subscriber (seen in
    // production as `already has an entry for key "dsh-tinyfish"`). The same
    // holds one level down: the inject callback returns the registration's
    // disposer so a slot collapse-and-redeclare disposes before re-adding.
    const stop = ctx.configForms.whileServed([NS], () => {
      // The hook key becomes the `useTinyfishCard` prop; the actions spread
      // in as `edit` / `resetField` / `save` / `discard`.
      const disposeInject = ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: "dsh-tinyfish",
            locale: NS,
            inject: () => ({
              hooks: { tinyfishCard: store },
              ...model.actions(),
            }),
          },
          TinyfishCard
        )
      );
      return () => {
        if (typeof disposeInject === "function") {
          disposeInject();
        }
      };
    });
    return () => {
      if (typeof stop === "function") {
        stop();
      }
    };
  }, "dsh-tinyfish: page");
}
