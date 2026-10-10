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
 *   node scripts/check.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures: string[] = [];
const notes: string[] = [];

const fail = (message: string): void => {
  failures.push(message);
};
const ok = (message: string): void => {
  notes.push(message);
};

/**
 * Report `message` only if the section that just ran added no failures.
 *
 * `fail()` does not stop the script — every section runs so one pass reports
 * everything wrong at once — which means an unconditional `ok()` prints a
 * green line right next to the red one it contradicts. That is what §9 did:
 * it printed "N toolchain scripts route through vp" even when the loop above
 * it had just failed one of those scripts. The failure count taken before the
 * section is the only signal that the section actually passed.
 */
const okIfClean = (before: number, message: string): void => {
  if (failures.length === before) ok(message);
};

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
function newestMtime(dir: string): number {
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
const peersBefore = failures.length;
for (const [name, range] of Object.entries(
  (pkg.peerDependencies ?? {}) as Record<string, unknown>
)) {
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
// Scoped to this section, like the surface check. The global count meant an
// unrelated failure earlier in the run suppressed this green line, so a clean
// peer set was reported as nothing at all — noise in the other direction from
// a false green, but the same cause: a check answering for work it did not do.
okIfClean(
  peersBefore,
  `${Object.keys(pkg.peerDependencies ?? {}).length} peer ranges npm can resolve`
);

/**
 * `dsh.compatibility.dshReleases` is documentation, so nothing downstream acts
 * on a wrong entry — which is exactly why one can rot. It claimed
 * `0.2.1-alpha.1` was `incompatible` because the peer range excluded it, and
 * widening that range made the claim false while leaving it in place. Two
 * documents disagreeing is the defect this closes.
 *
 * So the map is checked against the range it describes, in both directions:
 * a release called `compatible` must actually satisfy the range, and one
 * called `incompatible` must not. `unknown` asserts nothing — that is what it
 * means, and it is the honest label for a release the range admits and nothing
 * has run against.
 *
 * `semver` is declared rather than borrowed. It resolves as a transitive
 * dependency today, and every use of it here would have been one prune away
 * from vanishing — the same "works today for the wrong reason" shape as the
 * nested Oxlint config this repository spent a migration removing.
 */
const statedDshRange = String(pkg.dsh?.compatibility?.dsh ?? "");
const releases = (pkg.dsh?.compatibility?.dshReleases ?? {}) as Record<
  string,
  unknown
>;
const verdictsBefore = failures.length;
if (statedDshRange === "") {
  fail(
    "package.json states no `dsh.compatibility.dsh` range for the map to describe"
  );
} else if (Object.keys(releases).length === 0) {
  fail("package.json has no `dshReleases` verdicts to check against the range");
} else {
  for (const [version, verdict] of Object.entries(releases)) {
    if (verdict === "unknown") continue;
    const admitted = semver.satisfies(version, statedDshRange, {
      // A malformed key is a failure in its own right, and `satisfies` would
      // throw rather than answer — so it is caught here and named.
      loose: false,
    });
    if (verdict === "compatible" && !admitted) {
      fail(
        `dshReleases calls ${version} compatible, but \`${statedDshRange}\` does ` +
          "not admit it — the loader would refuse the plugin on that host"
      );
    } else if (verdict === "incompatible" && admitted) {
      fail(
        `dshReleases calls ${version} incompatible, but \`${statedDshRange}\` ` +
          "admits it — the map contradicts the range it documents"
      );
    }
  }
}
okIfClean(
  verdictsBefore,
  `${Object.keys(releases).length} \`dshReleases\` verdicts agree with \`${statedDshRange}\``
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

/**
 * A DSH bundle resolves through the profile's `node_modules`, keyed by the
 * name in `dsh.profile.bundles` and by each patch row's `name` — so the
 * manifest `name` is a runtime contract, not a label. This package's primary
 * name is the bare `dsh-tinyfish`: it is what the docs, the row id and the
 * loader's default route all use, and renaming it would be a runtime break
 * rather than a relabel. The scoped alias is a second published name, and it
 * works because `scripts/publish-scoped.ts` rewrites the row name to match
 * it; the exported `name` stays `dsh-tinyfish` either way.
 *
 * The repository URL is the other half of what those docs claimed. npm draws
 * the package page, the source link and the provenance from it, and a wrong
 * host there is invisible right up until someone follows the link.
 */
const BARE_NAME = "dsh-tinyfish";
if (pkg.name !== BARE_NAME) {
  fail(
    `the package is named "${pkg.name}"; a bundle is resolved by bare name, so it must be ${BARE_NAME}`
  );
} else {
  ok(`the package is named ${BARE_NAME}, the bare name the loader resolves`);
}
const repository: unknown =
  typeof pkg.repository === "object" && pkg.repository !== null
    ? pkg.repository.url
    : pkg.repository;
if (
  typeof repository !== "string" ||
  !repository.includes("viztor/dsh-tinyfish")
) {
  fail(
    `repository is ${JSON.stringify(repository)}; it must name github.com/viztor/dsh-tinyfish`
  );
} else {
  ok(`repository is ${repository}`);
}

/**
 * The harness publishes its `@deepseek-ai/dsh-*` packages as one set at one
 * version, so this repo has to type-check against the set the host actually
 * resolves. Section 4 below asserts every surface `src/` uses against
 * **these devDependencies' types**, which means a devDep left one release
 * behind makes that check assert last release's surfaces — and pass. That is
 * not hypothetical: `dsh-web`, `dsh-credentials` and `dsh-launch-environment`
 * sat at `0.2.0-rc.1` while the host was resolving `0.2.0-rc.2`, and every
 * gate was green throughout.
 *
 * One exact pin, not one per package and not a range: the harness ships them
 * together, and a caret can move on the next install to surfaces the host has
 * not shipped yet.
 */
const harnessDevDeps = Object.entries(
  (pkg.devDependencies as Record<string, string> | undefined) ?? {}
)
  .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"))
  .toSorted(([a], [b]) => a.localeCompare(b));
const harnessPins = new Set(harnessDevDeps.map(([, spec]) => spec));
if (harnessDevDeps.length === 0) {
  fail(
    "no @deepseek-ai/dsh-* devDependencies to check the harness surfaces against"
  );
} else if (harnessPins.size > 1) {
  fail(
    `the harness devDependencies disagree: ${[...harnessPins].toSorted().join(", ")}; the harness ships them as one version`
  );
} else {
  const [spec = ""] = [...harnessPins];
  if (/^[~^]/.test(spec) || spec === "*" || spec.includes(" - ")) {
    fail(
      `the @deepseek-ai/dsh-* devDependencies are pinned to ${spec}; one exact version or the surfaces can move under the lockfile`
    );
  } else {
    ok(
      `all ${harnessDevDeps.length} @deepseek-ai/dsh-* devDependencies pin ${spec}, the version the host resolves`
    );
  }
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

const REQUIRED: Record<string, [RegExp, string][] | undefined> = {
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

const surfacesBefore = failures.length;
let surfacesChecked = 0;
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
  surfacesChecked += 1;

  const dts = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const required = REQUIRED[name];
  assert.ok(required, `no surface contract for ${name}`);
  for (const [pattern, what] of required) {
    if (!pattern.test(dts)) fail(`${name} no longer exposes ${what}`);
  }
}
// Gated on how many packages were actually read, not on the absence of one
// particular message. The old form printed this line after every package had
// been skipped — a green claim that nothing had been checked, which is the
// failure mode this file exists to prevent — and printed it beside the "ships
// no readable type declarations" failure too, because that message does not
// contain the substring the filter tested for.
if (surfacesChecked === SURFACES.length) {
  okIfClean(
    surfacesBefore,
    "every harness surface this package depends on is present"
  );
} else {
  notes.push(
    `skip  only ${surfacesChecked} of ${SURFACES.length} harness packages were checked, so the surface contract is unproven`
  );
}

/* --------------------------------- 5. the lint and format configs are actually loaded */

/**
 * Vite+ **disables nested Oxlint and Oxfmt configs**. Standalone
 * `oxlint.config.ts` / `.oxfmtrc` beside a `vite.config.ts` are read by
 * nobody, so the rule tiers look enforced and are not — and lint stays green
 * because it is running Oxlint's defaults. That happened here: the effective
 * config was 111 rules with `options: null`, and moving both blocks into
 * `vite.config.ts` took it to 536 with `typeAware` and `typeCheck` on and
 * surfaced twelve real gate errors.
 *
 * A config that is present but inert is worse than a missing one, because
 * nothing says so. This asserts the loaded config is ours.
 */

/**
 * The defect classes this package decided are not acceptable in `src/`, which
 * is the one thing a rule *count* cannot see.
 *
 * The rest of this section asks whether the config loaded. This one asks
 * whether it still bites. Oxlint spells its severities `deny` / `warn` /
 * `allow`, and a `deny` flipped to `warn` leaves `Object.keys(rules).length`
 * exactly where it was, leaves `typeAware` on, and changes nothing about
 * `vp check`'s exit code — so every guard above it passes while the gate it
 * describes has quietly stopped gating. `warn` still prints, which reads like
 * enforcement and is not; only a build that counts warnings would notice, and
 * `vp check` does not.
 *
 * So each name is asserted at `deny`, and adding or removing one here has to
 * be a decision made twice. The list is deliberately the narrow set whose
 * absence would be a regression of a recorded commitment, not every `error`
 * in `vite.config.ts` — a metric rule promoted for style does not belong next
 * to `no-unsafe-type-assertion`.
 */
const GATES = [
  "typescript/no-floating-promises",
  "typescript/no-unsafe-type-assertion",
  "typescript/no-unsafe-argument",
  "typescript/no-unsafe-assignment",
  "typescript/no-unsafe-call",
  "typescript/no-unsafe-member-access",
  "typescript/no-unsafe-return",
  "typescript/no-unsafe-enum-comparison",
  "typescript/no-explicit-any",
  "typescript/no-non-null-assertion",
  "typescript/no-unnecessary-type-assertion",
  "typescript/strict-boolean-expressions",
  "typescript/prefer-nullish-coalescing",
  "typescript/return-await",
] as const;

/** A rule may be `"deny"` or `["deny", [options]]`; both mean denied. */
const severityOf = (rule: unknown): unknown =>
  Array.isArray(rule) ? rule[0] : rule;

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
  } else {
    const before = failures.length;
    for (const name of GATES) {
      const rule = effective.rules[name];
      if (rule === undefined) {
        fail(`${name} is absent from the effective config`);
      } else if (severityOf(rule) !== "deny") {
        fail(
          `${name} is ${String(severityOf(rule))}, not deny — a defect class is now a warning`
        );
      }
    }
    okIfClean(
      before,
      `lint config is live (${ruleCount} rules, typeAware on, ${GATES.length} gates at deny)`
    );
  }
} catch (error) {
  const detail =
    error instanceof Error ? error.message.split("\n")[0] : String(error);
  fail(`could not read the effective lint config: ${detail}`);
}

/* --------------------------------------------------- 6. no credentials in the tree */

/**
 * The tarball is what ships, so a key committed here would be published
 * forever. The patterns are self-tested: a scanner that matches nothing looks
 * exactly like a scanner that works, and this one is assembled from fragments
 * so it cannot trip over its own samples.
 */
const SECRETS: [RegExp, string][] = [
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
for (const [sample, shouldMatch] of CANARIES as [string, boolean][]) {
  if (SECRETS.some(([re]) => re.test(sample)) !== shouldMatch) {
    fail(
      `the secret scanner is ${shouldMatch ? "missing" : "over-matching"} on a sample`
    );
  }
}

/**
 * Directories that are not part of the tree this section is about.
 *
 * `node_modules` and `.git` are not ours. `coverage` is a report *about* the
 * tree, so scanning it reads every file a second time through a second path.
 *
 * `lib` is deliberately absent. It is half of what `npm pack` ships, so a key
 * inlined into the artifact would be published forever — which is the reason
 * this section exists, and the file extension allow-list below it compounds
 * the problem: `*.ts` does not match `*.tsx`, so `settings-page.tsx`, the
 * source file a pasted key was most likely to end up in, was outside the scan
 * while the comment above claimed the tarball was the point.
 */
const SKIP = new Set(["node_modules", ".git", "coverage"]);
/**
 * The complement of "text we might not have thought of".
 *
 * An allow-list of extensions has to be kept in step with every text format
 * this repository can hold, and the cost of forgetting one is a credential
 * nobody ever scanned for — a silent miss, which for this check is the only
 * failure mode that matters. A deny-list of the binary formats that would
 * otherwise be read as mojibake fails safe: an unknown file gets scanned and
 * wastes a millisecond.
 */
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|tar|wasm|node|mp[34]|mov|webm)$/;
let scanned = 0;
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (BINARY.test(name)) continue;
    scanned += 1;
    const text = readFileSync(full, "utf8");
    for (const [re, what] of SECRETS) {
      if (re.test(text))
        fail(`${full.replace(`${ROOT}/`, "")} contains ${what}`);
    }
  }
};
const cleanest = failures.length;
walk(ROOT);
okIfClean(cleanest, `scanned ${scanned} files for credentials`);

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

