/**
 * The client bundle, exercised the way the web client loads it.
 *
 * `lib/client.js` is not a module the page imports — it is a factory the page
 * hands a `require` to, and everything it does happens inside that call. So the
 * thing worth testing is the contract at that boundary: that the built artifact
 * calls `window.__ModuleLoader__.load` with the right id, that its factory
 * returns `NS` / `inject` / `apply`, that it asks the host for its dependencies
 * rather than bundling them, and that `apply` registers a `plugins.item` slot
 * gated on the Host serving the namespace.
 *
 * This does not render React — there is no DOM here — but it does execute the
 * shipped file, which is where a wrong wrapper or a wrong service name would
 * show up. A bundle that fails this would fail silently in the browser, because
 * the harness degrades to "this plugin is not loaded".
 *
 * Reads `lib/client.js`, so `pnpm run build` must have run.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "lib/client.js");

if (!existsSync(BUNDLE)) {
  throw new Error(
    "lib/client.js is missing — run `pnpm run build` before the tests"
  );
}

const SOURCE = readFileSync(BUNDLE, "utf8");

/**
 * Types for the VM fixtures in this file.
 *
 * The bundle is evaluated with `node:vm`, so everything crossing that
 * boundary arrives without static types: the registration spec the bundle
 * hands `window.__ModuleLoader__.load`, the module the factory returns, the
 * element tree the stubbed jsx records, and the store projection the bundle
 * hands the stub model. The interfaces below re-state the shapes the tests
 * assert on, so the test code itself is fully typed while each boundary
 * crossing is recovered with a documented `as` at the crossing point.
 */

/** What the bundle passes to `window.__ModuleLoader__.load`. */
interface RegistrationSpec {
  id: string;
  factory: (require: RequireStub) => BundleExports;
}

/** The `require` the loader hands the factory: answered by the stub below. */
type RequireStub = (name: string) => unknown;

/** The module shape every client bundle must export. */
interface BundleExports {
  NS: string;
  inject: string[];
  apply: (ctx: TestCtx) => void;
}

/** The stub host's `window`: only the module loader exists in the VM. */
interface WindowStub {
  __ModuleLoader__: {
    load: (spec: RegistrationSpec) => void;
  };
}

/** A field or secret reference the stub model records. */
interface FieldRef {
  field: string;
}

/** What the stub model's `field()` reports. */
interface FieldState {
  text: string;
  overridden: boolean;
  invalid: boolean;
}

/** One `new SettingsFormModel(scope, specs, secrets)` construction. */
interface ModelCall {
  specs: FieldRef[];
  secrets: FieldRef[];
}

/** One key entry per channel, as the store publishes it. */
interface CardKeys {
  direct: { text: string; named: boolean; ref: string };
  monid: { text: string; named: boolean; ref: string };
}

/**
 * The store projection the bundle hands the stub model's `bind`.
 *
 * It is created inside the evaluated bundle, so it is a cross-realm function;
 * the signature states what the published-state test reads back off it.
 */
type Projection = () => { keys: CardKeys };

/** What `loadBundle` hands back: the boundary values with their types. */
interface LoadedBundle {
  registration: RegistrationSpec;
  loaded: string[];
  modelCalls: ModelCall[];
  bindings: Projection[];
  exports: BundleExports;
}

/** One node the stubbed jsx records instead of rendering. */
interface StubElement {
  type: string;
  props: Record<string, unknown>;
  children: unknown[];
}

/** One field as the card reads it. */
interface CardFieldState {
  text: string;
  overridden: boolean;
  invalid: boolean;
}

/** The card's published state, as the stub store builds it. */
interface CardState {
  shell: {
    available: boolean;
    writable: boolean;
    dirty: boolean;
    invalid: boolean;
    saving: boolean;
    failed: boolean;
  };
  fields: Record<string, CardFieldState>;
  keys: CardKeys;
}

