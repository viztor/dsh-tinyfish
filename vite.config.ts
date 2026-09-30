import { fileURLToPath } from "node:url";

import ultraciteFmt from "ultracite/oxfmt";
import ultraciteLint from "ultracite/oxlint/core";
import { defineConfig } from "vite-plus";

/**
 * Vite+ configuration — build, test, lint and format in one file.
 *
 * A DSH bundle is a library, not an application: the harness resolves `main`
 * out of a profile's `node_modules` and loads it with `import`. So the build is
 * `pack` (tsdown) rather than `build` (Vite) — no HTML entry, no dev server, no
 * asset pipeline.
 *
 * The `lint` and `fmt` blocks are here rather than in `oxlint.config.ts` /
 * `oxfmt.config.ts` because **Vite+ disables nested Oxlint and Oxfmt configs**.
 * Its own guide is explicit: "Put lint configuration directly in the `lint`
 * block in the root `vite.config.ts`… We do not recommend using
 * `oxlint.config.ts` or `.oxlintrc.json` with Vite+."
 *
 * Those standalone files used to sit beside this one, and they were **inert**:
 * `vp lint --print-config` reported Oxlint's defaults (111 rules,
 * `options: null`, `typescript/no-floating-promises` at `warn`) rather than the
 * tiers below. Lint was green because it was running nothing, which is
 * indistinguishable from passing — the exact failure the tiers were written to
 * avoid. The rule set is unchanged; only where it lives.
 */
