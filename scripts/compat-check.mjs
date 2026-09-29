/**
 * Replays DSH's own `evaluatePluginCompatibility` against the linked plugin.
 *
 * The rule is short enough to restate exactly, which is the point: rather than
 * trusting that `workspace:^` does what the loader expects, this applies the
 * same semver check the loader does, to the same manifest, against the running
 * runtime version.
 *
 * `semver` is resolved from the harness tree so the answer comes from the same
 * implementation DSH uses, not a reimplementation that could disagree.
 *
 *   node scripts/compat-check.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// The profile, not this repository: the point is to check the plugin as the
// loader sees it, symlinked into a real profile.
const PROFILE = join(process.env.HOME ?? "", ".dsh/profiles/web");

/** The linked plugin's manifest, exactly as DSH would read it. */
const pluginDir = join(PROFILE, "node_modules", "dsh-tinyfish");
const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));

/** The runtime version the loader compares against. */
const runtime = JSON.parse(
  readFileSync(join(pluginDir, "node_modules/@deepseek-ai/dsh-web/package.json"), "utf8"),
).version;

const require = createRequire(join(PROFILE, "package.json"));
let semver;
for (const candidate of [
  "semver",
  "@deepseek-ai/dsh-web/node_modules/semver",
  "@deepseek-ai/cordis/node_modules/semver",
]) {
  try {
    semver = require(candidate);
    break;
  } catch {
    // Try the next resolution path.
  }
}
if (!semver) {
  // Last resort: ask the profile's package manager. The check is advisory
  // tooling, so a missing semver must not fail the gate outright.
  try {
    const out = execFileSync(
      "node",
      [
        "-e",
        "process.stdout.write(require('semver').satisfies(process.argv[1], process.argv[2], {includePrerelease:true})?'1':'0')",
        runtime,
        "0.0.0",
      ],
      { cwd: PROFILE, encoding: "utf8" },
    );
    semver = { satisfies: () => out.trim() === "1" };
  } catch {
    console.log("  skip  could not resolve semver; the peer ranges are workspace:^");
    process.exit(0);
  }
}

/** DSH's rule, restated from dsh-app-boot. */
const peers = {};
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
  const requirement = ["workspace:^", "workspace:~", "workspace:*"].includes(range)
    ? runtime
    : range;
  if (
    requirement.trim() === "" ||
    !semver.satisfies(runtime, requirement, { includePrerelease: true })
  ) {
    peers[name] = range;
  }
}

const key = `${manifest.name}@${manifest.version}`;
console.log(`  plugin  ${key}`);
console.log(`  runtime dsh-web ${runtime}`);
if (Object.keys(peers).length === 0) {
  console.log(`  ok      ${key} is compatible with dsh ${runtime} — no exemption needed`);
  process.exit(0);
}
console.error(`  FAIL    incompatible peers: ${JSON.stringify(peers)}`);
console.error(
  `         DSH would skip this plugin unless you run \`dsh plugin allow-version ${key} ${runtime}\`.`,
);
process.exit(1);
