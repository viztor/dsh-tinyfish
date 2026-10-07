# Contributing to dsh-tinyfish

## Setup

```sh
pnpm install
pnpm run build        # produces lib/ — one test below evaluates it; the rest read src/
pnpm run ci           # tsc --noEmit && vp check && vp test --coverage && node scripts/check.ts
pnpm run release:gate # build, then ci — what a commit touching src/, cordis.patch.yml
                      # or package.json has to pass before it is committed
```

The build is not optional before testing: `test/client-bundle.test.ts` evaluates the built `lib/client.js` under `node:vm`, because proving the shipped artifact registers itself correctly is worth more than proving the source compiles.

## The toolchain is Vite+ (`vp`)

One entry point for the whole toolchain — Vite, Rolldown, Vitest, tsdown, Oxlint and Oxfmt:

| task                             | command          |
| -------------------------------- | ---------------- |
| build                            | `pnpm run build` |
| format                           | `vp fmt`         |
| lint                             | `vp lint`        |
| types                            | `tsc --noEmit`   |
| test                             | `vp test`        |
| format + lint + type-aware check | `vp check`       |
| the whole gate                   | `pnpm run ci`    |

**Lint and format configuration lives in the `lint` and `fmt` blocks of `vite.config.ts`, and nowhere else.** Vite+ disables nested `oxlint.config` and `.oxfmtrc` files, so a config in its own file is read by nobody and fails silently. That is not a style preference: during the migration the rules were off for a long stretch and CI was green the whole time. `scripts/check.ts` asserts the live rule count and that the type-aware tier is on, so the configuration cannot quietly go inert again.

## Tests

`pnpm test` runs the hermetic suite — no network, no credentials. Coverage thresholds are set in `vite.config.ts` and gate the run; a change that drops the suite below the floor fails. The floors sit just under what the suite reaches today, so closing a gap is what lets them be raised.

Two files, two boundaries:

- `test/settings-page.test.ts` imports the **source** and stubs the Host's UI kit, because `@deepseek-ai/dsh-client-ui-primitives` does not resolve outside the Host (it imports `*.module.css` and host-only workspace utilities).
- `test/client-bundle.test.ts` evaluates the **built** bundle against an equivalent stub, which is the only thing that proves the artifact the registry serves is wired correctly.

`pnpm run test:live` runs `test/integration/live.test.ts` against the real TinyFish and Monid endpoints. It needs credentials and spends a little money; it is not part of `pnpm run ci`.

## Commits

Conventional Commits, because `release-please` reads them to compute the next version and write the changelog:

```
feat: add a Monid platform credential alongside the TinyFish one
fix: read the stored credential on the request path
docs: correct the slot name in the contract notes
chore: raise the coverage floor
```

A `feat:` produces a minor, a `fix:` a patch, a `!` after the type or a `BREAKING CHANGE:` footer produces a major. Anything the pattern does not recognise is skipped by the version calculation — so a prose-only subject line silently contributes nothing to the release, which is the one failure mode worth knowing about.

Write the body for someone reading `git log` in two years: what was true before, what is true now, and why the obvious alternative was not taken.

## Releasing

Merging to `main` opens a release-please pull request. Merging _that_ creates the tag and the GitHub Release, and the tag fires `.github/workflows/release.yml`, which publishes to npm with OIDC trusted publishing — no stored token.

One-time setup, on npmjs.com for the `dsh-tinyfish` package:

- **Trusted Publisher** → add `viztor/dsh-tinyfish` and the workflow filename `release.yml`, allowing the `npm publish` action.
- In this repository, set `RELEASE_PLEASE_TOKEN` as a secret: a fine-grained PAT with Contents and Pull requests read/write. The built-in `GITHUB_TOKEN` cannot be used, because tags it creates do not trigger downstream workflows, so the release would produce a tag and never publish.

`node scripts/check.ts` asserts the release wiring is reachable, including that `ci.yml` ignores version tags. A publish job that cannot be reached reads as a working release process and only fails on the day it is needed.
