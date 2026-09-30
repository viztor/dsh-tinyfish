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

/** Element type as a comparable name. */
function nameOf(type) {
  if (typeof type === "string") return type;
  if (typeof type === "function") return type.name || "fn";
  return String(type);
}

/** Every element of `type` in the tree, depth-first through props.children. */
function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (nameOf(node.type) === type) acc.push(node);
  const { children } = node.props ?? {};
  if (Array.isArray(children)) {
    for (const child of children) findAll(child, type, acc);
  } else if (children !== undefined) findAll(children, type, acc);
  return acc;
}

/** The text of every string child anywhere in the tree. */
function texts(node, acc = []) {
  if (typeof node === "string") {
    acc.push(node);
    return acc;
  }
  if (!node || typeof node !== "object") return acc;
  const { children } = node.props ?? {};
  if (Array.isArray(children)) {
    for (const child of children) texts(child, acc);
  } else if (children !== undefined) texts(children, acc);
  return acc;
}

/**
 * Mount the page and hand back the card it registered.
 *
 * @param section - the accepted section, as the Host would publish it.
 * @returns the registered component, plus the credential refs it writes to.
 */
function mount(section = {}) {
  const written = [];
  const registrations = [];
  const snapshot = {
    status: "ready",
    value: section,
    base: {},
    user: {},
    writable: true,
    revision: 1,
  };
  const ctx = {
    effect: (body) => {
      const disposer = body();
      if (typeof disposer === "function") disposer();
    },
    locale: { bind: () => (key) => key, register: () => {} },
    configForms: {
      get: () => ({
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        mutate: async () => true,
      }),
      whileServed: (namespaces, register) => register(new Set(namespaces)),
    },
    slots: {
      inject: (slot, register) => register(),
      register: (entry, component) => {
        registrations.push({ entry, component });
      },
    },
    remote: {
      $on: () => () => {},
      credentials: {
        set: async (ref, value) => {
          written.push({ ref, value });
          return true;
        },
      },
    },
  };
  apply(ctx);
  assert.equal(registrations.length, 1, "one slot entry");
  return { ...registrations[0], written, snapshot };
}

/** A store snapshot shaped like the one `SettingsFormModel.bind` publishes. */
function state(section, { writable = true } = {}) {
  const field = (value) => ({
    text: value === undefined ? "" : String(value),
    overridden: value !== undefined,
    invalid: false,
  });
  const fields = {};
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
      direct: { text: "", named: false },
      monid: { text: "", named: false },
    },
  };
}

/** Render the card's page view. */
function render(section, options = {}) {
  const { component } = mount(section);
  const edits = [];
  return {
    edits,
    tree: component({
      view: "page",
      t: (key) => key,
      useTinyfishCard: (select) => select(state(section, options)),
      edit: (name, value) => edits.push({ name, value }),
      resetField: (name) => edits.push({ name, value: undefined }),
      save: () => {},
      discard: () => {},
    }),
  };
}

test("the summary view is the one-line description", () => {
  const { component } = mount({});
  assert.equal(component({ view: "summary", t: (k) => k }), "description");
});

test("the page renders a form frame, not the summary", () => {
  const { tree } = render({});
  assert.equal(findAll(tree, "SettingsForm").length, 1);
});

test("the channel is a segmented control carrying both options", () => {
  const control = findAll(render({}).tree, "SegmentedControl")[0];
  assert.ok(control, "a segmented control for the channel");
  assert.deepEqual(
    control.props.options.map((option) => option.value),
    ["direct", "monid"]
  );
  assert.equal(control.props.value, "direct", "the default");
  assert.equal(
    findAll(render({ channel: "monid" }).tree, "SegmentedControl")[0].props
      .value,
    "monid",
    "and the drafted value"
  );
});

test("choosing a channel stages that channel", () => {
  const { tree, edits } = render({});
  findAll(tree, "SegmentedControl")[0].props.onChange("monid");
  assert.deepEqual(edits, [{ name: "channel", value: "monid" }]);
});

test("search and fetch are switches, on by default", () => {
  const switches = findAll(render({}).tree, "Switch");
  assert.equal(switches.length, 2);
  for (const control of switches) assert.equal(control.props.checked, true);
});

