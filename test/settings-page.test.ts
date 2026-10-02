/**
 * Settings-page tests, against the source module.
 *
 * `test/client-bundle.test.mjs` executes the **built** `lib/client.js` under
 * `node:vm`, which is the right place to prove the shipped artifact registers
 * and wires itself correctly. It says nothing about which lines of
 * `src/settings-page.tsx` ran, and that file was at 0% coverage as a result.
 *
 * So this file imports the source and calls the card directly. The element
 * tree it returns is inspected structurally — React's `jsx()` produces plain
 * `{ type, props }` objects, which is all a DOM-free assertion needs, and no
 * renderer is involved.
 */

import assert from "node:assert/strict";

import { test } from "vitest";

import { resolveOptions } from "../src/index.ts";
import { apply } from "../src/settings-page.tsx";
import { nth } from "./helpers.ts";

/** An element node, as React's `jsx()` and the stub kit produce it. */
interface TestElement {
  type: unknown;
  props: { children?: unknown; [key: string]: unknown };
}

/** One field as the card's store publishes it. */
interface TestField {
  text: string;
  overridden: boolean;
  invalid: boolean;
}

/** The store snapshot the card selects from. */
interface TestState {
  shell: {
    available: boolean;
    writable: boolean;
    dirty: boolean;
    invalid: boolean;
    saving: boolean;
    failed: boolean;
  };
  fields: Record<string, TestField>;
  keys: Record<string, { text: string; named: boolean; ref: string }>;
}

/** One staged edit the card records. */
interface TestEdit {
  name: string;
  value: string | undefined;
}

/** What the slot entry hands the card: the model's own actions. */
interface SlotEntry {
  inject: () => {
    edit: (name: string, value: string) => void;
    resetField: (name: string) => void;
    save: () => Promise<boolean>;
    discard: () => void;
  };
}

/** One credential the page wrote. */
interface TestWrite {
  ref: string;
  value: string;
}

/** Props of the controls the card renders, as the tests read them. */
interface SegmentedProps {
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
}

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
}

interface FieldProps {
  id: string;
  overridden: boolean;
  onReset: () => void;
}

interface ButtonProps {
  onClick: () => void;
}

interface SecretProps {
  id: string;
  label: string;
  onEdit: (text: string) => void;
}

/** First match, asserting the test actually found the control it names. */
function firstOf(tree: unknown, type: string): TestElement {
  const [found] = findAll(tree, type);
  assert.ok(found, `expected a ${type} in the tree`);
  return found;
}

/** Read a control's props with the shape the test asserts on. */
function seg(el: TestElement): SegmentedProps {
  return el.props as unknown as SegmentedProps;
}

function sw(el: TestElement): SwitchProps {
  return el.props as unknown as SwitchProps;
}

function fld(el: TestElement): FieldProps {
  return el.props as unknown as FieldProps;
}

function btn(el: TestElement): ButtonProps {
  return el.props as unknown as ButtonProps;
}

function sec(el: TestElement): SecretProps {
  return el.props as unknown as SecretProps;
}

/** Element type as a comparable name. */
function nameOf(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "function") return type.name || "fn";
  return String(type);
}

/** Narrows an unknown tree node to the element shape the walkers read. */
function isElement(node: unknown): node is TestElement {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    "props" in node &&
    typeof (node as { props: unknown }).props === "object"
  );
}

/** Every element of `type` in the tree, depth-first through props.children. */
function findAll(
  node: unknown,
  type: string,
  acc: TestElement[] = []
): TestElement[] {
  if (!isElement(node)) return acc;
  if (nameOf(node.type) === type) acc.push(node);
  const { children } = node.props;
  if (Array.isArray(children)) {
    for (const child of children) findAll(child, type, acc);
  } else if (children !== undefined) {
    findAll(children, type, acc);
  }
  return acc;
}

/** The text of every string child anywhere in the tree. */
function texts(node: unknown, acc: string[] = []): string[] {
  if (typeof node === "string") {
    acc.push(node);
    return acc;
  }
  if (!isElement(node)) return acc;
  const { children } = node.props;
  if (Array.isArray(children)) {
    for (const child of children) texts(child, acc);
  } else if (children !== undefined) {
    texts(children, acc);
  }
  return acc;
}