export default defineConfig({
  lint: {
    extends: [ultraciteLint],
    options: {
      // Without `typeAware` the `typescript/*` rules below are listed but
      // inert. `typeCheck` additionally runs the type checker as part of
      // `vp check`, which is what makes the two agree.
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      // --- Quality gates: async safety and throw contracts. Never demote these.
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/only-throw-error": "error",
      "typescript/no-for-in-array": "error",
      "typescript/no-implied-eval": "error",
      "typescript/prefer-promise-reject-errors": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-eq-null": "off",

      // --- Quality debt: real, visible, not yet paid down.
      "typescript/no-unsafe-argument": "warn",
      "typescript/no-unsafe-assignment": "warn",
      "typescript/no-unsafe-call": "warn",
      "typescript/no-unsafe-member-access": "warn",
      "typescript/no-unsafe-return": "warn",
      "typescript/no-unsafe-type-assertion": "warn",
      "typescript/no-unsafe-enum-comparison": "warn",
      "typescript/no-unsafe-function-type": "warn",
      "typescript/no-explicit-any": "warn",
      "typescript/strict-boolean-expressions": "warn",
      "typescript/no-non-null-assertion": "warn",
      "typescript/prefer-nullish-coalescing": "warn",
      "typescript/return-await": "warn",
      "typescript/promise-function-async": "warn",
      "no-await-in-loop": "warn",
      "require-await": "warn",

      // --- Not quality gates: style and metrics.
      "func-style": "off",
      "func-names": "off",
      "sort-keys": "off",
      complexity: "off",
      "max-classes-per-file": "off",
      "max-nested-callbacks": "off",
      "no-inline-comments": "off",
      "no-use-before-define": "off",
      "unicorn/filename-case": "off",
      "unicorn/prefer-export-from": "off",
      curly: "off",
      "require-unicode-regexp": "off",
      "prefer-named-capture-group": "off",
      "consistent-type-specifier-style": "off",
      "require-returns-description": "off",
      "require-param-description": "off",

      // Ultracite ships these as `error`; they are readability preferences with
      // no defect behind them, and this package is small enough that a gate
      // against them would only buy a louder diff. `warn` keeps them visible
      // without failing CI — the debt tier, not a demotion of a real gate.
      "no-negated-condition": "warn",
      "unicorn/no-negated-condition": "warn",
      "unicorn/prefer-import-meta-properties": "off",
      "no-useless-undefined": "warn",
      "unicorn/no-useless-undefined": "warn",
      "no-unnecessary-type-conversion": "warn",
      "prefer-template": "warn",
      "unicorn/prefer-logical-operator-over-ternary": "warn",
      "prefer-destructuring": "warn",
      "unicorn/consistent-function-scoping": "warn",
      // It advises a default import for `node:path`, which is not how Node
      // builtins are written. Named imports stay.
      "unicorn/import-style": "warn",
      "unicorn/text-encoding-identifier-case": "warn",
      "unicorn/numeric-separators-style": "warn",
      "promise/avoid-new": "warn",
      "no-empty-function": "warn",
      "typescript/non-nullable-type-assertion-style": "warn",
      // Monid's run envelope is `output: Record<string, unknown> | null`; the
      // two providers narrow it to their payload shapes. That is the one
      // assertion in the package that an `unknown` forces, and it is checked by
      // the shape tests rather than left on faith.
      "typescript/no-unnecessary-type-assertion": "warn",
    },
    overrides: [
      {
        // Tests and validators are plain scripts with no type information, so
        // the type-aware rules cannot resolve `node:test` or `node:assert` and
        // report every call as an `error`-typed value. The fleet's script
        // override turns the unsafe family off here for exactly this reason.
        files: ["test/**/*.mjs", "scripts/**/*.mjs"],
        rules: {
          "no-console": "off",
          "no-process-exit": "off",
          "typescript/no-non-null-assertion": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/strict-boolean-expressions": "off",
          // The plugin tests assert on the module namespace itself — that
          // `Config` is absent, and that each named export exists. Both are
          // computed reads a namespace-import rule cannot resolve.
          "import/namespace": "off",
          // `assert.throws(fn, validator)` takes a *predicate*, not a callback
          // carrying control flow, and it is the only way to assert on a thrown
          // error's `code`. The rule's own advice — use `async`/`await` — does
          // not apply to a synchronous assertion helper. Scoped to tests, not
          // turned off globally, so it still guards `src/`.
          "promise/prefer-await-to-callbacks": "off",
        },
      },
    ],
  },

  fmt: {
    ...ultraciteFmt,
    // The formatter must not rewrite the two generated-ish surfaces: `lib/` is
    // a build artifact, and a patch file's comments are load-bearing prose.
    ignorePatterns: [
      ...(ultraciteFmt.ignorePatterns ?? []),
      "lib/**",
      "coverage/**",
    ],
    sortPackageJson: true,
  },

  // Two targets, because this package ships two artifacts: the host bundle the
  // harness loads, and the browser bundle the web client loads for its settings
  // page. `dsh-app-boot` reads `dsh.bundle`; `dsh-client-modules` reads
  // `dsh.client`; the two never consult each other, which is why one package can
  // carry both and the user installs once.
  pack: [
    {
      // Declarations are generated from the source, so there is no hand-written
      // `.d.ts` anywhere that could drift from the implementation.
      dts: true,
      // ESM only. The harness loads the bundle with `import`; a CommonJS build
      // would be dead weight in the tarball, and the fleet's own packages ship
      // ESM with a single `default` export condition.
      format: ["esm"],
      // No sourcemaps. A bundle has no consumer for them inside the harness, and
      // the package check fails the build if any reappear — they were once most
      // of the published tarball.
      sourcemap: false,
      // The harness supplies these. Bundling a copy would put a second
      // `@deepseek-ai/schemastery` in the artifact with its own `~standard`
      // object beside the loader's, which is the same identity problem that made
      // the peer ranges matter in the first place.
      //
      // `deps.neverBundle`, not the deprecated `external` alias.
      deps: {
        neverBundle: [
          "@deepseek-ai/schemastery",
          "@deepseek-ai/cordis",
          "@deepseek-ai/dsh-web",
          "@deepseek-ai/dsh-credentials",
          "@deepseek-ai/dsh-launch-environment",
        ],
      },
      // `lib/`, not tsdown's default `dist/`: every @deepseek-ai package ships
      // from `lib`, and the harness resolves `main` without caring either way.
      // Keeping it means the manifest, the docs and the ecosystem agree.
      outDir: "lib",
      platform: "node",
      target: "node24",
      // Only the host target cleans. If both did, whichever ran second would
      // delete the other's output.
      clean: true,
    },
    {
      // A named entry, so the artifact is `lib/client.*` rather than
      // `lib/settings-page.cjs`: `client` is what the harness calls the browser
      // half, and the manifest exports it under that name.
      entry: { client: "src/settings-page.tsx" },
      outDir: "lib",
      // CommonJS, because the web client's loader hands the bundle a `require`
      // and expects `module.exports` — that is the shape of the wrapper below,
      // not a choice about module systems.
      format: ["cjs"],
      platform: "browser",
      // No declarations: nothing imports this bundle, the loader calls it.
      dts: false,
      sourcemap: false,
      clean: false,
      // React and the primitives come from the host's module loader at runtime.
      // Bundling them would put a second React, or a second set of primitives,
      // in the page beside the client's own.
      deps: {
        neverBundle: [
          "react",
          "react/jsx-runtime",
          "@deepseek-ai/dsh-client-ui-primitives",
        ],
      },
      // The loader contract. A client bundle is not a module the page imports;
      // it is a factory the page hands a `require` to, and it must call this
      // before anything else runs.
      banner:
        'window.__ModuleLoader__.load({\n  id: "dsh-tinyfish",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;',
      footer: "    return module.exports;\n  },\n});",
    },
  ],

  test: {
    // The suite is hermetic and free: `fetch` is stubbed per test in
    // test/helpers.mjs. Nothing here touches the network or needs a
    // credential, so `vp test` stays runnable offline.
    //
    // The live suite has its own config, `vite.live.config.ts`. An inline
    // `projects` entry looked like the tidier answer and was not: it inherited
    // this block's `include`, so `--project live` re-ran every unit test under
    // a second name. Two files say plainly what each run covers.
    include: ["test/**/*.test.mjs"],
    exclude: ["test/integration/**"],
    // The UI primitives are external in the browser bundle — the host supplies
    // them — and outside the host they do not resolve: the package imports
    // `*.module.css` and host-only workspace utilities that no consumer has.
    // So a test that imports the *source* of the settings page aliases the kit
    // to a stub. Testing our code with the host's kit stubbed is the right
    // boundary anyway; `test/client-bundle.test.mjs` covers the built artifact
    // against the same stub.
    alias: {
      "@deepseek-ai/dsh-client-ui-primitives": fileURLToPath(
        new URL("test/primitives-stub.tsx", import.meta.url)
      ),
    },
    coverage: {
      provider: "v8",
      // `.tsx` is here for a reason: `**/*.ts` does not match it, and
      // `settings-page.tsx` is the one source file with no unit coverage of its
      // own — it is exercised by executing the *built* bundle under `node:vm`.
      // Excluded from the report it had no number at all, which reads as "not
      // measured" rather than "not counted".
      include: ["src/**/*.ts", "src/**/*.tsx"],
      reporter: ["text-summary", "text"],
      // A floor, not a target. A threshold nobody fails is a check that cannot
      // fail, which is worth less than no threshold at all: it reads as
      // "covered" on the dashboard. These sit just under what the suite
      // actually reaches today (92 / 86 / 89 / 92), so a real regression fails
      // and closing a gap lets them be raised. Widening one is a deliberate act
      // visible in the diff — which is the point.
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 88,
        lines: 90,
      },
    },
  },
});