/** What the slot hands the card. */
interface CardProps {
  view: "page" | "summary";
  t: (key: string) => string;
  useTinyfishCard: (select: (state: CardState) => CardState) => CardState;
  edit: (field: string, text: string) => void;
  resetField: (field: string) => void;
  save: () => void;
  discard: () => void;
}

/** The card component the bundle registers. */
type CardComponent = (props: CardProps) => StubElement;

/** The slot entry the bundle registers: only what the tests read. */
interface SlotEntry {
  name: string;
  key: string;
  inject: () => unknown;
}

/** A form scope the stub config-forms domain hands out. */
interface FormScope {
  getSnapshot: () => {
    status: string;
    value: Record<string, unknown>;
    base: Record<string, unknown>;
    user: Record<string, unknown>;
    writable: boolean;
    revision: number;
  };
  subscribe: () => () => void;
  mutate: () => Promise<boolean>;
}

/** The stub host context the bundle's `apply` runs against. */
interface TestCtx {
  effect: (body: () => (() => void) | undefined, label: string) => void;
  locale: {
    bind: (ns: string) => (key: string) => string;
    register: (ns: string, dictionaries: { en: unknown; zh: unknown }) => void;
  };
  configForms: {
    get: (ns: string) => FormScope;
    whileServed: (
      namespaces: string[],
      register: (served: Set<string>) => void
    ) => void;
  };
  slots: {
    inject: (slot: string, register: () => void) => void;
    register: (entry: SlotEntry, component: CardComponent) => void;
  };
  remote: {
    $on: (...args: unknown[]) => () => void;
    credentials: {
      set: (ref: string, value: string) => Promise<boolean>;
      describe?: (ref: string) => Promise<unknown[]>;
    };
  };
}

/**
 * Load the bundle under a stub of the host's module loader.
 *
 * @returns the module the factory produced, and what it asked `require` for.
 */
function loadBundle(): LoadedBundle {
  const loaded: string[] = [];
  const modelCalls: ModelCall[] = [];
  const bindings: Projection[] = [];
  let registration: RegistrationSpec | undefined;
  const window: WindowStub = {
    __ModuleLoader__: {
      load(spec) {
        registration = spec;
      },
    },
  };

  // A `require` that answers only for what the manifest declares, so a bundle
  // reaching for something undeclared fails here rather than in the browser.
  const require: RequireStub = (name) => {
    loaded.push(name);
    if (name === "react/jsx-runtime" || name === "react") {
      // A minimal element tree: enough to assert *what* the card renders
      // (which components, with which props) without a DOM.
      const el = (
        type: string | ((...args: never[]) => unknown),
        props: { children?: unknown } & Record<string, unknown>,
        ...rest: unknown[]
      ): StubElement => {
        let fromProps: unknown[] = [];
        if (props?.children !== undefined) {
          fromProps = Array.isArray(props.children)
            ? props.children
            : [props.children];
        }
        return {
          type: typeof type === "function" ? type.name || "fn" : type,
          props: props ?? {},
          children: [...rest, ...fromProps].flat(Infinity) as unknown[],
        };
      };
      return { jsx: el, jsxs: el, Fragment: "Fragment" };
    }
    if (name === "@deepseek-ai/dsh-client-ui-primitives") {
      return {
        SettingsForm: () => null,
        // A constructor returning a plain object, not a class. The bundle calls
        // `new SettingsFormModel(...)`, and a constructor that returns an
        // object hands that object back — which sidesteps
        // `class-methods-use-this` honestly: this stub has no state, so a method
        // that ignores `this` is exactly what the rule would be pointing at.
        SettingsFormModel: function SettingsFormModel(
          scope: unknown,
          specs: { field: string }[],
          secrets: { field: string }[]
        ): unknown {
          // Record the arguments: these are the fields the page renders, and a
          // card that forgets one is a control the user cannot reach.
          modelCalls.push({ specs, secrets });
          return {
            bind: (project: Projection): unknown => {
              bindings.push(project);
              return {};
            },
            shell: () => ({
              available: true,
              writable: true,
              dirty: false,
              invalid: false,
              saving: false,
              failed: false,
            }),
            field: (_field: string): FieldState => ({
              text: "",
              overridden: false,
              invalid: false,
            }),
            actions: () => ({
              edit: () => {},
              resetField: () => {},
              save: () => {},
              discard: () => {},
            }),
            dispose: () => {},
          };
        },
        SettingsSecretField: () => null,
        SettingsValueField: () => null,
        Switch: () => null,
        SegmentedControl: () => null,
        settingsNumberField: (field: string) => ({
          field,
          format: String,
          parse: () => {},
        }),
        settingsTextField: (field: string) => ({
          field,
          format: String,
          parse: () => {},
        }),
      };
    }
    throw new Error(`the bundle required an undeclared dependency: ${name}`);
  };

  // The bundle is CJS wrapped in a factory, so it is evaluated rather than
  // imported. `node:vm` runs it in a fresh context with exactly these globals —
  // no `Function` constructor, and no access to this module's scope.
  const module_ = { exports: {} };
  runInNewContext(SOURCE, {
    window,
    require,
    module: module_,
    exports: module_.exports,
  });

  assert.ok(registration, "the bundle called window.__ModuleLoader__.load");
  return {
    registration,
    loaded,
    modelCalls,
    bindings,
    exports: registration.factory(require),
  };
}

