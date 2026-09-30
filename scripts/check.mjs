/**
 * Package checks — one script, run once, in CI and before a release.
 *
 * There were five of these, 852 lines, which is more checking code than a third
 * of the source it guarded. Most of that was ceremony. What survives is the set
 * of checks that would actually catch a shipping mistake, sharing one `npm
 * pack` instead of each paying for its own.
 *
 * What was cut, and why:
 *
 * - **Build freshness by rebuilding and diffing** (118 lines). `release:gate`
 *   is `build && ci`, so the diff ran against a build made seconds earlier by
 *   the same command. It could not fail on the path that mattered. An mtime
 *   comparison catches the case it existed for — edit `src/`, forget to
 *   rebuild, harness loads stale `lib/` — in fifteen lines.
 * - **A replay of DSH's own peer-semver rule** (94 lines). DSH refuses to load
 *   an incompatible plugin and says so in a paragraph. Re-deriving that verdict
 *   from the profile bought a clearer message at the cost of owning a copy of
 *   someone else's rulebook.
 * - **Tarball size budget and a sourcemap guard.** Neither has ever fired, and
 *   the `files` patterns already exclude maps.
 * - **"The entry self-names correctly".** The test suite imports the entry and
 *   asserts it; a separate copy of that assertion was decoration.
 *
 * What stayed is the part that found real defects: a peer range npm cannot
 * parse made this package uninstallable, and only installing it for real
 * catches that.
 *
 *   node scripts/check.mjs
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const ok = (message) => notes.push(message);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/* ------------------------------------------------------- 1. lib/ is current */

/**
 * `lib/` is gitignored so a stale copy cannot be committed, which also means
 * nothing else notices when it lags `src/`. The tests read `src/` directly, so
 * only the harness would see the old artifact — at boot, on a machine that is
 * not this one.
 *
 * Timestamps rather than a rebuild-and-diff: the rebuild is already an earlier
 * step of every flow this runs in, and comparing against it would be comparing
 * a build to itself.
 */
function newestMtime(dir) {
  let newest = 0;
  for (const name of readdirSync(dir, { recursive: true })) {
    const full = join(dir, String(name));
    try {
      if (statSync(full).isFile())
        newest = Math.max(newest, statSync(full).mtimeMs);
    } catch {
      // Racing a build is not a failure; skip it.
    }
  }
  return newest;
}

const lib = join(ROOT, "lib");
if (!existsSync(lib)) {
  fail("lib/ is missing — run `pnpm run build`");
} else if (newestMtime(join(ROOT, "src")) > newestMtime(lib)) {
  fail(
    "src/ is newer than lib/ — run `pnpm run build`, or DSH will load the old one"
  );
} else {
  ok("lib/ is newer than src/");
}

/* ------------------------------------------- 2. peers npm must be able to read */

/**
 * A peer range is read twice: by DSH's loader, and by npm when someone
 * installs. `workspace:^` satisfies the first and breaks the second — npm
 * answers EUNSUPPORTEDPROTOCOL — and this package shipped that way once.
 *
 * An exact pin is the other failure: it satisfies npm and orphans the plugin
 * on every DSH prerelease, with a per-machine exemption as the only remedy.
 */
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (typeof range !== "string" || range.trim() === "") {
    fail(`peer ${name} has no usable range`);
    continue;
  }
  if (/^(workspace|link|file|catalog):/.test(range)) {
    fail(
      `peer ${name} uses "${range.split(":")[0]}:" — npm cannot parse it, so install fails`
    );
    continue;
  }
  if (!/^[\^~><=|*]/.test(range.trim())) {
    fail(
      `peer ${name} is pinned to "${range}" — a DSH patch release would orphan the plugin`
    );
  }
}
if (!failures.length)
  ok(
    `${Object.keys(pkg.peerDependencies ?? {}).length} peer ranges npm can resolve`
  );

/* ------------------------------------------- 3. it is a bundle, and it loads */

const patch = pkg.dsh?.bundle?.patch;
if (!patch) {
  fail("no dsh.bundle.patch — DSH would install this and then ignore it");
} else if (existsSync(join(ROOT, patch))) {
  ok(`dsh.bundle.patch -> ${patch}`);
} else {
  fail(`dsh.bundle.patch points at "${patch}", which does not exist`);
}
for (const field of ["main", "types"]) {
  if (!pkg[field]) fail(`no ${field} declared`);
}

/* --------------------------------------- 4. the harness surfaces are still there */

/**
 * The `@deepseek-ai/dsh-*` peers are ranges, so DSH will not catch a *contract*
 * break — only a version mismatch. This is what replaces that: every surface
 * `src/` imports or implements, asserted against the versions actually
 * installed. A failure here names what moved instead of surfacing as a boot
 * error on someone's machine.
 */