/**
 * Mount the page and hand back the card it registered.
 *
 * @param section - the accepted section, as the Host would publish it.
 * @returns the registered component, plus the credential refs it writes to.
 */
interface MountOptions {
  describe?: (refs: string[]) => Promise<{
    ok: boolean;
    value: Record<string, { configured?: boolean; writable?: boolean }>;
  }>;
}

function mount(
  section: Record<string, unknown> = {},
  options?: MountOptions
): {
  entry: SlotEntry;
  component: (props: Record<string, unknown>) => unknown;
  written: TestWrite[];
  snapshot: unknown;
  listeners: Record<string, (() => void)[]>;
} {
  // Typed as the page's own context: a drift between what the test provides
  // and what the page consumes is a type error here, not a silent mismatch.

  const written: TestWrite[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const registrations: {
    entry: SlotEntry;
    component: (props: Record<string, unknown>) => unknown;
  }[] = [];
  // The page's register takes a broad entry; narrow on store so the tests
  // below can call inject() without casting at every site.
  const store = (
    entry: SlotEntry,
    component: (props: Record<string, unknown>) => unknown
  ): (() => void) => {
    registrations.push({
      entry: entry as unknown as SlotEntry,
      component,
    });
    return () => {};
  };
  const snapshot: {
    status: string;
    value: Record<string, unknown>;
    base: Record<string, unknown>;
    user: Record<string, unknown>;
    writable: boolean;
    revision: number;
  } = {
    status: "ready",
    value: section,
    base: {},
    user: {},
    writable: true,
    revision: 1,
  };
  const ctx = {
    effect: (body: () => (() => void) | undefined, _label: string): void => {
      const disposer = body();
      if (typeof disposer === "function") disposer();
    },
    locale: {
      bind:
        (_ns: string) =>
        (key: string): string =>
          key,
      register: (
        _ns: string,
        _dictionaries: { en: unknown; zh: unknown }
      ): void => {},
    },
    configForms: {
      get: (_ns: string) => ({
        getSnapshot: () => snapshot,
        subscribe: () => (): void => {},
        mutate: async (_ops: unknown, _rev?: number): Promise<boolean> => true,
      }),
      whileServed: (
        namespaces: string[],
        register: (served: Set<string>) => (() => void) | undefined
      ): (() => void) | undefined => {
        const stop = register(new Set(namespaces));
        return () => {
          if (typeof stop === "function") {
            stop();
          }
        };
      },
    },
    slots: {
      inject: (
        _slot: string,
        register: () => (() => void) | undefined
      ): (() => void) | undefined => register(),
      register: store,
    },
    remote: {
      $on: (event: string, listener: () => void): (() => void) => {
        (listeners[event] ??= []).push(listener);
        return () => {};
      },
      credentials: {
        describe: options?.describe,
        set: async (ref: string, value: string): Promise<boolean> => {
          written.push({ ref, value });
          return true;
        },
      },
    },
  };
  // A test double, not the full host context. The double cast is honest about
  // that: behavior is asserted by the tests below, not by type overlap.
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  assert.equal(registrations.length, 1, "one slot entry");
  const [first] = registrations;
  assert.ok(first, "the card was registered");
  return { ...first, written, snapshot, listeners };
}

/** A store snapshot shaped like the one `SettingsFormModel.bind` publishes. */
function state(
  section: Record<string, unknown>,
  { writable = true }: { writable?: boolean } = {}
): TestState {
  const field = (value: unknown): TestField => {
    const text =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? String(value)
        : "";
    return {
      text,
      overridden: value !== undefined,
      invalid: false,
    };
  };
  const fields: Record<string, TestField> = {};
  for (const [name, value] of Object.entries(section)) {
    if (name !== "apiKeyEnv" && name !== "monidKeyEnv")
      fields[name] = field(value);
  }
  return {
    shell: {
      available: true,
      writable,
      dirty: false,
      invalid: false,
      saving: false,
      failed: false,
    },
    fields,
    keys: {
      direct: { text: "", named: false, ref: "TINYFISH_API_KEY" },
      monid: { text: "", named: false, ref: "MONID_API_KEY" },
    },
  };
}

/** Render the card's page view. */
function render(
  section: Record<string, unknown>,
  options: { writable?: boolean } = {}
): { edits: TestEdit[]; tree: unknown } {
  const { component } = mount(section);
  const edits: TestEdit[] = [];
  return {
    edits,
    tree: component({
      view: "page",
      t: (key: string): string => key,
      useTinyfishCard: (select: (state: TestState) => TestState) =>
        select(state(section, options)),
      edit: (name: string, value: string): void => {
        edits.push({ name, value });
      },
      resetField: (name: string): void => {
        edits.push({ name, value: undefined });
      },
      save: (): void => {},
      discard: (): void => {},
    }),
  };
}

test("the summary view is the one-line description", () => {
  const { component } = mount({});
  assert.equal(
    component({ view: "summary", t: (k: string): string => k }),
    "description"
  );
});

test("the page renders a form frame, not the summary", () => {
  const { tree } = render({});
  assert.equal(findAll(tree, "SettingsForm").length, 1);
});

test("the channel is a segmented control carrying both options", () => {
  const control = firstOf(render({}).tree, "SegmentedControl");
  assert.ok(control, "a segmented control for the channel");
  assert.deepEqual(
    seg(control).options.map((option: { value: string }) => option.value),
    ["direct", "monid"]
  );
  assert.equal(seg(control).value, "direct", "the default");
  assert.equal(
    seg(firstOf(render({ channel: "monid" }).tree, "SegmentedControl")).value,
    "monid",
    "and the drafted value"
  );
});

test("choosing a channel stages that channel", () => {
  const { tree, edits } = render({});
  seg(firstOf(tree, "SegmentedControl")).onChange("monid");
  assert.deepEqual(edits, [{ name: "channel", value: "monid" }]);
});

test("search and fetch are switches, on by default", () => {
  const switches = findAll(render({}).tree, "Switch");
  assert.equal(switches.length, 2);
  for (const control of switches) assert.equal(sw(control).checked, true);
});

test("a switch stages the literal the schema parses", () => {
  const { tree, edits } = render({});
  const [search] = findAll(tree, "Switch");
  assert.ok(search, "one switch rendered");
  sw(search).onChange(false);
  assert.deepEqual(edits, [{ name: "search", value: "false" }]);
});

test("switching a channel back off stages the same", () => {
  const { tree, edits } = render({ search: "false" });
  const [search] = findAll(tree, "Switch");
  assert.ok(search, "one switch rendered");
  assert.equal(sw(search).checked, false, "reads the drafted value");
  sw(search).onChange(true);
  assert.deepEqual(edits, [{ name: "search", value: "true" }]);
});

test("purpose is a search-only field and hides when search is off", () => {
  const idsOf = (tree: unknown): string[] =>
    findAll(tree, "SettingsValueField").map((field) => fld(field).id);
  assert.ok(
    idsOf(render({ search: "true" }).tree).includes(
      "plugin-config-tinyfish-purpose"
    )
  );
  assert.ok(
    !idsOf(render({ search: "false" }).tree).includes(
      "plugin-config-tinyfish-purpose"
    )
  );
});

test("attempts stay visible regardless of the switches", () => {
  const idsOf = (tree: unknown): string[] =>
    findAll(tree, "SettingsValueField").map((field) => fld(field).id);
  // The title says "regardless", so every switch combination is rendered, and
  // the count is exact: `includes` was satisfied by a single render and blind
  // to a duplicate, while zero — the control hiding the way purpose hides — is
  // the regression this test exists to name.
  const attempts = "plugin-config-tinyfish-attempts";
  for (const section of [
    {},
    { search: "false" },
    { fetch: "false" },
    { search: "false", fetch: "false" },
  ]) {
    const shown = idsOf(render(section).tree).filter(
      (id) => id === attempts
    ).length;
    assert.equal(
      shown,
      1,
      `${JSON.stringify(section)}: attempts renders exactly once`
    );
  }
});

test("the both-off warning appears only when both are off", () => {
  const has = (section: Record<string, unknown>): boolean =>
    texts(render(section).tree).includes("bothOff");
  assert.equal(has({}), false, "not on by default");
  assert.equal(has({ search: "false" }), false, "not with one off");
  assert.equal(has({ search: "false", fetch: "false" }), true, "with both off");
});

test("every control is disabled when the section is not writable", () => {
  const { tree } = render({}, { writable: false });
  for (const control of [
    ...findAll(tree, "SegmentedControl"),
    ...findAll(tree, "Switch"),
    ...findAll(tree, "SettingsSecretField"),
    ...findAll(tree, "SettingsValueField"),
  ]) {
    assert.equal(control.props.disabled, true, "and stays disabled");
  }
  assert.equal(
    findAll(tree, "button").length,
    0,
    "with no reset control offered on a read-only section"
  );
});

test("an overridden text field offers its reset through the field itself", () => {
  // `SettingsValueField` owns its reset control, so the card hands it the
  // action rather than rendering a button of its own.
  const { tree, edits } = render({ attempts: 5 });
  const field = findAll(tree, "SettingsValueField").find(
    (one) => fld(one).id === "plugin-config-tinyfish-attempts"
  );
  assert.ok(field, "the attempts field rendered");
  assert.equal(fld(field).overridden, true, "and it says it is overridden");
  fld(field).onReset();
  assert.deepEqual(edits, [{ name: "attempts", value: undefined }]);
});

test("an overridden custom control offers a reset button", () => {
  // The segmented control and the switches are ours, so the reset is ours too —
  // otherwise an overridden value on one of them would be stuck.
  const { tree, edits } = render({ channel: "monid" });
  const [button] = findAll(tree, "button");
  assert.ok(button, "a reset control next to the segmented control");
  btn(button).onClick();
  assert.deepEqual(edits, [{ name: "channel", value: undefined }]);
});

test("an untouched control offers no reset", () => {
  assert.equal(findAll(render({}).tree, "button").length, 0);
});

test("the direct channel shows the TinyFish key field", () => {
  const secret = firstOf(render({}).tree, "SettingsSecretField");
  assert.equal(sec(secret).id, "plugin-config-tinyfish-apiKey");
  assert.equal(sec(secret).label, "apiKey");
});

test("the monid channel shows the platform key field", () => {
  const secrets = findAll(
    render({ channel: "monid" }).tree,
    "SettingsSecretField"
  );
  const secret = nth(secrets, 0, "secret field");
  assert.equal(sec(secret).id, "plugin-config-tinyfish-monidApiKey");
  assert.equal(sec(secret).label, "monidApiKey");
});

test("exactly one key field renders, never both", () => {
  for (const section of [{}, { channel: "monid" }, { channel: "direct" }]) {
    assert.equal(
      findAll(render(section).tree, "SettingsSecretField").length,
      1,
      `one key field for ${JSON.stringify(section)}`
    );
  }
});

test("the direct key writes to the reference the section names", async () => {
  // Driven through the real `SettingsFormModel`, because that is where the
  // write is decided: the slot entry's `inject()` hands the card the model's
  // own actions, so staging and saving here is the same path the UI takes.
  const { component, entry, written } = mount({ apiKeyEnv: "MY_TINYFISH" });
  const { edit, save } = entry.inject();
  const tree = component({
    view: "page",
    t: (k: string): string => k,
    useTinyfishCard: (select: (state: TestState) => TestState) =>
      select(state({})),
    edit,
    resetField: entry.inject().resetField,
    save,
    discard: entry.inject().discard,
  });
  sec(firstOf(tree, "SettingsSecretField")).onEdit("typed-key");
  assert.deepEqual(written, [], "staging is not writing");
  await save();
  assert.deepEqual(
    written,
    [{ ref: "MY_TINYFISH", value: "typed-key" }],
    "and the save lands on the reference the section named"
  );
});

test("the monid key writes to its own reference, not the direct one", async () => {
  const { component, entry, written } = mount({
    channel: "monid",
    apiKeyEnv: "TINYFISH_API_KEY",
    monidKeyEnv: "MY_PLATFORM",
  });
  const { edit, save } = entry.inject();
  const tree = component({
    view: "page",
    t: (k: string): string => k,
    useTinyfishCard: (select: (state: TestState) => TestState) =>
      select(state({ channel: "monid" })),
    edit,
    resetField: entry.inject().resetField,
    save,
    discard: entry.inject().discard,
  });
  sec(firstOf(tree, "SettingsSecretField")).onEdit("platform-key");
  await save();
  assert.deepEqual(
    written,
    [{ ref: "MY_PLATFORM", value: "platform-key" }],
    "the two references do not collide"
  );
});

test("an unconfigured section still writes to a resolvable default", async () => {
  // A blank `apiKeyEnv` means "use the provider's default", so the reference
  // the form writes has to be the one the provider reads. If these two drift,
  // a key is stored somewhere nothing looks.
  const { component, entry, written } = mount({ apiKeyEnv: "" });
  const { edit, save } = entry.inject();
  const tree = component({
    view: "page",
    t: (k: string): string => k,
    useTinyfishCard: (select: (state: TestState) => TestState) =>
      select(state({})),
    edit,
    resetField: entry.inject().resetField,
    save,
    discard: entry.inject().discard,
  });
  sec(firstOf(tree, "SettingsSecretField")).onEdit("k");
  await save();
  // And the reference it wrote to is the one the provider will read back,
  // read from the provider itself rather than from a second copy of the name.
  assert.equal(nth(written, 0, "write").ref, "TINYFISH_API_KEY");
  assert.equal(
    resolveOptions({ apiKeyEnv: "" }).apiKeyEnv,
    nth(written, 0, "write").ref,
    "the form's fallback and the provider's fallback are the same reference"
  );
});

test("a draft the field cannot parse blocks the save instead of vanishing", async () => {
  // The switch only ever writes "true" / "false", so this is the belt to that
  // braces: a hand-edited or restored value that the spec rejects must keep its
  // text and stop the save, not be silently discarded on write.
  const { component, entry, written } = mount({});
  const injected = entry.inject();
  const tree = component({
    view: "page",
    t: (k: string): string => k,
    useTinyfishCard: (select: (state: TestState) => TestState) =>
      select(state({})),
    edit: injected.edit,
    resetField: injected.resetField,
    save: injected.save,
    discard: injected.discard,
  });
  injected.edit("search", "yes");
  const reread = component({
    view: "page",
    t: (k: string): string => k,
    useTinyfishCard: (select: (state: TestState) => TestState) =>
      select(state({ search: "yes" })),
    edit: injected.edit,
    resetField: injected.resetField,
    save: injected.save,
    discard: injected.discard,
  });
  const switchNode = firstOf(reread, "Switch");
  assert.equal(
    switchNode.props.checked,
    true,
    "an unparseable draft is not false"
  );
  void tree;
  assert.equal(await injected.save(), false, "and the save is refused");
  assert.deepEqual(written, [], "with nothing written");
});

test("a parseable boolean draft saves", async () => {
  const { entry, written } = mount({});
  const injected = entry.inject();
  injected.edit("fetch", "FALSE");
  assert.equal(await injected.save(), true);
  assert.deepEqual(Object.keys(written), [], "a boolean writes no credential");
});

test("the status falls back to defaults when a key entry is missing", () => {
  // The store always publishes both entries, so this guards the shape rather
  // than a reachable state — but a shape the card assumes and the store stops
  // providing would otherwise render "undefined" into the page. Only the
  // selected channel's line renders (here: the default, direct).
  const { component } = mount({});
  const tree = component({
    view: "page",
    t: (key: string): string => key,
    useTinyfishCard: (select: (state: TestState) => TestState) =>
      select({
        shell: {
          available: true,
          writable: true,
          dirty: false,
          invalid: false,
          saving: false,
          failed: false,
        },
        fields: {},
        keys: {},
      }),
    edit: () => {},
    resetField: () => {},
    save: async () => true,
    discard: () => {},
  });
  const all = texts(tree).join(" ");
  assert.ok(all.includes("TINYFISH_API_KEY"), "direct falls back");
  assert.ok(
    !all.includes("MONID_API_KEY"),
    "the unselected channel stays out of the status line"
  );
});

test("a configured monid key reads as set", () => {
  const { component } = mount({ channel: "monid" });
  const tree = component({
    view: "page",
    t: (key: string): string => key,
    useTinyfishCard: (select: (state: TestState) => TestState) =>
      select({
        shell: {
          available: true,
          writable: true,
          dirty: false,
          invalid: false,
          saving: false,
          failed: false,
        },
        fields: {
          channel: { text: "monid", overridden: false, invalid: false },
        },
        keys: {
          direct: { text: "", named: false, ref: "TINYFISH_API_KEY" },
          monid: { text: "", named: true, ref: "MY_PLATFORM" },
        },
      }),
    edit: () => {},
    resetField: () => {},
    save: async () => true,
    discard: () => {},
  });
  const all = texts(tree).join(" ");
  assert.ok(all.includes("MY_PLATFORM"), "names the custom reference");
});

test("only the selected channel's status shows", () => {
  // The status line names one reference: the secret field below already badges
  // the selected channel's state, so repeating the other channel read as a
  // second field that was never going to render.
  const { tree } = render({});
  const all = texts(tree).join(" ");
  assert.ok(all.includes("TINYFISH_API_KEY"), "names the direct reference");
  assert.ok(
    !all.includes("MONID_API_KEY"),
    "and not the unselected monid reference"
  );
});

test("the monid channel's status names the monid reference", () => {
  const { component } = mount({ channel: "monid" });
  const tree = component({
    view: "page",
    t: (key: string): string => key,
    useTinyfishCard: (select: (state: TestState) => TestState) =>
      select(state({ channel: "monid" })),
    edit: () => {},
    resetField: () => {},
    save: (): void => {},
    discard: (): void => {},
  });
  const all = texts(tree).join(" ");
  assert.ok(all.includes("MONID_API_KEY"), "names the monid reference");
  assert.ok(
    !all.includes("TINYFISH_API_KEY"),
    "and not the unselected direct reference"
  );
});

test("credentials.describe marks configured keys as set in the UI", async () => {
  const describeCalls: string[][] = [];
  const { entry } = mount(
    { channel: "direct" },
    {
      describe: async (refs) => {
        describeCalls.push(refs);
        return {
          ok: true,
          value: {
            TINYFISH_API_KEY: { configured: true, writable: true },
            MONID_API_KEY: { configured: false, writable: true },
          },
        };
      },
    }
  );
  await Promise.resolve();
  assert.equal(describeCalls.length, 1);
  assert.deepEqual(describeCalls[0], ["TINYFISH_API_KEY", "MONID_API_KEY"]);
  const injected = entry.inject() as unknown as {
    hooks: {
      tinyfishCard: (
        select: (s: { keys: { direct: { named: boolean } } }) => {
          keys: { direct: { named: boolean } };
        }
      ) => { keys: { direct: { named: boolean } } };
    };
  };
  const cardState = injected.hooks.tinyfishCard(
    (s: { keys: { direct: { named: boolean } } }) => s
  );
  assert.equal(
    cardState.keys.direct.named,
    true,
    "configured direct key is set"
  );
});

test("credentials/reference-updated invalidation re-reads credentials", async () => {
  let callCount = 0;
  const { listeners } = mount(
    {},
    {
      describe: async () => {
        callCount += 1;
        return {
          ok: true,
          value: {
            TINYFISH_API_KEY: { configured: true, writable: true },
            MONID_API_KEY: { configured: false, writable: true },
          },
        };
      },
    }
  );
  await Promise.resolve();
  assert.equal(callCount, 1);
  const onInvalidate = listeners["credentials/reference-updated"]?.[0];
  assert.ok(onInvalidate, "listener registered");
  onInvalidate();
  await Promise.resolve();
  assert.equal(callCount, 2, "re-read credentials after invalidation");
});