test("the artifact is named the way the harness resolves it", () => {
  // The plugin route requests `${package}/client.js`, and the shipped path comes
  // from `exports["./client"]`. Both halves matter: a bundle that builds but is
  // named `client.cjs` is a 404 the harness absorbs silently — the page simply
  // does not appear, which reads as "the plugin has no settings". The shipped
  // `dsh-client-ui-*` packages pair `exports["./client"]` with `lib/client.js`,
  // and this asserts the same pairing. (The on-demand route's stricter
  // `client.<hash>.js` pattern is a different path; the default is plain
  // `client.js`.)
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const served = pkg.exports["./client"].default;
  assert.equal(
    served,
    "./lib/client.js",
    "the manifest points at lib/client.js"
  );
  assert.ok(
    pkg.files.includes("lib/client.js"),
    "and the file ships in the tarball"
  );
  assert.equal(
    existsSync(join(ROOT, "lib/client.js")),
    true,
    "and it exists after a build"
  );
  assert.equal(
    pkg.dsh.client.platform,
    "web",
    "the manifest declares the client platform"
  );
});

test("the built bundle registers itself with the loader", () => {
  const { registration } = loadBundle();
  assert.equal(
    registration.id,
    "dsh-tinyfish",
    "the loader id is the package name"
  );
  assert.equal(
    typeof registration.factory,
    "function",
    "and it is a factory, not a module"
  );
});

test("the factory exports the shape a client bundle must have", () => {
  const { exports } = loadBundle();
  assert.equal(
    exports.NS,
    "dsh-tinyfish",
    "the namespace equals the plugin's exported name"
  );
  assert.equal(typeof exports.apply, "function");
  // Spread into a fresh array: the bundle runs in a `node:vm` realm, so its
  // array carries a different `Array.prototype` and a strict deep-equal rejects
  // it for that reason rather than for a real difference.
  assert.deepEqual(
    [...exports.inject],
    ["slots", "locale", "remote", "remote.credentials", "configForms"],
    "and declares every service apply reaches for"
  );
});

test("it asks the host for React and the primitives instead of bundling them", () => {
  const { loaded } = loadBundle();
  assert.ok(
    loaded.includes("react/jsx-runtime"),
    "jsx-runtime is required, not inlined"
  );
  assert.ok(
    loaded.includes("@deepseek-ai/dsh-client-ui-primitives"),
    "so the page shares the client's own primitives rather than a second copy"
  );
  // A bundled React would put two on the page; the loader supplies one.
  assert.ok(
    !SOURCE.includes("react.production.min"),
    "no React build is inlined"
  );
});

