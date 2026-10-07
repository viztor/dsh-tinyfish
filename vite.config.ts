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
    ignorePatterns: ["lib/**", "coverage/**"],
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

      // --- Quality gates: the type system's own defect classes. Never demote.
      // These used to be the `warn` tier, and read as debt until the debt was
      // paid: every occurrence in `src/` has since been removed, so the tier
      // that recorded "known, tolerated" no longer describes anything. Leaving
      // them at `warn` after that would be the opposite move — the rule would
      // stay visible while its enforcement quietly did not, which is the same
      // indistinguishable-from-passing failure that inert config produces.
      // `test/` and `scripts/` keep their own `off` override below, so this
      // widens the gate only where the contract lives.
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-unsafe-enum-comparison": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/no-explicit-any": "error",
      "typescript/strict-boolean-expressions": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/prefer-nullish-coalescing": "error",
      "typescript/return-await": "error",
      "typescript/promise-function-async": "off",
      "no-await-in-loop": "off",
      "require-await": "off",

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
      "no-negated-condition": "off",
      "unicorn/no-negated-condition": "off",
      "unicorn/prefer-import-meta-properties": "off",
      "no-useless-undefined": "off",
      "unicorn/no-useless-undefined": "off",
      "no-unnecessary-type-conversion": "warn",
      "prefer-template": "off",
      "unicorn/prefer-logical-operator-over-ternary": "warn",
      "prefer-destructuring": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/import-style": "off",
      "unicorn/text-encoding-identifier-case": "warn",
      "unicorn/numeric-separators-style": "warn",
      "promise/avoid-new": "off",
      "no-empty-function": "off",
      "typescript/non-nullable-type-assertion-style": "warn",
      // Was `warn` for one reason: Monid's `output` field forced an assertion
      // at both providers, so the rule was recording a known exception rather
      // than tolerating sloppiness. The assertion is gone — the response body
      // is now decoded where it is read instead of asserted at each call site,
      // which is strictly better than either tier — so the exception the
      // warning documented no longer exists and the rule becomes a gate.
      "typescript/no-unnecessary-type-assertion": "error",
    },
    overrides: [
      {
        // Tests and scripts stay small and direct rather than fully typed, so
        // the unsafe family is relaxed here. The fleet's script override turns
        // it off for exactly this reason; what it must not do is silence real
        // mistakes, so the error tier still applies to `src/`.
        files: ["test/**/*.ts", "test/**/*.tsx", "scripts/**/*.ts"],
        rules: {
          "import/namespace": "off",
          "no-await-in-loop": "off",
          "no-console": "off",
          "no-empty-function": "off",
          "no-negated-condition": "off",
          "no-process-exit": "off",
          "no-useless-undefined": "off",
          "prefer-destructuring": "off",
          "promise/prefer-await-to-callbacks": "off",
          "require-await": "off",
          "typescript/no-non-null-assertion": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/no-unnecessary-type-assertion": "off",
          "typescript/non-nullable-type-assertion-style": "off",
          "typescript/prefer-nullish-coalescing": "off",
          "typescript/strict-boolean-expressions": "off",
          "unicorn/consistent-function-scoping": "off",
          "unicorn/import-style": "off",
          "unicorn/no-negated-condition": "off",
          "unicorn/no-useless-undefined": "off",
          "unicorn/prefer-import-meta-properties": "off",
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
      // Bot-owned: release-please appends entries its own way every release.
      "CHANGELOG.md",
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
      //
      // The registration id must equal the package name the graph row executes,
      // so every published name needs its own call: this package ships as both
      // `dsh-tinyfish` and the GitHub Packages mirror `@viztor/dsh-tinyfish`,
      // and a scoped install that found no matching id would silently lose its
      // settings page. One factory serves all of them.
      banner: [
        "(function () {",
        "  var factory = function (require) {",
        "    var module = { exports: {} };",
        "    var exports = module.exports;",
      ].join("\n"),
      footer: [
        "    return module.exports;",
        "  };",
        '  window.__ModuleLoader__.load({ id: "dsh-tinyfish", factory: factory });',
        '  try { window.__ModuleLoader__.load({ id: "@viztor/dsh-tinyfish", factory: factory }); } catch (e) {}',
        "})();",
      ].join("\n"),
    },
  ],

  test: {
    // The suite is hermetic and free: `fetch` is stubbed per test in
    // test/helpers.ts. Nothing here touches the network or needs a
    // credential, so `vp test` stays runnable offline.
    //
    // The live suite has its own config, `vite.live.config.ts`. An inline
    // `projects` entry looked like the tidier answer and was not: it inherited
    // this block's `include`, so `--project live` re-ran every unit test under
    // a second name. Two files say plainly what each run covers.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["test/integration/**"],
    // The UI primitives are external in the browser bundle — the host supplies
    // them — and outside the host they do not resolve: the package imports
    // `*.module.css` and host-only workspace utilities that no consumer has.
    // So a test that imports the *source* of the settings page aliases the kit
    // to a stub. Testing our code with the host's kit stubbed is the right
    // boundary anyway; `test/client-bundle.test.ts` then covers the *built*
    // artifact under a `node:vm` stub of the module loader, with its own
    // inline stand-in for the primitives — two different stubs, because the
    // two tests are proving two different things.
    alias: {
      "@deepseek-ai/dsh-client-ui-primitives": fileURLToPath(
        new URL("test/primitives-stub.tsx", import.meta.url)
      ),
    },
    coverage: {
      provider: "v8",
      // `.tsx` is here for a reason: `**/*.ts` does not match it, so
      // `settings-page.tsx` would silently drop out of this report. A file
      // excluded from the report has no number at all, which reads as "not
      // measured" rather than "not counted".
      include: ["src/**/*.ts", "src/**/*.tsx"],
      reporter: ["text-summary", "text"],
      // A floor, not a target. A threshold nobody fails is a check that cannot
      // fail, which is worth less than no threshold at all: it reads as
      // "covered" on the dashboard. These sit just under what the suite
      // actually reaches today (93.7 / 86.7 / 95.8 / 95.5 on vitest 5.0.3), so
      // a real regression fails and closing a gap lets them be raised.
      // Widening one is a deliberate act visible in the diff — which is the
      // point. `branches` stays the tight one on purpose: 86 against a
      // measured 86.65 means the first untested branch fails it.
      thresholds: {
        statements: 92,
        branches: 86,
        functions: 94,
        lines: 94,
      },
    },
  },
});