/**
 * The environment for the child `npm` calls.
 *
 * This check runs `npm pack` and `npm install` of its own, and those must do
 * real work. Under `npm publish` the parent exports `npm_config_*` — including
 * `npm_config_dry_run` — and a child that inherits it turns its own install
 * into a no-op. The check then reads a package that was never written and
 * fails with a message that names neither the cause nor the command, so the
 * one check that proves a consumer can install the package could not run in the
 * one situation it exists for: publishing.
 *
 * Stripping the whole `npm_config_` namespace is broader than dropping
 * `dry_run`, and deliberately so — a future npm setting that quietly changes
 * what an install writes is the same failure wearing a different name.
 */
const CHILD_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name))
);

try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      // `--ignore-scripts`: `prepare` runs `vp pack`, whose progress output
      // would otherwise land in this JSON and break the parse.
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      { cwd: ROOT, encoding: "utf8", env: CHILD_ENV }
    )
  )[0];

  const project = join(scratch, "consumer");
  // `mkdirSync`, not a `mkdir -p` child process: this is a directory inside
  // the scratch tree just made with `mkdtempSync`, and spawning a binary to
  // ask the operating system to create one is a second thing that can fail
  // for a reason (PATH, a stripped-down CI image) unrelated to the check.
  mkdirSync(project, { recursive: true });
  const peers = Object.entries(
    (pkg.peerDependencies ?? {}) as Record<string, unknown>
  ).map(([n, r]) => `${n}@${String(r)}`);
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
    {
      cwd: project,
      encoding: "utf8",
      env: CHILD_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    }
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

  // The files the manifest names, asserted in the tarball rather than in the
  // manifest. `npm pack` omits a `files` entry that does not exist, prints no
  // warning and exits 0 — so a build that stopped emitting `index.d.mts` would
  // publish a typeless package, and the types are the contract this package
  // exists to keep. Checking the field only proves someone wrote it down.
  for (const named of [pkg.main, pkg.types, "cordis.patch.yml"]) {
    if (typeof named === "string" && !existsSync(join(installed, named))) {
      fail(
        `the packed tarball is missing ${named}, which the manifest names — ` +
          "npm omits a missing `files` entry without failing"
      );
    }
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
    env: CHILD_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });

  ok(
    `installed the packed tarball with plain npm (${packed.entryCount} entries) and loaded the host half from it`
  );
} catch (error: unknown) {
  const err = error as { stderr?: string; message?: string };
  const detail = [err.stderr, err.message]
    .filter(Boolean)
    .join("\n")
    .split("\n")
    // ENOENT and the npm `code` line are the two this check has actually
    // produced. The old filter matched neither, so a failure reported an empty
    // detail and named neither the cause nor the command that failed.
    .filter((l) => /Error|Cannot find|ENOENT|EEXIST|npm error|code /.test(l))
    .slice(0, 3)
    .join(" | ");
  fail(`a consumer install or load failed: ${detail}`);
} finally {
  // No process.exit above: it does not unwind, and would leak the scratch.
  rmSync(scratch, { recursive: true, force: true });
}

