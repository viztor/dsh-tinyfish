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
  label: string;
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
  hint: string;
  stateLabel: string;
  configured: boolean;
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
 * The secret field for one channel's draft, found by the id the card gives it.
 *
 * `firstOf()` was enough while one field rendered — and became a trap when
 * both did: it returns the TinyFish field for every query, so an assertion
 * written against the Monid field would have been checked against the other
 * one and passed.
 *
 * @param tree - the rendered card.
 * @param name - the field name the card puts in the id.
 * @returns that field's props, or a failure naming the one that is missing.
 */
function secretBy(tree: unknown, name: string): SecretProps {
  const found = findAll(tree, "SettingsSecretField").find(
    (node) => sec(node).id === `plugin-config-tinyfish-${name}`
  );
  assert.ok(found, `expected the ${name} key field in the tree`);
  return sec(found);
}

/**
 * The combined description line under the direct key field, where the
 * TinyFish reference lives now that it shares a line with the sign-up link.
 * The field's own hint is empty by design (it renders zero-height), so the
 * reference is read here instead of off the field's props.
 */
function signupLine(tree: unknown): TestElement {
  const found = findAll(tree, "p").find(
    (node) => node.props.className === "dsh-tf-signup"
  );
  assert.ok(found, "expected the sign-up line under the TinyFish field");
  return found;
}

/**
 * Everything the card says about the credential, joined.
 *
 * Not the same as `texts()` alone: `label`, `stateLabel` and `hint` are
 * arguments handed to `SettingsSecretField`, not text nodes, so a test that
 * only walks children measures the card against a subset of itself. It read
 * as correct for as long as the reference also happened to sit in a
 * paragraph of its own, and went blind the moment it did not.
 *
 * Every field's props, not the first one's: with both channels on screen,
 * quoting one hint and checking it against both would make the other
 * channel's reference unaccounted for.
 */
function spoken(tree: unknown): string {
  const secrets = findAll(tree, "SettingsSecretField").flatMap((node) => {
    const { label, stateLabel, hint } = sec(node);
    return [label, stateLabel, hint];
  });
  return [...texts(tree), ...secrets].join(" ");
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
  dictionaries:
    | { en: Record<string, string>; zh: Record<string, string> }
    | undefined;
} {
  // Typed as the page's own context: a drift between what the test provides
  // and what the page consumes is a type error here, not a silent mismatch.

  const written: TestWrite[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  let dictionaries:
    | { en: Record<string, string>; zh: Record<string, string> }
    | undefined;
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
      ): void => {
        dictionaries = _dictionaries as {
          en: Record<string, string>;
          zh: Record<string, string>;
        };
      },
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
  return { ...first, written, snapshot, listeners, dictionaries };
}

/** A store snapshot shaped like the one `SettingsFormModel.bind` publishes. */
function state(
  section: Record<string, unknown>,
  {
    writable = true,
    configured = false,
  }: { writable?: boolean; configured?: boolean } = {}
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
      direct: { text: "", named: configured, ref: "TINYFISH_API_KEY" },
      monid: { text: "", named: false, ref: "MONID_API_KEY" },
    },
  };
}

