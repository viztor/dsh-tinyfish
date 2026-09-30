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
 * Load the bundle under a stub of the host's module loader.
 *
 * @returns the module the factory produced, and what it asked `require` for.
 */
function loadBundle() {
  const loaded = [];
  let registration;
  const window = {
    __ModuleLoader__: {
      load(spec) {
        registration = spec;
      },
    },
  };

  // A `require` that answers only for what the manifest declares, so a bundle
  // reaching for something undeclared fails here rather than in the browser.
  const require = (name) => {
    loaded.push(name);
    if (name === "react/jsx-runtime" || name === "react") {
      return { jsx: () => null, jsxs: () => null, Fragment: null };
    }
    if (name === "@deepseek-ai/dsh-client-ui-primitives") {
      return {
        SettingsForm: () => null,
        // A constructor returning a plain object, not a class. The bundle calls
        // `new SettingsFormModel(...)`, and a constructor that returns an
        // object hands that object back — which sidesteps
        // `class-methods-use-this` honestly: this stub has no state, so a method
        // that ignores `this` is exactly what the rule would be pointing at.
        SettingsFormModel: function SettingsFormModel() {
          return {
            bind: () => ({}),
            shell: () => ({
              available: true,
              writable: true,
              dirty: false,
              invalid: false,
              saving: false,
              failed: false,
            }),
            field: () => ({ text: "", overridden: false, invalid: false }),
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
        settingsNumberField: (field) => ({
          field,
          format: String,
          parse: () => {},
        }),
        settingsTextField: (field) => ({
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
  return { registration, loaded, exports: registration.factory(require) };
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
    "web-tinyfish",
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

test("apply registers one plugins.item slot, gated on the namespace being served", () => {
  const { exports } = loadBundle();
  const effects = [];
  const served = [];
  const registered = [];

  const ctx = {
    effect: (body, label) => {
      effects.push(label);
      // Run it now: these are registration effects, and running them is what a
      // mounted plugin does.
      const disposer = body();
      if (typeof disposer === "function") disposer();
    },
    locale: {
      bind: () => (key) => key,
      register: (ns, dictionaries) => {
        assert.equal(ns, "web-tinyfish");
        assert.ok(
          dictionaries.en && dictionaries.zh,
          "both dictionaries are registered"
        );
      },
    },
    configForms: {
      get: (ns) => {
        assert.equal(ns, "web-tinyfish");
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
      whileServed: (namespaces, register) => {
        served.push(...namespaces);
        register(new Set(namespaces));
      },
    },
    slots: {
      inject: (slot, register) => {
        assert.equal(slot, "plugins.item");
        register();
      },
      register: (entry, component) => {
        registered.push({ entry, component });
      },
    },
    remote: {
      $on: () => () => {},
      credentials: { set: async () => true, describe: async () => [] },
    },
  };

  exports.apply(ctx);

  assert.deepEqual(
    served,
    ["web-tinyfish"],
    "the page is gated on the Host serving its namespace"
  );
  assert.equal(registered.length, 1, "exactly one slot entry");
  const { entry, component } = registered[0];
  assert.equal(entry.name, "plugins.item");
  assert.equal(entry.id, "tinyfish");
  assert.equal(typeof entry.label, "function");
  assert.equal(
    typeof component,
    "function",
    "and it registers the card component"
  );
  assert.ok(
    effects.some((label) => label.includes("page")),
    "the registration is an effect, so it is torn down on unload"
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
