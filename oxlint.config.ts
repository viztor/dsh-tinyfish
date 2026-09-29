import { defineConfig } from "oxlint";
import ultracite from "ultracite/oxlint/core";

/**
 * Lint config — Ultracite presets on oxlint, type-aware.
 *
 * Rule severities follow the fleet tiers in `~/.grok/rules/lint-format-oxc-ultracite.md`:
 * real defects stay `error` and fail CI; harshness not yet paid down is `warn`
 * and stays visible; style and metrics are `off`.
 *
 * `typeAware` is what activates the `typescript/*` rules through
 * `oxlint-tsgolint`. Without it the presets below are still listed but inert,
 * which is indistinguishable from passing — so it is set here rather than left
 * to a CLI flag.
 *
 * The fleet doc writes `typescript/no-unsafe-*` as shorthand. oxlint has no
 * wildcard rule names, so the family is enumerated below; adding a member to
 * that list is how a new unsafe rule is promoted to a gate.
 */
export default defineConfig({
  extends: [ultracite],
  options: {
    typeAware: true,
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
    // The fleet doc lists "unicode-regexp / named-capture", "TS type-def /
    // method-sig style" and "jsdoc description nags" as not-gates.
    "require-unicode-regexp": "off",
    "prefer-named-capture-group": "off",
    "consistent-type-specifier-style": "off",
    "require-returns-description": "off",
    "require-param-description": "off",

    // Ultracite ships these as `error`; they are readability preferences with
    // no defect behind them, and this package is small enough that a gate
    // against them would only buy a louder diff. `warn` keeps them visible
    // without failing CI, which is the "quality debt" tier rather than a
    // demotion of a real gate. Promote any of these back to `error` when a
    // contributor asks; nothing here is load-bearing.
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
    // Monid's run envelope is `output: Record<string, unknown> | null`; the two
    // providers narrow it to their payload shapes. That is the one assertion in
    // the package that a `unknown` forces, and it is checked by the shape
    // tests, not left on faith.
    "typescript/no-unnecessary-type-assertion": "warn",
  },
  overrides: [
    {
      // Tests and validators are plain scripts with no type information, so the
      // type-aware rules cannot resolve `node:test` or `node:assert` and report
      // every call as an `error`-typed value. The fleet doc's script override
      // turns the unsafe family off here for exactly this reason.
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
      },
    },
  ],
});