test("a switch stages the literal the schema parses", () => {
  const { tree, edits } = render({});
  const [search] = findAll(tree, "Switch");
  search.props.onChange(false);
  assert.deepEqual(edits, [{ name: "search", value: "false" }]);
});

test("switching a channel back off stages the same", () => {
  const { tree, edits } = render({ search: "false" });
  const [search] = findAll(tree, "Switch");
  assert.equal(search.props.checked, false, "reads the drafted value");
  search.props.onChange(true);
  assert.deepEqual(edits, [{ name: "search", value: "true" }]);
});

test("purpose is a search-only field and hides when search is off", () => {
  const idsOf = (tree) =>
    findAll(tree, "SettingsValueField").map((field) => field.props.id);
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
  const idsOf = (tree) =>
    findAll(tree, "SettingsValueField").map((field) => field.props.id);
  assert.ok(
    idsOf(render({ search: "false", fetch: "false" }).tree).includes(
      "plugin-config-tinyfish-attempts"
    )
  );
});

test("the both-off warning appears only when both are off", () => {
  const has = (section) => texts(render(section).tree).includes("bothOff");
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
    (one) => one.props.id === "plugin-config-tinyfish-attempts"
  );
  assert.equal(field.props.overridden, true, "and it says it is overridden");
  field.props.onReset();
  assert.deepEqual(edits, [{ name: "attempts", value: undefined }]);
});

test("an overridden custom control offers a reset button", () => {
  // The segmented control and the switches are ours, so the reset is ours too —
  // otherwise an overridden value on one of them would be stuck.
  const { tree, edits } = render({ channel: "monid" });
  const [button] = findAll(tree, "button");
  assert.ok(button, "a reset control next to the segmented control");
  button.props.onClick();
  assert.deepEqual(edits, [{ name: "channel", value: undefined }]);
});

test("an untouched control offers no reset", () => {
  assert.equal(findAll(render({}).tree, "button").length, 0);
});

test("the direct channel shows the TinyFish key field", () => {
  const secret = findAll(render({}).tree, "SettingsSecretField")[0];
  assert.equal(secret.props.id, "plugin-config-tinyfish-apiKey");
  assert.equal(secret.props.label, "apiKey");
});

test("the monid channel shows the platform key field", () => {
  const secret = findAll(
    render({ channel: "monid" }).tree,
    "SettingsSecretField"
  )[0];
  assert.equal(secret.props.id, "plugin-config-tinyfish-monidApiKey");
  assert.equal(secret.props.label, "monidApiKey");
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
    t: (k) => k,
    useTinyfishCard: (select) => select(state({})),
    edit,
    resetField: entry.inject().resetField,
    save,
    discard: entry.inject().discard,
  });
  findAll(tree, "SettingsSecretField")[0].props.onEdit("typed-key");
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
    t: (k) => k,
    useTinyfishCard: (select) => select(state({ channel: "monid" })),
    edit,
    resetField: entry.inject().resetField,
    save,
    discard: entry.inject().discard,
  });
  findAll(tree, "SettingsSecretField")[0].props.onEdit("platform-key");
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
    t: (k) => k,
    useTinyfishCard: (select) => select(state({})),
    edit,
    resetField: entry.inject().resetField,
    save,
    discard: entry.inject().discard,
  });
  findAll(tree, "SettingsSecretField")[0].props.onEdit("k");
  await save();
  // And the reference it wrote to is the one the provider will read back,
  // read from the provider itself rather than from a second copy of the name.
  assert.equal(written[0].ref, "TINYFISH_API_KEY");
  assert.equal(
    resolveOptions({ apiKeyEnv: "" }).apiKeyEnv,
    written[0].ref,
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
    t: (k) => k,
    useTinyfishCard: (select) => select(state({})),
    edit: injected.edit,
    resetField: injected.resetField,
    save: injected.save,
    discard: injected.discard,
  });
  injected.edit("search", "yes");
  const reread = component({
    view: "page",
    t: (k) => k,
    useTinyfishCard: (select) => select(state({ search: "yes" })),
    edit: injected.edit,
    resetField: injected.resetField,
    save: injected.save,
    discard: injected.discard,
  });
  const switchNode = findAll(reread, "Switch")[0];
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
