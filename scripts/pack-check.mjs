/**
 * Publish validator for the DSH bundle.
 *
 * A DSH bundle is an ordinary npm package with one extra obligation: the
 * manifest must declare `dsh: { bundle: { patch } }`, that file must exist and
 * name the package correctly, and the built entry must be loadable. npm will
 * happily publish a package the harness cannot load, and that failure only
 * surfaces at boot on someone else's machine — so it is checked here instead.
 *
 *   node scripts/pack-check.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const pass = (message) => notes.push(message);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/* ------------------------------------------------------------- identity */

if (pkg.name === "dsh-tinyfish") {
  pass(`name: ${pkg.name}@${pkg.version}`);
} else {
  fail(`name is "${pkg.name}"; the bundle row and docs assume "dsh-tinyfish"`);
  fail("the package must stay unscoped: the DSH loader resolves bundles by bare name");
}
if (pkg.private === true) {
  fail("`private: true` blocks publishing; a bundle only earns its keep from a registry");
} else {
  pass("not private, so it can be published");
}
for (const field of ["version", "license", "description", "engines"]) {
  if (!pkg[field]) fail(`no ${field} declared`);
}

/* --------------------------------------------------------- the dsh bundle */

const patch = pkg.dsh?.bundle?.patch;
if (!patch) {
  fail("manifest must declare dsh.bundle.patch — without it the package is just a library");
} else if (!existsSync(join(ROOT, patch))) {
  fail(`dsh.bundle.patch points at "${patch}", which does not exist`);
} else {
  pass(`dsh.bundle.patch -> ${patch}`);
}

/* ------------------------------------------------------- the built entry */

const entry = join(ROOT, pkg.main ?? "lib/index.js");
if (!existsSync(entry)) {
  fail(`main "${pkg.main}" does not exist — run \`pnpm run build\``);
} else {
  // Import the artifact, not the source: this is the file DSH resolves and npm
  // ships, and a source-level check would miss an emit that broke it.
  const mod = await import(`file://${entry}`);
  for (const name of ["apply", "inject", "name"]) {
    if (mod[name] === undefined) fail(`entry does not export ${name} (cordis requires it)`);
  }
  if (!Array.isArray(mod.inject) || mod.inject.length === 0) {
    fail("inject must be a non-empty array of service names");
  }
  // A plugin without a Config still loads, but its row renders as free-form
  // YAML instead of a settings section — worth knowing before shipping.
  if (!mod.Config) {
    fail("entry exports no Config; the settings row will not render as a section");
  } else {
    pass("entry exports a schemastery Config");
  }
  if (pkg.exports?.["./src/*"] !== "./src/*") {
    fail("exports should expose ./src/* — that is the convention across @deepseek-ai packages");
  }
  if (mod.name !== pkg.name) {
    fail(`entry's name export is "${mod.name}" but the manifest says "${pkg.name}"`);
  } else {
    pass(`built entry exports apply/inject/name, self-named ${mod.name}`);
  }

  const types = join(ROOT, pkg.types ?? "lib/index.d.ts");
  if (!existsSync(types)) {
    fail(`types "${pkg.types}" does not exist — run \`pnpm run build\``);
  } else {
    const dts = readFileSync(types, "utf8");
    for (const symbol of [
      "TinyfishSearchProvider",
      "TinyfishFetchProvider",
      // The seam's own error, not a private one: a package that invents its
      // own error class is invisible to the codes the seam routes on.
      "WebError",
      "TinyfishProviderOptions",
      "Config",
    ]) {
      if (!dts.includes(symbol)) fail(`emitted types do not declare ${symbol}`);
    }
    pass("emitted types declare the provider, error and options surface");
  }
}

/* ------------------------------------------------------------------ files */

for (const listed of pkg.files ?? []) {
  if (listed.includes("*")) continue;
  if (!existsSync(join(ROOT, listed))) fail(`files lists "${listed}", which is missing`);
}
// `lib` is matched as a pattern here: the published set is the emitted js and
// d.ts, deliberately without sourcemaps, so a literal "lib" entry would be
// wrong and a missing pattern would ship no code at all.
for (const required of ["lib", "cordis.patch.yml", "README.md", "LICENSE"]) {
  const covered = (pkg.files ?? []).some(
    (pattern) => pattern === required || pattern.startsWith(`${required}/`),
  );
  if (!covered) {
    fail(`files must include "${required}", or the published bundle cannot load`);
  }
}
if (pkg.files?.includes("src")) {
  fail("files must not include src — the built artifact is what ships");
}
pass(`files: ${(pkg.files ?? []).join(", ")}`);