const SURFACES = [
  "@deepseek-ai/dsh-web",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-launch-environment",
];

const REQUIRED = {
  "@deepseek-ai/dsh-web": [
    [
      /export declare class WebError/,
      "WebError — every failure this package raises",
    ],
    [
      /interface WebSearchProvider\b/,
      "WebSearchProvider — implemented by the search provider",
    ],
    [
      /interface WebFetchProvider\b/,
      "WebFetchProvider — implemented by the fetch provider",
    ],
    [/interface WebSearchResult\b/, "WebSearchResult — returned by search()"],
    [/interface WebFetchResult\b/, "WebFetchResult — returned by fetch()"],
    [
      /kind:\s*'text'/,
      "WebFetchBody's 'text' arm — without it the provider must return 'html'",
    ],
  ],
  "@deepseek-ai/dsh-credentials": [
    [/credentialRef\(/, "credentialRef() — the credential-ref config role"],
    [/resolve\(ref: CredentialRef\)/, "the credentials service's resolve()"],
  ],
  "@deepseek-ai/dsh-launch-environment": [
    [
      /launchEnvironmentOf\(/,
      "launchEnvironmentOf() — the boot-frozen env lookup",
    ],
  ],
};

for (const name of SURFACES) {
  let dir;
  try {
    dir = dirname(
      execFileSync(
        process.execPath,
        [
          "-e",
          `process.stdout.write(require.resolve(${JSON.stringify(`${name}/package.json`)}))`,
        ],
        { cwd: ROOT, encoding: "utf8" }
      )
    );
  } catch {
    // Not installed: a devDependency is missing, not a contract break.
    notes.push(
      `skip  ${name} is not installed, so its surfaces were not checked`
    );
    continue;
  }

  // Every declaration file, concatenated. Testing only the first one that
  // exists reads a re-export barrel for some packages — dsh-credentials keeps
  // its declarations in index.d.ts while types.d.ts just re-exports them — and
  // reports a contract break that is not there.
  const files = [
    "lib/types/types.d.ts",
    "lib/types/index.d.ts",
    "lib/index.d.ts",
  ]
    .map((p) => join(dir, p))
    .filter(existsSync);
  if (files.length === 0) {
    fail(`${name} ships no readable type declarations — the contract moved`);
    continue;
  }

  const dts = files.map((f) => readFileSync(f, "utf8")).join("\n");
  for (const [pattern, what] of REQUIRED[name]) {
    if (!pattern.test(dts)) fail(`${name} no longer exposes ${what}`);
  }
}
if (!failures.some((f) => f.includes("no longer exposes"))) {
  ok("every harness surface this package depends on is present");
}

/* --------------------------------- 5. the lint and format configs are actually loaded */

/**
 * Vite+ **disables nested Oxlint and Oxfmt configs**. Standalone
 * `oxlint.config.ts` / `oxfmt.config.ts` beside a `vite.config.ts` are read by
 * nobody, so the rule tiers look enforced and are not — and lint stays green
 * because it is running Oxlint's defaults. That happened here: the effective
 * config was 111 rules with `options: null`, and moving both blocks into
 * `vite.config.ts` took it to 536 with `typeAware` and `typeCheck` on and
 * surfaced twelve real gate errors.
 *
 * A config that is present but inert is worse than a missing one, because
 * nothing says so. This asserts the loaded config is ours.
 */
try {
  const printed = execFileSync(
    "pnpm",
    ["exec", "vp", "lint", "--print-config"],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const effective = JSON.parse(printed.slice(printed.indexOf("{")));
  const ruleCount = Object.keys(effective.rules ?? {}).length;

  // A floor, not an exact count: the point is "our block was applied", and the
  // default set is an order of magnitude smaller.
  if (ruleCount < 300) {
    fail(
      `the effective lint config has ${ruleCount} rules — the \`lint\` block in vite.config.ts is not being loaded`
    );
  } else if (effective.options?.typeAware !== true) {
    fail("typeAware is off, so every typescript/* gate is listed but inert");
  } else if (effective.rules["typescript/no-floating-promises"] === undefined) {
    fail("the effective config is missing this package's own gates");
  } else {
    ok(`lint config is live (${ruleCount} rules, typeAware on)`);
  }
} catch (error) {
  fail(
    `could not read the effective lint config: ${String(error.message).split("\n")[0]}`
  );
}

/* --------------------------------------------------- 6. no credentials in the tree */

/**
 * The tarball is what ships, so a key committed here would be published
 * forever. The patterns are self-tested: a scanner that matches nothing looks
 * exactly like a scanner that works, and this one is assembled from fragments
 * so it cannot trip over its own samples.
 */
const SECRETS = [
  [/\bmonid_live_[A-Za-z0-9]{10,}/, "a Monid platform key"],
  [/\bsk-tinyfish-[A-Za-z0-9_-]{10,}/, "a TinyFish key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/sk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic key"],
];

const parts = { m: "monid_live_", t: "sk-tinyfish-", g: "ghp_", a: "sk-ant-" };
const CANARIES = [
  [`${parts.m}AbCdEf1234567890`, true],
  [`${parts.t}Pm-QkiaUloPEyNN`, true],
  [`${parts.g}abcdefghijklmnopqrstuvwxyz0123456789`, true],
  [`${parts.a}api03-AbCdEf1234567890`, true],
  [parts.m, false],
  [parts.t, false],
  ["$MONID_API_KEY", false],
  ["Authorization: Bearer <key>", false],
];
for (const [sample, shouldMatch] of CANARIES) {
  if (SECRETS.some(([re]) => re.test(sample)) !== shouldMatch) {
    fail(
      `the secret scanner is ${shouldMatch ? "missing" : "over-matching"} on a sample`
    );
  }
}

const SKIP = new Set(["node_modules", ".git", "lib"]);
let scanned = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (
      SKIP.has(name) ||
      name.startsWith(".build-check") ||
      name.endsWith(".tgz")
    )
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(mjs|js|ts|json|yml|yaml|md)$/.test(name)) continue;
    scanned += 1;
    const text = readFileSync(full, "utf8");
    for (const [re, what] of SECRETS) {
      if (re.test(text))
        fail(`${full.replace(`${ROOT}/`, "")} contains ${what}`);
    }
  }
};
walk(ROOT);
ok(`scanned ${scanned} files for credentials`);

