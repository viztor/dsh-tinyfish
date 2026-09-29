/**
 * Contract check against the installed DSH runtime.
 *
 * The peer ranges are `workspace:^`, which tells DSH's compatibility checker
 * that this package works with whatever runtime is present. That is the right
 * call for a package published on npm — an exact pin turns every DSH prerelease
 * into "this plugin is now incompatible" — but it gives up *automatic* detection
 * of a real break.
 *
 * This buys that detection back. It asserts, against the versions actually
 * installed, that every surface this package depends on still exists with the
 * shape the code assumes. A genuine break fails here, in CI, with a precise
 * message, rather than at boot on someone's machine with a paragraph of prose.
 *
 * It also reports which runtime it checked against, because "it works" and "it
 * works on the version you think" are different claims.
 *
 *   node scripts/contract-check.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "package.json"));

const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const pass = (message) => notes.push(message);

/** Read one manifest's version, or report it missing. */
function versionOf(name) {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    fail(`${name} is not installed — cannot verify the contract`);
    return null;
  }
}

/* ------------------------------------------------- the runtime it checked */

const web = versionOf("@deepseek-ai/dsh-web");
const credentials = versionOf("@deepseek-ai/dsh-credentials");
const launch = versionOf("@deepseek-ai/dsh-launch-environment");
const cordis = versionOf("@deepseek-ai/cordis");

pass(`dsh-web ${web}`);
pass(`dsh-credentials ${credentials}`);
pass(`dsh-launch-environment ${launch}`);
pass(`cordis ${cordis}`);

/* ------------------------------------------------- surfaces the code uses */

const webTypes = join(
  ROOT,
  "node_modules/@deepseek-ai/dsh-web/lib/types/types.d.ts"
);
if (!existsSync(webTypes)) {
  fail("dsh-web no longer ships lib/types/types.d.ts — the contract moved");
} else {
  const dts = readFileSync(webTypes, "utf8");

  // Each entry is a surface src/ imports or implements. The failure message
  // says what breaks, because "contract check failed" on its own is useless.
  const REQUIRED = [
    [
      /export declare class WebError/,
      "WebError — the package raises this for every failure",
    ],
    [
      /interface WebSearchProvider\b/,
      "WebSearchProvider — the search provider implements this",
    ],
    [
      /interface WebFetchProvider\b/,
      "WebFetchProvider — the fetch provider implements this",
    ],
    [
      /interface WebSearchRequest\b/,
      "WebSearchRequest — search() reads .query/.maxResults",
    ],
    [
      /interface WebSearchResult\b/,
      "WebSearchResult — search() returns sources/truncated",
    ],
    [
      /interface WebSearchSource\b/,
      "WebSearchSource — sources carry url/title/snippet/publishedAt",
    ],
    [/interface WebFetchRequest\b/, "WebFetchRequest — fetch() reads .url"],
    [
      /interface WebFetchResult\b/,
      "WebFetchResult — fetch() returns url/statusCode/body/truncated",
    ],
    // The `text` arm is the whole reason this provider exists: TinyFish returns
    // Markdown, so it skips dsh-tool-web's turndown conversion.
    [
      /kind:\s*'text'/,
      "WebFetchBody's 'text' arm — without it the provider must switch to 'html'",
    ],
  ];

  for (const [pattern, what] of REQUIRED) {
    if (!pattern.test(dts)) fail(`dsh-web no longer exports ${what}`);
  }
  if (failures.length === 0)
    pass(`dsh-web exposes all ${REQUIRED.length} required surfaces`);
}

const credTypes = join(
  ROOT,
  "node_modules/@deepseek-ai/dsh-credentials/lib/types/index.d.ts"
);
if (!existsSync(credTypes)) {
  fail("dsh-credentials no longer ships its type declarations");
} else {
  const dts = readFileSync(credTypes, "utf8");
  for (const [pattern, what] of [
    [/export declare function credentialRef\(/, "credentialRef()"],
    [/resolve\(ref: CredentialRef\)/, "the credentials service's resolve()"],
    [/interface ResolvedCredential\b/, "ResolvedCredential"],
  ]) {
    if (!pattern.test(dts)) fail(`dsh-credentials no longer exports ${what}`);
  }
  if (!failures.length)
    pass("dsh-credentials exposes credentialRef and resolve()");
}

const launchTypes = join(
  ROOT,
  "node_modules/@deepseek-ai/dsh-launch-environment/lib/types/index.d.ts"
);
if (!existsSync(launchTypes)) {
  fail("dsh-launch-environment no longer ships its type declarations");
} else {
  const dts = readFileSync(launchTypes, "utf8");
  if (!/export declare function launchEnvironmentOf\(/.test(dts)) {
    fail("dsh-launch-environment no longer exports launchEnvironmentOf()");
  } else if (!/interface LaunchEnvironmentSnapshot\b/.test(dts)) {
    fail("dsh-launch-environment no longer exports LaunchEnvironmentSnapshot");
  } else {
    pass("dsh-launch-environment exposes launchEnvironmentOf()");
  }
}

/* ------------------------------------------------------ cordis plugin shape */

if (cordis) {
  const entry = join(ROOT, "node_modules/@deepseek-ai/cordis/lib/index.js");
  if (!existsSync(entry)) {
    fail(`cordis ${cordis} no longer ships lib/index.js`);
  } else {
    pass(`cordis ${cordis} ships a loadable entry`);
  }
}

/* --------------------------------- the manifest must stay honest with itself */

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  // Only @deepseek-ai/dsh and @deepseek-ai/dsh-* are checked at boot; cordis
  // is not, so an exact range there costs nothing and documents the real pin.
  const checked =
    name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");
  if (
    checked &&
    !["workspace:^", "workspace:~", "workspace:*"].includes(range)
  ) {
    fail(
      `peer ${name} is pinned to "${range}"; a checked peer must use workspace:^ ` +
        "or DSH will reject the plugin on every runtime upgrade"
    );
  }
}
if (!failures.length) {
  pass(
    "every checked peer uses workspace:^, so a DSH upgrade cannot orphan the plugin"
  );
}

/* ----------------------------------------------------------------- report */

for (const note of notes) console.log(`  ok   ${note}`);
for (const message of failures) console.error(`  FAIL ${message}`);

if (failures.length) {
  console.error(
    `\ncontract:check failed — ${failures.length} problem(s).\n` +
      "Either adapt src/ to the new runtime, or pin the peers to the exact\n" +
      "version you built against if the change was not actually breaking."
  );
  process.exit(1);
}
console.log("\ncontract:check passed");
