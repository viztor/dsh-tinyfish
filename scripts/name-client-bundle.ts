/**
 * Name the browser bundle `client.js`.
 *
 * The harness's plugin route is fixed: it serves `${package}/client.js` and
 * accepts only chunk names matching `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`
 * (`CLIENT_CHUNK` in `dsh-client-modules`). So the artifact has to end in `.js`.
 *
 * `vp pack` with `format: ["cjs"]` emits `.cjs` when the package is
 * `type: module` — which this is, and which the official client packages are
 * too, even though the file they ship is plainly `.js`. That is not a
 * contradiction: the file is CommonJS wrapped in `window.__ModuleLoader__.load`,
 * evaluated by the browser, not imported by Node, so the package `type` never
 * applies to it. Only the extension the route looks for matters.
 *
 * `outExtensions` would express this in the bundler, but it is not plumbed
 * through Vite+'s `pack` options, so the rename happens here. Two minutes of
 * build, and it keeps the extension requirement in one place with a test on it.
 */

import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(ROOT, "lib/client.cjs");
const served = join(ROOT, "lib/client.js");

if (!existsSync(built)) {
  // Nothing to do when the client half was not built (e.g. a host-only build).
  process.exit(0);
}

// Removed rather than renamed aside. The rename kept a copy nothing read, and
// npm-packlist ships dotfiles inside a directory listed in `files` — so a
// `.client.js.stale` sibling would have ridden in every published tarball.
if (existsSync(served)) rmSync(served, { force: true });
renameSync(built, served);
console.log("named the browser bundle lib/client.js");
