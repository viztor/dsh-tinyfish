import { defineConfig } from "vite-plus";

/**
 * Vite+ configuration.
 *
 * A DSH bundle is a library, not an application: the harness resolves `main`
 * out of a profile's `node_modules` and loads it with `import`. So the build
 * is `pack` (tsdown) rather than `build` (Vite) — there is no HTML entry, no
 * dev server, and no asset pipeline to configure.
 *
 * Everything tool-specific that used to live in separate oxlint/oxfmt config
 * files stays where it was: `vp lint` and `vp fmt` are Oxlint and Oxfmt, and
 * they read `oxlint.config.ts` and `oxfmt.config.ts` directly. The rule tiers
 * in that file are the fleet's, and they are enforced through `vp`.
 */
export default defineConfig({
  pack: {
    // Declarations are generated from the source, so there is no hand-written
    // `.d.ts` anywhere that could drift from the implementation.
    dts: true,
    // ESM only. The harness loads the bundle with `import`; a CommonJS build
    // would be dead weight in the tarball, and the fleet's own packages ship
    // ESM with a single `default` export condition.
    format: ["esm"],
    // No sourcemaps. A bundle has no consumer for them inside the harness, and
    // `pack:check` fails the build if any reappear — they were once most of
    // the published tarball.
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
    target: "node22",
    clean: true,
  },

  test: {
    // The suite is hermetic and free: `fetch` is stubbed per test in
    // test/helpers.mjs. Nothing here touches the network or needs a
    // credential, so `vp test` stays runnable offline.
    //
    // The live suite has its own config, `vite.live.config.ts`. An inline
    // `projects` entry looked like the tidier answer and was not: it inherited
    // this block's `include`, so `--project live` re-ran all 70 unit tests
    // under a second name. Two files say plainly what each run covers.
    include: ["test/**/*.test.mjs"],
    exclude: ["test/integration/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Reported, not enforced as a gate. The fleet's rule is to close the gap
      // rather than silence it, so a threshold that failed the build would get
      // ratcheted down instead of being widened.
      reporter: ["text-summary"],
    },
  },
});