/* ------------------------------ 7. install it the way a consumer will, and load it */

/**
 * The check that earns its keep. Everything above inspects this working tree;
 * this is the only one that exercises what a consumer receives, and it is what
 * caught `workspace:^` making the package uninstallable.
 *
 * Peers are installed explicitly at the manifest's own ranges, because a DSH
 * host provides them — skipping them would test a scenario that cannot happen
 * for a bundle that is only ever loaded by DSH.
 */
const scratch = mkdtempSync(join(tmpdir(), "dsh-tinyfish-"));
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      // `--ignore-scripts`: `prepare` runs `vp pack`, whose progress output
      // would otherwise land in this JSON and break the parse.
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      { cwd: ROOT, encoding: "utf8" }
    )
  )[0];

  const project = join(scratch, "consumer");
  execFileSync("mkdir", ["-p", project]);
  const peers = Object.entries(pkg.peerDependencies ?? {}).map(
    ([n, r]) => `${n}@${r}`
  );
  execFileSync(
    "npm",
    [
      "install",
      join(scratch, packed.filename),
      ...peers,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
    { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );

  const installed = join(project, "node_modules/dsh-tinyfish");
  const installedManifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8")
  );
  if (installedManifest.dsh?.bundle?.patch === undefined) {
    fail(
      "the published manifest lost dsh.bundle.patch — DSH would ignore the package"
    );
  }

  // Loaded from the installed copy, not this tree.
  const probe = `
    const m = await import(${JSON.stringify(join(installed, pkg.main))});
    const ctx = {
      web: { registerSearchProvider: (p) => (globalThis.__s = p), registerFetchProvider: (p) => (globalThis.__f = p) },
      get: () => undefined,
    };
    if (typeof m.apply !== "function") throw new Error("no apply()");
    if (typeof m.Config !== "function") throw new Error("no Config");
    m.apply(ctx, m.Config({}));
    if (globalThis.__s?.id !== "tinyfish" || globalThis.__f?.id !== "tinyfish") {
      throw new Error("providers did not register under the expected id");
    }
    process.stdout.write("ok");
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  ok(
    `installed the packed tarball with plain npm (${packed.entryCount} entries) and loaded the host + client halves`
  );
} catch (error) {
  const detail = [error.stderr, error.message]
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .filter((l) => /Error|Cannot find/.test(l))
    .slice(0, 2)
    .join(" | ");
  fail(`a consumer install or load failed: ${detail}`);
} finally {
  // No process.exit above: it does not unwind, and would leak the scratch.
  rmSync(scratch, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- report */

for (const note of notes) console.log(`  ok   ${note}`);
for (const message of failures) console.error(`  FAIL ${message}`);

if (failures.length) {
  console.error(`\ncheck failed — ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\ncheck passed");
