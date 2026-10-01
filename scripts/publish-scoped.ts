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

// The registry being written to. The release workflow calls bare for npmjs
// and with `PUBLISH_REGISTRY=https://npm.pkg.github.com` for the mirror;
// provenance is npmjs-only, and the auth line below names this host.
const registry =
  process.env.PUBLISH_REGISTRY?.trim() || "https://registry.npmjs.org";
const host = new URL(registry).host;

// Skip, don't fail, when this version is already out on the registry being
// written to. npm refuses to republish a version, so without this a retried
// tag fails the whole release instead of resuming. The check reads from the
// target registry — consulting npmjs about a version that lives only on the
// mirror would republish it every time.
try {
  const published = execFileSync(
    "npm",
    ["view", `${SCOPED}@${version}`, "version", `--registry=${registry}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
  if (published === version) {
    console.log(`${SCOPED}@${version} is already on ${host}, skipping`);
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
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  // A web-login token requires a one-time password for publishing; an
  // automation token does not. Two ways through, in order of preference:
  //
  //   NPM_TOKEN=npm_xxx node scripts/publish-scoped.ts
  //     An automation (or granular, publish-scoped) token, pasted once. No
  //     code, no browser round-trip. Create one at npmjs.com → Access Tokens.
  //     It is used for this publish only and never written to disk — the temp
  //     npmrc below is deleted with the scratch dir.
  //
  //   NPM_OTP=123456 node scripts/publish-scoped.ts
  //     The code the authenticator shows right now, for a web-login token.
  //
  // Absent both, the command runs as-is and npm says what it needs, which is
  // a clearer failure than a stale cached secret.
  const token = process.env.NPM_TOKEN?.trim();
  const otp = process.env.NPM_OTP?.trim();
  // The mirror authenticates with the workflow token, not OIDC: GitHub
  // Packages has no trusted-publisher concept, so this is the only route.
  const mirrorToken =
    registry === "https://registry.npmjs.org"
      ? undefined
      : process.env.NODE_AUTH_TOKEN?.trim();
  // Exactly one auth route ever applies: an explicitly pasted token wins,
  // then the mirror's workflow token, then nothing and npm says what it needs.
  // Written as early returns rather than a nested ternary, which reads as a
  // decision instead of a puzzle.
  const npmrc = ((): string[] => {
    if (token !== undefined && token !== "") {
      const file = join(scratch, ".npmrc");
      writeFileSync(file, `//${host}/:_authToken=${token}\n`, { mode: 0o600 });
      return ["--userconfig", file];
    }
    if (mirrorToken !== undefined && mirrorToken !== "") {
      return [`--//${host}/:_authToken=${mirrorToken}`];
    }
    return [];
  })();
  // Provenance attests to npmjs via the workflow's OIDC identity. The mirror
  // gets none: GitHub Packages accepts no attestation, and asserting one for
  // the wrong registry would fail the publish it is meant to protect.
  const attest =
    inCI && registry === "https://registry.npmjs.org" ? ["--provenance"] : [];
  execFileSync(
    "npm",
    [
      "publish",
      scratch,
      `--registry=${registry}`,
      ...attest,
      ...(otp ? ["--otp", otp] : []),
      ...npmrc,
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
