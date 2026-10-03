import { defineConfig } from "vite-plus";

/**
 * The live suite: the same tests, against the real TinyFish and Monid APIs.
 *
 * It is separate from `vite.config.ts` for one reason — this one needs a
 * network and a credential, and the default `vp test` must stay runnable on a
 * plane and in CI without either. It also still costs $0, so there is no
 * reason to run it less often than before, only no reason to run it always.
 *
 *   pnpm run test:live
 *
 * Both endpoints are free, so the only cost of running this is a couple of
 * seconds of wall clock.
 */
export default defineConfig({
  test: {
    name: "live",
    include: ["test/integration/**/*.test.ts"],
    // A generous ceiling: the upstream occasionally answers a valid search
    // with nothing, which the client retries by design.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