test("apply registers the bundle config form, gated on the namespace being served", () => {
  const { exports, modelCalls } = loadBundle();
  const effects: string[] = [];
  const served: string[] = [];
  const registered: { entry: Record<string, unknown>; component: unknown }[] =
    [];

  const ctx = {
    effect: (body: () => unknown, label: string): void => {
      effects.push(label);
      // Run it now: these are registration effects, and running them is what a
      // mounted plugin does.
      const disposer = body();
      if (typeof disposer === "function") disposer();
    },
    locale: {
      bind:
        () =>
        (key: string): string =>
          key,
      register: (
        ns: string,
        dictionaries: { en: unknown; zh: unknown }
      ): void => {
        assert.equal(ns, "dsh-tinyfish");
        assert.ok(
          dictionaries.en && dictionaries.zh,
          "both dictionaries are registered"
        );
      },
    },
    configForms: {
      get: (ns: string) => {
        assert.equal(ns, "dsh-tinyfish");
        return {
          getSnapshot: () => ({
            status: "ready",
            value: {},
            base: {},
            user: {},
            writable: true,
            revision: 1,
          }),
          subscribe: () => () => {},
          mutate: async () => true,
        };
      },
      whileServed: (
        namespaces: string[],
        register: (served: Set<string>) => void
      ): void => {
        served.push(...namespaces);
        register(new Set(namespaces));
      },
    },
    slots: {
      inject: (slot: string, register: () => void): void => {
        // `plugins.bundle.config` is the keyed slot a bundle's own detail page
        // renders; `plugins.item` is the official-plugins list, which is not
        // where a third-party form belongs.
        assert.equal(slot, "plugins.bundle.config");
        register();
      },
      register: (entry: Record<string, unknown>, component: unknown): void => {
        registered.push({ entry, component });
      },
    },
    remote: {
      $on: () => () => {},
      credentials: { set: async () => true, describe: async () => [] },
    },
  };

  exports.apply(ctx as unknown as Parameters<typeof exports.apply>[0]);

  assert.deepEqual(
    served,
    ["dsh-tinyfish"],
    "the page is gated on the Host serving its namespace"
  );
  assert.equal(registered.length, 1, "exactly one slot entry");
  const { entry, component } = registered[0];
  assert.equal(entry.name, "plugins.bundle.config");
  // The detail page filters by `entryKey: pkg.name`, so the key must be the
  // package name spelled here — the same reason the namespace is spelled.
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(entry.key, manifest.name, "the key matches the manifest name");
  assert.equal(typeof entry.inject, "function");
  assert.equal(
    typeof component,
    "function",
    "and it registers the card component"
  );
  assert.ok(
    effects.some((label) => label.includes("page")),
    "the registration is an effect, so it is torn down on unload"
  );

  // The fields the page renders, read back off the model the card built. Every
  // editable key in the host schema should be reachable, and the credential is a
  // secret (written through the credentials domain, not the section).
  assert.equal(modelCalls.length, 1, "one form model is constructed");
  const { specs, secrets } = modelCalls[0];
  const fields = new Set(specs.map((spec) => spec.field));
  for (const key of ["channel", "purpose", "attempts", "search", "fetch"]) {
    assert.ok(fields.has(key), `${key} has a control`);
  }
  const written = [...secrets].map((secret) => secret.field);
  assert.deepEqual(
    written,
    ["apiKey", "monidApiKey"],
    "one write-only control per channel, so both keys can be saved"
  );
});

/**
 * Render the card against a section value, returning the element tree.
 *
 * The stubbed jsx builds `{ type, props, children }` nodes instead of DOM, so
 * assertions read the structure the card *would* render: which components, in
 * which order, with which props — including what conditional rendering hides.
 */