/* ------------------------------------------------- 8. the release can fire */

/**
 * A publish job that cannot be reached is worse than no publish job: it reads
 * as a working release process in a file that looks right, and the failure only
 * appears at release time.
 *
 * This exists because that is exactly the bug this repository shipped. The
 * publish job lived in `ci.yml` behind `if: startsWith(github.ref, 'refs/tags/')`
 * while that workflow's only trigger was `push: branches: [main]`. A tag push
 * matches no branch, so the workflow never ran and the condition guarding the
 * publish was never evaluated by anything.
 */
const workflows = join(ROOT, ".github/workflows");
const release = readFileSync(join(workflows, "release.yml"), "utf8");
const ci = readFileSync(join(workflows, "ci.yml"), "utf8");

if (!/^\s*tags:\s*\[?\s*"?v\*\.\*\.\*"?/m.test(release)) {
  fail("release.yml does not trigger on v*.*.* tags — nothing would publish");
} else {
  ok("release.yml is triggered by a version tag");
}

if (!/^\s*tags-ignore:\s*\[?\s*"?v\*\.\*\.\*"?/m.test(ci)) {
  fail(
    "ci.yml does not ignore version tags; a tag push matches no branch, so " +
      "ci.yml never runs on one and anything gated on it is unreachable"
  );
} else {
  ok("ci.yml ignores version tags, leaving them to release.yml");
}

if (!/^\s*id-token:\s*write/m.test(release)) {
  fail(
    "release.yml has no id-token: write, so npm trusted publishing cannot " +
      "authenticate and the publish would need a stored token"
  );
} else {
  ok("release.yml grants id-token: write for OIDC trusted publishing");
}

// The guard has to *wrap* the publish. Matching the command's presence was
// satisfied by `npm view ... 2>/dev/null || true` followed by an unconditional
// publish, which is exactly the edit that loses the idempotency: npm refuses to
// republish, so a retried tag would fail the release with this check green.
const publishGuard =
  /if npm view [^\n]*version 2>\/dev\/null; then([\s\S]*?)\n\s*fi\b/.exec(
    release
  );
if (
  publishGuard === null ||
  publishGuard[1]?.includes("npm publish") !== true
) {
  fail(
    "release.yml does not skip an already-published version around the " +
      "publish, so re-running a tag fails on npm's refusal to republish"
  );
} else {
  ok("release.yml skips a version that is already on the registry");
}

/**
 * How long the release waits for npm to make a published version readable.
 *
 * This is the one release setting that has to be measured rather than guessed:
 * the two published names do not become readable in parallel, and the canonical
 * one — published first, and the popular one — is the slower. For v0.11.3 it
 * took 4m18s against the alias's 2m13s, and a three-minute budget failed a
 * release that had succeeded a minute earlier, naming Trusted Publishing as the
 * cause. Nobody reads that message as "wait longer" the first time.
 *
 * So the budget is asserted here rather than left to be tightened by someone
 * who assumes the shorter one was measured. Ten minutes is roughly twice the
 * worst observation, which is the margin a value nobody can query needs: there
 * is no API that answers "how long will this take".
 */
const INDEX_BUDGET_SECONDS = 10 * 60;
// The loop sleeps only while another attempt follows, so the wall clock it can
// spend is (attempts - 1) intervals — one less than the product. Reporting the
// product overstated the budget in the ok line and in both failure messages.
const attempts = Number(/^\s*attempts=(\d+)/m.exec(release)?.[1]);
const interval = Number(/^\s*interval=(\d+)/m.exec(release)?.[1]);
if (!attempts || !interval) {
  fail(
    "release.yml's publish verification does not declare attempts and " +
      "interval, so its budget cannot be asserted here"
  );
} else if ((attempts - 1) * interval < INDEX_BUDGET_SECONDS) {
  fail(
    `release.yml gives npm ${(attempts - 1) * interval}s to make a published ` +
      `version readable, under the ${INDEX_BUDGET_SECONDS}s budget — the ` +
      "canonical name has taken longer than that and the run reported a " +
      "successful release as failed"
  );
} else {
  ok(
    `release.yml waits up to ${(attempts - 1) * interval}s for npm to index a ` +
      "published version"
  );
}

/* --------------------------------------------------- 9. the toolchain is Vite+ */

/**
 * Vite+ is not just a preference here. It is what makes the lint and format
 * configuration *live*: it disables nested `oxlint.config` / `.oxfmtrc` files,
 * so a config in its own file is read by nobody and the gate passes with the
 * rules switched off. That is not hypothetical — it happened here, and CI was
 * green the whole time it was inert.
 *
 * So the toolchain is asserted rather than assumed: the package depends on
 * `vite-plus`, and every build/lint/format/test script goes through `vp`
 * rather than the underlying binaries, which would bypass the entry point that
 * reads the config at all.
 */
const TOOLCHAIN = ["build", "check", "fix", "format", "lint", "test"];
const UNBYPASSED = /(?:^|[\s(])(oxlint|oxfmt|tsdown|vitest|tsc)(?:[\s)]|$)/;

if (!pkg.devDependencies?.["vite-plus"]) {
  fail("the package does not depend on vite-plus; the toolchain is unpinned");
} else {
  ok(`the toolchain is vite-plus (${pkg.devDependencies["vite-plus"]})`);
}

const cleanestToolchain = failures.length;
for (const name of TOOLCHAIN) {
  const script = pkg.scripts?.[name];
  if (!script) {
    fail(`no ${name} script`);
  } else if (!/\bvp\b/.test(script)) {
    fail(`the ${name} script does not go through vp: ${script}`);
  } else if (UNBYPASSED.test(script.replaceAll(/\bvp\b[^\s]*/g, ""))) {
    // `vp check` covers types too, so a bare `tsc` alongside it is redundant
    // rather than wrong — but a bare oxlint/oxfmt/vitest is a bypass.
    const bare = script.match(new RegExp(UNBYPASSED, "g")) ?? [];
    const real = bare.filter((tool: string) => tool.trim() !== "tsc");
    if (real.length > 0) {
      fail(
        `the ${name} script reaches past vp for ${real.map((t: string) => t.trim()).join(", ")}; ` +
          "that bypasses the entry point that reads the config"
      );
    }
  }
}
okIfClean(
  cleanestToolchain,
  `${TOOLCHAIN.length} toolchain scripts route through vp`
);

/* -------------------------------------------- 10. the scoped alias ships too */

/**
 * `@viztor/dsh-tinyfish` is the same content under the organisation scope, and
 * the only thing keeping the two in sync is that one job publishes both from
 * one tree. If the release workflow stops calling the scoped step — edited out
 * in a hurry, lost in a merge — the unscoped package moves on and the alias
 * silently goes stale, and a consumer on the scoped name gets an old plugin
 * with no indication that it is old.
 */
const releaseYml = readFileSync(join(workflows, "release.yml"), "utf8");
if (!releaseYml.includes("scripts/publish-scoped.ts")) {
  fail(
    "release.yml does not publish the scoped alias; @viztor/dsh-tinyfish " +
      "would go stale while dsh-tinyfish moves on"
  );
} else {
  ok("release.yml publishes @viztor/dsh-tinyfish from the same tree");
}

/**
 * The mirror is a second registry, and publishing is not shipping. GitHub
 * Packages indexes on its own schedule, and README.md promises this name as the
 * fallback when npmjs.org is unreachable — a promise that only holds if the
 * step runs at all.
 *
 * Nothing else in this gate knows the mirror exists: `scripts/publish-scoped.ts`
 * appears in the workflow for the npmjs alias too, so the check above is
 * satisfied with the mirror step deleted. That is the shape of the gap this
 * closes — the claim in README.md, the sidebar, and the fallback all rest on a
 * step no assertion mentioned.
 */
if (
  !/PUBLISH_REGISTRY=https:\/\/npm\.pkg\.github\.com[^\n]*publish-scoped\.ts/.test(
    releaseYml
  )
) {
  fail(
    "release.yml does not mirror @viztor/dsh-tinyfish to GitHub Packages; " +
      "README.md promises that name as a fallback and the repository sidebar " +
      "reads from it"
  );
} else {
  ok("release.yml mirrors @viztor/dsh-tinyfish to GitHub Packages");
}

/**
 * And the mirror is verified, not assumed — the other half of the same gap.
 * The verification step read back both npmjs names and never looked at the
 * registry the fallback actually lives on, so a mirror that failed to index was
 * reported as a successful release.
 *
 * The token is asserted alongside the registry rather than left to review.
 * GitHub Packages answers an unauthenticated request with a 404 that does not
 * distinguish "absent" from "not allowed to look", so a verification that lost
 * the token would poll for ten minutes and then report a healthy mirror as
 * missing — the false red the npmjs budget was fixed for, moved to a second
 * registry.
 */
if (
  !/npm view [^\n]*--registry=https:\/\/npm\.pkg\.github\.com[^\n]*_authToken=/.test(
    releaseYml
  )
) {
  fail(
    "release.yml publishes to GitHub Packages but never verifies it, or " +
      "verifies it without the token that registry requires — an " +
      "unauthenticated check 404s and reports a healthy mirror as missing"
  );
} else {
  ok("release.yml verifies the GitHub Packages mirror");
}

/**
 * Both workflows enumerate the gates by hand rather than calling
 * `pnpm run ci`, and that is deliberate: each step carries the reason it
 * exists, and one `- run: pnpm run ci` would delete that reasoning from the
 * file a reader opens. The cost is two lists, and the script is the one that
 * drifts — a step added there would run locally and never in CI, which stays
 * invisible until a release depends on it. So they are compared instead.
 *
 * By tail, because the script says `vp check` where the workflows say
 * `pnpm exec vp check`: the same gate, spelled for the environment it runs in.
 */
const ciSteps = String(pkg.scripts?.ci ?? "")
  .split("&&")
  .map((step) => step.trim().replace(/^pnpm (?:exec|run) /, ""))
  .filter((step) => step !== "");
const missingCi: string[] = [];
if (ciSteps.length === 0) {
  fail("package.json has no `ci` script for the workflows to mirror");
} else {
  for (const [file, text] of [
    ["ci.yml", ci],
    ["release.yml", release],
  ] as const) {
    const runs = [...text.matchAll(/^\s*-?\s*run:\s*(.+)$/gm)].map((match) =>
      (match[1] ?? "").trim().replace(/^pnpm (?:exec|run) /, "")
    );
    for (const step of ciSteps) {
      if (!runs.some((run) => run.includes(step))) {
        missingCi.push(`${step} (${file})`);
      }
    }
  }
  if (missingCi.length > 0) {
    fail(
      `these \`ci\` steps never run in CI: ${missingCi.join(", ")} — the ` +
        "workflows list the gates by hand, so the script is the list that drifts"
    );
  } else {
    ok(`both workflows run all ${ciSteps.length} \`ci\` steps`);
  }
}

/**
 * The live suite runs in both workflows, but not through `pnpm run test:live`:
 * that script hard-codes `DSH_TINYFISH_LIVE=1` for a human at a terminal, which
 * would override whatever CI resolved the flag to, and the workflow has to be
 * able to *not* run the suite when the credentials are absent. So both workflows
 * name the runner directly.
 *
 * Which means the command is written out three times — the script and two
 * workflows — and renaming the live config would leave CI running nothing while
 * reporting green. The comparison is by tail, for the same reason as `ciSteps`
 * above: the script spells the flag as an inline assignment the workflows carry
 * in `env:`, so the runner invocation after it is the part that must agree.
 */
const liveRunner = (script: string): string =>
  script
    .replace(/^DSH_TINYFISH_LIVE=\S+\s*/, "")
    .replace(/^pnpm (?:exec|run)\s+/, "");
const expectedLive = liveRunner(String(pkg.scripts?.["test:live"] ?? ""));
const liveWorkflows: string[] = [];
for (const [file, text] of [
  ["ci.yml", ci],
  ["release.yml", release],
] as const) {
  if (expectedLive.length === 0) continue;
  const runsLive = [...text.matchAll(/^\s*-?\s*run:\s*(.+)$/gm)].some((match) =>
    (match[1] ?? "").trim().includes(expectedLive)
  );
  if (!runsLive) liveWorkflows.push(file);
}
if (expectedLive.length === 0) {
  fail("package.json has no `test:live` script for the workflows to mirror");
} else if (liveWorkflows.length > 0) {
  fail(
    `the live suite does not run in: ${liveWorkflows.join(", ")} — ` +
      `neither workflow invokes \`${expectedLive}\`, so they would report green ` +
      "while never touching a real API. The flag is passed through `env:` rather " +
      "than inline, which is why this is not covered by the `ci` step comparison above"
  );
} else {
  ok(`both workflows run the live suite (\`${expectedLive}\`)`);
}

/**
 * The alias is only equivalent if its own patch points at the scoped name. A
 * scoped package whose patch still inserts `name: "dsh-tinyfish"` installs
 * cleanly and then mounts a plugin that is not there — the host resolves a row
 * name to a `node_modules` path, and `dsh-opencode-patch` shipped exactly that
 * failure ("failed to import") when its row kept the unscoped name.
 *
 * `publish-scoped.ts` already asserts that rewrite, but only at publish time:
 * the discovery would arrive with a tag push. Running its dry run here moves
 * that to every gate, and it exercises the real transform rather than a second
 * copy of it, which is the copy that would drift.
 */
const SCOPED_ALIAS = "@viztor/dsh-tinyfish";
try {
  const dryRun = execFileSync(process.execPath, ["scripts/publish-scoped.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    // `PUBLISH_DRY_RUN` builds the scratch tree and stops before the network.
    env: { ...CHILD_ENV, PUBLISH_DRY_RUN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const missing = [
    [`"name": "${SCOPED_ALIAS}"`, "the scoped manifest name"],
    [`name: "${SCOPED_ALIAS}"`, "the rewritten patch row name"],
    ["ships lib/client.js", "lib/client.js"],
    ["ships locale/en.json", "locale/en.json"],
  ]
    .filter(([needle]) => !dryRun.includes(needle ?? ""))
    .map(([, label]) => label);
  if (missing.length > 0) {
    fail(`the scoped alias would publish without ${missing.join(", ")}`);
  } else {
    ok("the scoped alias repacks under its own name in manifest and patch");
  }
} catch (error: unknown) {
  const err = error as { stderr?: string; message?: string };
  const detail = [err.stderr, err.message]
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .slice(0, 3)
    .join(" | ");
  fail(`the scoped alias dry run failed: ${detail}`);
}

/* ------------------------------------------ 11. the client stays lean */

/**
 * The client bundle ships to every browser that opens Settings, on every
 * page load that includes it. It must stay small because it is parsed and
 * evaluated before the page it belongs to can render — and because the most
 * common way it grows is by accident: bundling React, the primitives, or a
 * Node polyfill instead of leaving them external, which multiplies its size by
 * an order of magnitude overnight.
 *
 * 25KB is generous headroom over today's ~15KB. It is a ceiling, not a target:
 * a change that needs more room raises it deliberately, in the diff, with a
 * reason — which is the point.
 */
const CLIENT_BUDGET = 25 * 1024;
// Guarded, not assumed. Unguarded, a missing `lib/` threw ENOENT from here
// right after §1 recorded it, so the report below never printed and the
// operator got a stack trace instead of "run `pnpm run build`".
const clientPath = join(ROOT, "lib/client.js");
if (!existsSync(clientPath)) {
  fail("lib/client.js is missing — run `pnpm run build`");
} else {
  const clientStat = statSync(clientPath);
  if (clientStat.size > CLIENT_BUDGET) {
    fail(
      `lib/client.js is ${clientStat.size} bytes, over the ${CLIENT_BUDGET} budget — ` +
        "a dependency was likely bundled instead of left external"
    );
  } else {
    ok(`lib/client.js is ${clientStat.size} bytes, under budget`);
  }
}

/* ----------------------------- 12. translations track the English README */

/**
 * README.zh.md and README.ja.md are translations, not independent documents:
 * a section added to one side and not the others is a silent fork, and a code
 * block edited in translation quietly diverges from what the reader can run.
 * The check compares structure, not prose — heading levels in order, and
 * fenced code block counts — because prose legitimately differs while
 * structure must not. Fences are tracked so a `#` comment inside a sample is
 * not read as a heading.
 */
const structureOf = (text: string): string => {
  const segments: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      segments.push("fence");
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const level = /^(#{1,6})\s/.exec(line)?.[1]?.length;
    if (level !== undefined) segments.push(`h${level}`);
  }
  return segments.join(" ");
};

// The matcher earns its place only if it sees what it claims to: a `#`
// comment inside a fence is not a heading, and a dropped section or an added
// block changes the sequence. A matcher blind to either would pass a forked
// translation the way an untested secret scanner passes everything.
const fencedComment = [
  "# Title",
  "```sh",
  "# a comment, not a heading",
  "```",
  "## Body",
].join("\n");
if (structureOf(fencedComment) !== "h1 fence fence h2") {
  fail("the doc-structure matcher counts a fenced comment as a heading");
}
const driftedTranslation = [
  "# Title",
  "```sh",
  "```",
  "## Body",
  "### Extra",
].join("\n");
if (structureOf(driftedTranslation) === structureOf(fencedComment)) {
  fail("the doc-structure matcher cannot see a drifted translation");
}

const englishStructure = structureOf(
  readFileSync(join(ROOT, "README.md"), "utf8")
);
for (const name of ["README.zh.md", "README.ja.md"]) {
  const path = join(ROOT, name);
  if (!existsSync(path)) {
    fail(`${name} is missing — translate README.md and keep its structure`);
    continue;
  }
  if (structureOf(readFileSync(path, "utf8")) !== englishStructure) {
    fail(
      `${name} no longer tracks README.md: headings or code fences differ, ` +
        "so one side gained, lost, or re-leveled a section"
    );
  } else {
    ok(`${name} tracks README.md structurally`);
  }
}

/* ------------------------------------------------------------------- report */

for (const note of notes) console.log(`  ok   ${note}`);
for (const message of failures) console.error(`  FAIL ${message}`);

if (failures.length) {
  console.error(`\ncheck failed — ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\ncheck passed");