/** Render the card's page view. */
function render(
  section: Record<string, unknown>,
  options: { writable?: boolean; configured?: boolean } = {}
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

test("search and fetch share one labelled row", () => {
  // One row states the rule once and names both tools it governs, instead of
  // two full-width rows repeating the same sentence with a different tool
  // name in it. The heading says Provide — the switches decide whether
  // TinyFish answers each tool, not whether the tool exists.
  const { tree } = render({});
  const groups = findAll(tree, "div").filter(
    (node) => node.props.role === "group"
  );
  assert.equal(groups.length, 1, "exactly one labelled group");
  const group = groups[0];
  assert.ok(group, "the provide row rendered");
  assert.equal(
    group.props["aria-labelledby"],
    "plugin-config-tinyfish-provide",
    "pointed at the row's own heading, not a second copy of it"
  );
  const switches = findAll(group, "Switch");
  const [first, second] = switches;
  assert.ok(first, "the search switch is inside the row");
  assert.ok(second, "the fetch switch is inside the row");
  assert.equal(sw(first).label, "search", "search first");
  assert.equal(sw(second).label, "fetch", "fetch second");
  assert.equal(
    findAll(tree, "Switch").length,
    switches.length,
    "and every switch on the card is in that one row"
  );
  const copy = texts(group).join(" ");
  assert.ok(copy.includes("searchName"), "the row names web_search");
  assert.ok(copy.includes("fetchName"), "and names web_fetch");
  assert.ok(
    texts(tree).join(" ").includes("provideHint"),
    "and the card states the rule under it"
  );
  const heading = findAll(tree, "span").find(
    (node) => node.props.id === group.props["aria-labelledby"]
  );
  assert.ok(heading, "the heading the group points at rendered");
  assert.ok(
    texts(heading).join(" ").includes("provide"),
    "and it is the row's own Provide, not a copy inside it"
  );
});

test("the provide row is the first row on the card", () => {
  // Whether TinyFish answers at all outranks which channel it would use,
  // which key it would send, and how it would tune the results — so the pair
  // sits above channel, keys, purpose and attempts, not buried at the bottom.
  const { tree } = render({});
  const form = firstOf(tree, "SettingsForm");
  const children: unknown = form.props.children;
  assert.ok(Array.isArray(children), "the form renders its rows in order");
  const rows = children as unknown[];
  const indexOf = (type: string): number =>
    rows.findIndex((row) => findAll(row, type).length > 0);
  const switchesAt = indexOf("Switch");
  const channelAt = indexOf("SegmentedControl");
  assert.ok(switchesAt >= 0, "the provide row rendered");
  assert.ok(channelAt >= 0, "the channel row rendered");
  assert.ok(
    switchesAt < channelAt,
    "the switches come before the channel picker"
  );
});

test("the provide hint does not promise a fallthrough", () => {
  // A switch that is off reports the kind unavailable while the provider
  // stays registered — and when the profile still points that tool at
  // TinyFish, `dsh-web` fails the call instead of falling through. The old
  // hint promised the fallthrough unconditionally, which is exactly wrong in
  // the pinned case.
  const { dictionaries } = mount({});
  assert.ok(dictionaries, "the page registered its copy");
  const en = dictionaries.en.provideHint;
  const zh = dictionaries.zh.provideHint;
  assert.ok(typeof en === "string", "English states the rule");
  assert.ok(typeof zh === "string", "Chinese states the rule");
  assert.ok(en.includes("TinyFish"), "English names who declines");
  assert.ok(zh.includes("TinyFish"), "Chinese names who declines");
  assert.ok(
    en.includes("searchProvider"),
    "English names the selection that decides the outcome"
  );
  assert.ok(
    zh.includes("searchProvider"),
    "Chinese names the selection that decides the outcome"
  );
  assert.ok(
    !en.includes("that tool falls through"),
    "English never promises the old silent fallthrough"
  );
  assert.ok(
    !zh.includes("对应工具会转由"),
    "Chinese never promises the old silent fallthrough"
  );
  assert.ok(
    en.includes("instead of falling through"),
    "the English copy says what happens instead"
  );
  assert.ok(
    zh.includes("而不会转由其他提供方处理"),
    "and so does the Chinese copy"
  );
});

test("purpose is a fetch-only field and hides when fetch is off", () => {
  // `purpose` rides the fetch request, not search (`tinyfishFetch` takes it;
  // `tinyfishSearch` does not), so it follows the fetch switch. The old gate
  // read `searchOn`, which hid the field in exactly the state that needed it
  // (search off, fetch on) and showed it where nothing consumed it.
  const idsOf = (tree: unknown): string[] =>
    findAll(tree, "SettingsValueField").map((field) => fld(field).id);
  assert.ok(
    idsOf(render({}).tree).includes("plugin-config-tinyfish-purpose"),
    "both on: purpose shows"
  );
  assert.ok(
    idsOf(render({ search: "false" }).tree).includes(
      "plugin-config-tinyfish-purpose"
    ),
    "search off, fetch on: purpose still shows"
  );
  assert.ok(
    !idsOf(render({ fetch: "false" }).tree).includes(
      "plugin-config-tinyfish-purpose"
    ),
    "fetch off: purpose hides"
  );
  assert.ok(
    !idsOf(render({ search: "false", fetch: "false" }).tree).includes(
      "plugin-config-tinyfish-purpose"
    ),
    "both off: purpose hides with the rest of the shared config"
  );
});

test("the shared config hides only when both providers are off", () => {
  // One channel, both keys, and the tuning fields serve whichever kind is
  // on, so the block hides only when nothing answers. The provide row stays
  // visible throughout — it is the way back on.
  const configOf = (tree: unknown): { channel: number; keys: number } => ({
    channel: findAll(tree, "SegmentedControl").length,
    keys: findAll(tree, "SettingsSecretField").length,
  });
  assert.deepEqual(
    configOf(render({}).tree),
    { channel: 1, keys: 2 },
    "both on: channel and both keys show"
  );
  assert.deepEqual(
    configOf(render({ search: "false" }).tree),
    { channel: 1, keys: 2 },
    "search off, fetch on: shared config stays"
  );
  assert.deepEqual(
    configOf(render({ fetch: "false" }).tree),
    { channel: 1, keys: 2 },
    "fetch off, search on: shared config stays"
  );
  assert.deepEqual(
    configOf(render({ search: "false", fetch: "false" }).tree),
    { channel: 0, keys: 0 },
    "both off: channel and keys hide"
  );
  assert.equal(
    findAll(render({ search: "false", fetch: "false" }).tree, "Switch").length,
    2,
    "both off: the two switches stay visible"
  );
});

test("attempts show whenever either provider is on", () => {
  const idsOf = (tree: unknown): string[] =>
    findAll(tree, "SettingsValueField").map((field) => fld(field).id);
  // Exact counts: `includes` was satisfied by a single render and blind to a
  // duplicate, while zero — the control hiding — is the regression this test
  // exists to name.
  const attempts = "plugin-config-tinyfish-attempts";
  for (const section of [{}, { search: "false" }, { fetch: "false" }]) {
    const shown = idsOf(render(section).tree).filter(
      (id) => id === attempts
    ).length;
    assert.equal(
      shown,
      1,
      `${JSON.stringify(section)}: attempts renders exactly once`
    );
  }
  assert.equal(
    idsOf(render({ search: "false", fetch: "false" }).tree).filter(
      (id) => id === attempts
    ).length,
    0,
    `{"search":"false","fetch":"false"}: attempts hide with the shared config`
  );
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

test("an overridden switch resets itself, not its neighbour", () => {
  // The two switches share one row now, so their reset controls sit two
  // elements apart. Each must still reset the field it belongs to, or an
  // operator clearing one override silently clears the other one's.
  const only = render({ fetch: "false" });
  const [one] = findAll(only.tree, "button");
  assert.ok(one, "just the overridden switch offers a reset");
  btn(one).onClick();
  assert.deepEqual(only.edits, [{ name: "fetch", value: undefined }]);

  const both = render({ search: "true", fetch: "false" });
  const buttons = findAll(both.tree, "button");
  assert.equal(buttons.length, 2, "one reset per overridden switch");
  const [searchReset, fetchReset] = buttons;
  assert.ok(searchReset, "search's reset rendered");
  assert.ok(fetchReset, "fetch's reset rendered");
  btn(searchReset).onClick();
  btn(fetchReset).onClick();
  assert.deepEqual(
    both.edits,
    [
      { name: "search", value: undefined },
      { name: "fetch", value: undefined },
    ],
    "each button resets the switch it sits beside"
  );
});

test("an untouched control offers no reset", () => {
  assert.equal(findAll(render({}).tree, "button").length, 0);
});

test("the TinyFish key field names the service it authenticates", () => {
  const secret = secretBy(render({}).tree, "apiKey");
  assert.equal(secret.id, "plugin-config-tinyfish-apiKey");
  assert.equal(secret.label, "apiKey");
});

test("the Monid key field names the service it authenticates", () => {
  const secret = secretBy(render({ channel: "monid" }).tree, "monidApiKey");
  assert.equal(secret.id, "plugin-config-tinyfish-monidApiKey");
  assert.equal(secret.label, "monidApiKey");
});

test("both key fields render, whatever channel is selected", () => {
  // They used to hide behind the channel switch, which made a live setting
  // double as the only route to the key you were not currently using: to set
  // a Monid key while Direct was in use you had to stage a channel change
  // you did not want, type into it, and stage it back.
  for (const section of [{}, { channel: "monid" }, { channel: "direct" }]) {
    const ids = findAll(render(section).tree, "SettingsSecretField").map(
      (node) => sec(node).id
    );
    assert.deepEqual(
      ids,
      ["plugin-config-tinyfish-apiKey", "plugin-config-tinyfish-monidApiKey"],
      `both fields for ${JSON.stringify(section)}`
    );
  }
});

test("the card links out to where a key comes from, safely", () => {
  // The field above it stores a credential the user has to obtain somewhere,
  // and this is where the card says how. It must open in a new tab: the page
  // holds staged drafts, so navigating away in the same tab would discard
  // every edit the user had not saved yet.
  const { tree } = render({});
  const [link] = findAll(tree, "a");
  assert.ok(link, "the card offers a way to get a key");
  const href = String(link.props.href);
  assert.match(
    href,
    /^https:\/\/agent\.tinyfish\.ai\/sign-up\?ref=v1\./,
    "pointing at the referral sign-up rather than the bare site"
  );
  assert.equal(link.props.target, "_blank", "opening in a new tab");
  assert.equal(
    link.props.rel,
    "noreferrer noopener",
    "with the referrer suppressed and the opener severed"
  );
  assert.ok(
    texts(link).join(" ").includes("getKey"),
    "labelled from the dictionary, not a literal in the component"
  );

  // Both dictionaries carry the label, or the card renders a bare key name.
  const { dictionaries } = mount({});
  assert.ok(dictionaries, "the page registered its copy");
  const en = dictionaries.en.getKey;
  const zh = dictionaries.zh.getKey;
  assert.ok(
    typeof en === "string" && en !== "",
    "English states what the link is for"
  );
  assert.ok(
    typeof zh === "string" && zh !== "",
    "and the Chinese copy does too"
  );
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
  secretBy(tree, "apiKey").onEdit("typed-key");
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
  secretBy(tree, "monidApiKey").onEdit("platform-key");
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
  // providing would otherwise render "undefined" into the page. Both fields
  // render, so both fallbacks are reachable here.
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
  const all = spoken(tree);
  assert.ok(all.includes("TINYFISH_API_KEY"), "direct falls back");
  assert.ok(all.includes("MONID_API_KEY"), "and so does monid");
  assert.ok(!all.includes("undefined"), "with no undefined in the copy");
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
  assert.equal(
    secretBy(tree, "monidApiKey").stateLabel,
    "apiKeySet",
    "the Monid field names its custom reference and reads as set"
  );
  assert.equal(
    secretBy(tree, "apiKey").stateLabel,
    "apiKeyUnset",
    "and the TinyFish field does not inherit that state"
  );
  assert.ok(spoken(tree).includes("MY_PLATFORM"), "the reference is spoken");
});

test("each key field names its own reference, and only its own", () => {
  // What the single-field layout was really defending: a reader must never
  // wonder which of the two saves where. Both fields on screen makes that
  // the whole contract. The Monid reference rides the field's own hint; the
  // TinyFish one rides the combined description line beneath its field — the
  // hint prop is a plain string, so sharing one line with the sign-up link is
  // only possible outside the primitive — and neither crosses over.
  const { tree } = render({});
  const signup = texts(signupLine(tree)).join(" ");
  assert.ok(
    signup.includes("TINYFISH_API_KEY"),
    "the TinyFish line names its own reference"
  );
  assert.ok(!signup.includes("MONID_API_KEY"), "and never the Monid one");
  const monid = secretBy(tree, "monidApiKey");
  assert.ok(
    monid.hint.includes("MONID_API_KEY"),
    "the Monid field names its own reference"
  );
  assert.ok(
    !monid.hint.includes("TINYFISH_API_KEY"),
    "and never the TinyFish one"
  );
});

test("switching the channel leaves both key fields exactly as they are", () => {
  // Selecting monid used to swap one reference out of the page and the other
  // in. Channel now only decides which channel a request is sent through, so
  // both fields say the same thing under either selection — and the field you
  // did not select no longer disappears while you are editing the other one.
  for (const section of [{}, { channel: "direct" }, { channel: "monid" }]) {
    const { tree } = render(section);
    const forWhat = JSON.stringify(section);
    assert.ok(
      texts(signupLine(tree)).join(" ").includes("TINYFISH_API_KEY"),
      `the TinyFish line names its reference for ${forWhat}`
    );
    assert.ok(
      secretBy(tree, "monidApiKey").hint.includes("MONID_API_KEY"),
      `the Monid field names its reference for ${forWhat}`
    );
  }
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

test("each key field states its state and its reference exactly once", () => {
  // The card used to print both above the field *and* inside it. The paragraph
  // said "A key is configured." and appended (TINYFISH_API_KEY); the field
  // below it printed the same sentence as its stateLabel tag and the same
  // reference as its hint — four of them in a card two hundred pixels tall.
  // SettingsSecretField renders stateLabel unconditionally, so the tag alone
  // carries the state, and the hint alone carries the reference.
  //
  // The control's copy has to be read off its PROPS as well as its children —
  // label, stateLabel and hint are arguments, not text nodes, and walking
  // texts() alone measured the paragraph against nothing and passed either
  // way. This test was plant-proved against the paragraph being put back, and
  // it failed only after the props joined the count.
  //
  // There are two fields now, so "exactly once" is counted two ways: each
  // field carries its own reference and its own state sentence, and the card
  // as a whole carries one state sentence per field — not one per channel plus
  // a paragraph repeating whichever channel is selected. The TinyFish
  // reference moved from its field's props onto the combined description
  // line; `spoken` already covers both — the secret fields' props and the
  // card's own paragraphs — so the card-wide count needs no second source.
  const count = (hay: string, needle: string): number =>
    hay.split(needle).length - 1;
  for (const configured of [false, true]) {
    const tree = render({}, { configured }).tree;
    const said = spoken(tree);
    assert.equal(
      count(said, "TINYFISH_API_KEY"),
      1,
      `configured=${configured}: the TinyFish reference is printed once`
    );
    assert.equal(
      count(said, "MONID_API_KEY"),
      1,
      `configured=${configured}: the Monid reference is printed once`
    );
    assert.equal(
      count(said, "apiKeySet") + count(said, "apiKeyUnset"),
      2,
      `configured=${configured}: one state sentence per field, no repeats`
    );
    const monid = secretBy(tree, "monidApiKey");
    const monidAlone = [monid.label, monid.stateLabel, monid.hint].join(" ");
    assert.equal(
      count(monidAlone, "MONID_API_KEY"),
      1,
      `configured=${configured}: the monidApiKey field states its own reference once`
    );
    assert.equal(
      count(monidAlone, "apiKeySet") + count(monidAlone, "apiKeyUnset"),
      1,
      `configured=${configured}: the monidApiKey field states its own state once`
    );
    // The TinyFish field's own hint is empty by design; its reference lives
    // on the combined line, and its state still lives on the field.
    const direct = secretBy(tree, "apiKey");
    const directAlone = [direct.label, direct.stateLabel, direct.hint].join(
      " "
    );
    assert.equal(
      count(directAlone, "apiKeySet") + count(directAlone, "apiKeyUnset"),
      1,
      `configured=${configured}: the apiKey field states its own state once`
    );
    assert.equal(
      count(texts(signupLine(tree)).join(" "), "TINYFISH_API_KEY"),
      1,
      `configured=${configured}: the TinyFish reference prints once, on its own line`
    );
  }
});
