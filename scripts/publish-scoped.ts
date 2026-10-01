/**
 * Publish the built package under its scoped alias.
 *
 * The package ships as `dsh-tinyfish` — the name DSH resolves, the name the
 * docs use, the name release-please versions. `@viztor/dsh-tinyfish` is the
 * same content under the organisation scope, for consumers who install by
 * scope and for the registry presence. The two must never diverge, so this
 * script publishes the scoped copy from the same built tree, in the same job,
 * immediately after the unscoped publish — never separately, never by hand.
 *
 * It runs with `--ignore-scripts` because the unscoped publish already ran the
 * full gate (`prepublishOnly` → build, check, test, package checks). Running
 * it twice would double the release time for no new information.
 *
 * Usage: node scripts/publish-scoped.ts
 * Environment: runs inside the release workflow, authenticated by OIDC.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPED = "@viztor/dsh-tinyfish";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
  files: string[];
};
const version: string = pkg.version;

// Skip, don't fail, when the scoped copy is already out. npm refuses to
// republish a version, so without this a retried tag — a failed first attempt,
// a re-pushed tag — fails the whole release instead of resuming. Same rule as
// the unscoped step in release.yml.
try {
  const published = execFileSync(
    "npm",
    ["view", `${SCOPED}@${version}`, "version"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
  if (published === version) {
    console.log(`${SCOPED}@${version} is already on npmjs, skipping`);
    process.exit(0);
  }
} catch {
  // Not published yet — continue below.
}

// A temp copy, not an in-place rewrite. The working tree's package.json keeps
// the unscoped name that DSH, the docs, and release-please all read; the
// scoped name exists only inside this tarball.
const scratch = mkdtempSync(join(tmpdir(), "dsh-tinyfish-scoped-"));
try {
  // `files` lists what ships, but `package.json` itself is implied by npm
  // rather than listed — so it is copied explicitly, or there is nothing to
  // rename below.
  for (const file of [...pkg.files, "package.json"]) {
    cpSync(join(ROOT, file), join(scratch, file), { recursive: true });
  }
  const manifest = JSON.parse(
    readFileSync(join(scratch, "package.json"), "utf8")
  ) as Record<string, unknown>;
  manifest.name = SCOPED;
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  // Provenance needs OIDC, which exists only in CI. Locally there is no
  // identity provider, so npm errors with "Automatic provenance generation
  // not supported" — which is accurate and useless. Detect the environment
  // rather than adding a flag, because a flag would be forgotten exactly when
  // it matters and the failure would return.
  const inCI =
    process.env["CI"] === "true" || process.env["GITHUB_ACTIONS"] === "true";
  execFileSync(
    "npm",
    [
      "publish",
      scratch,
      ...(inCI ? ["--provenance"] : []),
      "--access",
      "public",
      "--ignore-scripts",
    ],
    { cwd: ROOT, stdio: "inherit" }
  );
  console.log(`published ${SCOPED}@${version}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