function renderCard(sectionValue: Record<string, unknown> = {}): unknown {
  const { exports } = loadBundle();
  let card: CardComponent | null = null;
  const ctx = {
    effect: (body: () => unknown): void => {
      const disposer = body();
      if (typeof disposer === "function") (disposer as () => void)();
    },
    locale: {
      bind:
        () =>
        (key: string): string =>
          key,
      register: (): void => {},
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({
          status: "ready",
          value: sectionValue,
          base: {},
          user: {},
          writable: true,
          revision: 1,
        }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
      whileServed: (
        namespaces: string[],
        register: (served: Set<string>) => void
      ): void => {
        register(new Set(namespaces));
      },
    },
    slots: {
      inject: (_slot: string, register: () => void): void => {
        register();
      },
      register: (entry: Record<string, unknown>, component: unknown): void => {
        card = component as CardComponent;
      },
    },
    remote: {
      $on: () => () => {},
      credentials: { set: async () => true, describe: async () => [] },
    },
  };
  // A test double for the host context. The double cast is honest about that:
  // behavior is asserted below, not type overlap.
  exports.apply(ctx as unknown as Parameters<typeof exports.apply>[0]);
  assert.ok(card, "the card component was registered");

  // The injected actions the slot entry provides, mirroring model.actions().
  const actions = {
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
  };
  // The store projection the real SettingsFormModel builds: shell, per-field
  // { text, overridden, invalid }, and the key state. Draft text mirrors the
  // section value the way spec.format would render it.
  const fields: Record<string, CardFieldState> = {};
  for (const [name, value] of Object.entries(sectionValue)) {
    fields[name] = {
      text:
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
          ? String(value)
          : "",
      overridden: true,
      invalid: false,
    };
  }
  const state = {
    shell: {
      available: true,
      writable: true,
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
  // Patch the fields the card reads so unset keys resolve like the real model:
  // schema defaults for the switches and channel, blank for the rest.
  const withDefaults = new Proxy(state.fields, {
    get: (
      target: Record<string, CardFieldState>,
      name: string
    ): CardFieldState => {
      if (name in target) return target[name] as CardFieldState;
      if (name === "search" || name === "fetch" || name === "channel") {
        return { text: "", overridden: false, invalid: false };
      }
      return { text: "", overridden: false, invalid: false };
    },
  });
  if (!card) throw new Error("the card component was not registered");
  const render: CardComponent = card;
  const tree = render({
    view: "page",
    t: (key: string): string => key,
    useTinyfishCard: (select: (state: CardState) => CardState) =>
      select({ ...state, fields: withDefaults }),
    ...actions,
    edit: (f: string, v: string): void => {
      fields[f] = { text: v, overridden: true, invalid: false };
    },
    resetField: (f: string): void => {
      fields[f] = { text: "", overridden: false, invalid: false };
    },
  });
  return tree;
}

/** Narrows an unknown tree node to the stub element shape. */
function isStubElement(node: unknown): node is StubElement {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    "props" in node &&
    "children" in node
  );
}

/** Find elements by type in a tree. */
function findByType(
  node: unknown,
  type: string,
  acc: StubElement[] = []
): StubElement[] {
  if (!isStubElement(node)) return acc;
  if (node.type === type) acc.push(node);
  for (const child of node.children) findByType(child, type, acc);
  return acc;
}

/** Read a control's props with the shape the test asserts on. */
function segProps(el: StubElement): {
  options: { value: string }[];
  value: string;
} {
  return el.props as unknown as { options: { value: string }[]; value: string };
}

test("channel renders as a segmented control, not a text field", () => {
  const tree = renderCard({});
  const segmented = findByType(tree, "SegmentedControl");
  assert.equal(segmented.length, 1, "exactly one segmented control");
  const got = segProps(segmented[0]).options.map(
    (o: { value: string }) => o.value
  );
  assert.equal(got.length, 2, "two channel options");
  assert.equal(got[0], "direct");
  assert.equal(got[1], "monid");
  assert.equal(segProps(segmented[0]).value, "direct", "defaulting to direct");
});

test("search and fetch render as switches, not text fields", () => {
  const tree = renderCard({});
  const switches = findByType(tree, "Switch");
  assert.equal(switches.length, 2, "two switches");
  for (const s of switches) {
    assert.equal(s.props.checked, true, "on by default");
    assert.equal(typeof s.props.onChange, "function");
  }
  // No text field may still carry the boolean hints.
  const treeText = JSON.stringify(tree);
  assert.ok(!treeText.includes("boolHint"), "no boolean hint text remains");
});

test("purpose hides when search is off", () => {
  const on = renderCard({ search: true });
  const off = renderCard({ search: false });
  const hasPurpose = (tree: unknown): boolean =>
    findByType(tree, "SettingsValueField").some(
      (f) => f.props.id === "plugin-config-tinyfish-purpose"
    );
  assert.ok(hasPurpose(on), "purpose shows when search is on");
  assert.ok(!hasPurpose(off), "purpose hides when search is off");
});

test("a warning shows only when both providers are off", () => {
  const texts = (tree: unknown): string[] =>
    findByType(tree, "p").map((p) =>
      (p.children ?? []).filter((c) => typeof c === "string").join("")
    );
  assert.ok(
    !texts(renderCard({})).some((s) => s.includes("bothOff")),
    "no warning by default"
  );
  assert.ok(
    !texts(renderCard({ search: false })).some((s) => s.includes("bothOff")),
    "no warning when only search is off"
  );
  assert.ok(
    texts(renderCard({ search: false, fetch: false })).some((s) =>
      s.includes("bothOff")
    ),
    "warning when both are off"
  );
});

test("the field specs cover every editable key in the host schema", () => {
  // The client spells its own field names; this is what keeps them equal to the
  // host's schema keys. A typo here is a control that silently writes nothing.
  const hostSchema = readFileSync(join(ROOT, "src/index.ts"), "utf8");
  for (const key of [
    "channel",
    "apiKey",
    "purpose",
    "attempts",
    "search",
    "fetch",
  ]) {
    assert.ok(
      hostSchema.includes(`${key}: z`),
      `${key} is a host schema key, so the client must edit it`
    );
    assert.ok(
      SOURCE.includes(`"${key}"`),
      `${key} appears in the built client`
    );
  }
});

test("the key field shown follows the selected channel", () => {
  // Both keys are stored; only the one that will actually be sent is shown, so
  // a user cannot paste the Monid platform key into the field TinyFish
  // authenticates with — the mix-up the two refs exist to prevent.
  const direct = findByType(renderCard({}), "SettingsSecretField");
  const monid = findByType(
    renderCard({ channel: "monid" }),
    "SettingsSecretField"
  );
  assert.equal(direct.length, 1, "exactly one key field on each channel");
  assert.equal(monid.length, 1, "exactly one key field on each channel");
  assert.equal(direct[0].props.id, "plugin-config-tinyfish-apiKey");
  assert.equal(monid[0].props.id, "plugin-config-tinyfish-monidApiKey");
  assert.equal(direct[0].props.label, "apiKey");
  assert.equal(monid[0].props.label, "monidApiKey");
});

test("the published state carries a key entry for both channels", () => {
  // The card indexes `keys` by channel, so a missing entry would render a
  // crash rather than an empty field. The store is what decides that, and it
  // is built in `apply` rather than in the card, so it is asserted here.
  const { exports, bindings } = loadBundle();
  exports.apply({
    effect: (body) => {
      const disposer = body();
      if (typeof disposer === "function") disposer();
    },
    locale: { bind: () => (key) => key, register: () => {} },
    configForms: {
      get: () => ({
        getSnapshot: () => ({
          status: "ready",
          value: {},
          base: {},
          user: {},
          writable: true,
          revision: 1,
        }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
      whileServed: (
        namespaces: string[],
        register: (served: Set<string>) => void
      ): void => {
        register(new Set(namespaces));
      },
    },
    slots: {
      inject: (_slot: string, register: () => void): void => {
        register();
      },
      register: (): void => {},
    },
    remote: { $on: () => () => {}, credentials: { set: async () => true } },
  });
  assert.equal(bindings.length, 1, "the card binds one projection");
  const state = bindings[0]();
  assert.ok(state.keys.direct, "a key entry for the direct channel");
  assert.ok(state.keys.monid, "a key entry for the monid channel");
  assert.equal(typeof state.keys.direct.text, "string");
  assert.equal(typeof state.keys.monid.text, "string");
});