/* ------------------------------------------------------------ size budget */

/**
 * A ceiling on what the tarball may weigh.
 *
 * This exists because the published artifact is what every consumer downloads
 * and audits, and nothing else in the gate notices a regression there. Source
 * maps were once half the tarball and nobody caught it by reading a diff.
 *
 * 60 kB is roughly three times the current size — enough headroom for a real
 * feature, tight enough that a stray asset or a re-enabled sourcemap is caught.
 */
const SIZE_BUDGET_BYTES = 60 * 1024;

let packed;
try {
  // `--ignore-scripts`: `prepare` runs `vp pack`, whose progress output would
  // land in stdout and turn this JSON into a parse error.
  const json = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  packed = JSON.parse(json)[0];
} catch (error) {
  fail(`could not measure the tarball: ${String(error)}`);
}

if (packed) {
  const bytes = packed.size;
  const kib = (bytes / 1024).toFixed(1);
  if (bytes > SIZE_BUDGET_BYTES) {
    fail(
      `tarball is ${kib} kB, over the ${(SIZE_BUDGET_BYTES / 1024).toFixed(0)} kB budget ` +
        "— check for a re-enabled sourcemap or a stray asset in files[]",
    );
  } else {
    pass(
      `tarball is ${kib} kB across ${packed.entryCount} entries, under the ` +
        `${(SIZE_BUDGET_BYTES / 1024).toFixed(0)} kB budget`,
    );
  }

  // A sourcemap embeds build paths and triples the artifact. It was a
  // deliberate exclusion, so re-enabling it should be a conscious act.
  const maps = packed.files.map((f) => f.path).filter((f) => f.endsWith(".map"));
  if (maps.length) {
    fail(`tarball ships sourcemaps (${maps.join(", ")}); this bundle excludes them on purpose`);
  }
}

/* ---------------------------------------------------------------- secrets */

// The tarball is what ships, so a key committed here would be published
// forever. Scan the whole source tree, not just the files list — a stray
// fixture is still a leak in a public repo.
const SECRET_PATTERNS = [
  [/\bmonid_live_[A-Za-z0-9]{10,}/, "a Monid platform API key"],
  [/\bsk-tinyfish-[A-Za-z0-9_-]{10,}/, "a TinyFish API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/sk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic API key"],
];

// A scanner that matches nothing is indistinguishable from a scanner that
// works, so prove each pattern still fires — and that it does not fire on the
// ordinary identifiers that legitimately contain these substrings.
//
// The canaries are assembled from fragments on purpose: a literal sample in
// this file would trip the scanner against itself, which is the same failure
// mode as a scanner that silently stopped working.
const parts = {
  monid: "monid_live_",
  tinyfish: "sk-tinyfish-",
  gh: "ghp_",
  anthropic: "sk-ant-",
};
const CANARIES = [
  [parts.monid + "AbCdEf1234567890", true],
  [parts.tinyfish + "Pm-QkiaUloPEyNN", true],
  [parts.gh + "abcdefghijklmnopqrstuvwxyz0123456789", true],
  [parts.anthropic + "api03-AbCdEf1234567890", true],
  [parts.monid, false],
  [parts.tinyfish, false],
  ["$MONID_API_KEY", false],
  ["TINYFISH_API_KEY", false],
  ["Authorization: Bearer <key>", false],
  [parts.tinyfish + "abc", false],
];
for (const [sample, shouldMatch] of CANARIES) {
  const matched = SECRET_PATTERNS.some(([pattern]) => pattern.test(sample));
  if (matched !== shouldMatch) {
    fail(`secret scanner is ${shouldMatch ? "not firing" : "firing"} on a safe sample: ${sample}`);
  }
}
if (!failures.length) pass(`secret patterns self-tested against ${CANARIES.length} samples`);

const SKIP_DIRS = new Set(["node_modules", ".git", "lib"]);
let scanned = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (
      SKIP_DIRS.has(name) ||
      name.startsWith(".build-check") ||
      name.endsWith(".tgz") ||
      name === "pnpm-lock.yaml"
    ) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(mjs|js|ts|json|yml|yaml|md)$/.test(name)) continue;
    const text = readFileSync(full, "utf8");
    scanned += 1;
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        fail(`${full.replace(`${ROOT}/`, "")} contains ${what}`);
      }
    }
  }
};
walk(ROOT);
pass(`scanned ${scanned} files for credentials`);

/* ----------------------------------------------------------------- report */

for (const note of notes) console.log(`  ok   ${note}`);
for (const message of failures) console.error(`  FAIL ${message}`);

if (failures.length) {
  console.error(`\npack:check failed — ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\npack:check passed");
