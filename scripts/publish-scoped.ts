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
  existsSync,
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
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const patchPath = join(scratch, "cordis.patch.yml");
  if (existsSync(patchPath)) {
    const patchContent = readFileSync(patchPath, "utf8");
    writeFileSync(
      patchPath,
      patchContent.replaceAll('name: "dsh-tinyfish"', `name: "${SCOPED}"`)
    );
  }

  // Provenance needs OIDC, which exists only in CI. Locally there is no
  // identity provider, so npm errors with "Automatic provenance generation
  // not supported" — which is accurate and useless. Detect the environment
  // rather than adding a flag, because a flag would be forgotten exactly when
  // it matters and the failure would return.
  const inCI =
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  // Authentication, exactly one route per registry:
  //
  // - npmjs: OIDC via the workflow's id-token. No secret exists to pass, so
  //   there is nothing to configure here — the trust lives on npmjs.com.
  // - GitHub Packages mirror: the workflow token (`NODE_AUTH_TOKEN`), because
  //   GHP has no trusted-publisher concept and this is the only route.
  // - Locally: nothing. Both names exist and CI publishes both, so there is
  //   no manual publish left to support. A run outside CI with no mirror token
  //   lets npm say what it needs rather than failing on a stale secret.
  //
  // An earlier version also accepted pasted tokens and OTP codes for the
  // manual first-publish of each name. Both names are out now, OIDC and the
  // workflow token cover every repeat, and keeping those paths would be
  // options nobody exercises — which is how a secret-handling branch survives
  // untested until the day it mishandles one.
  const mirrorToken =
    registry === "https://registry.npmjs.org"
      ? undefined
      : process.env.NODE_AUTH_TOKEN?.trim();
  const npmrc: string[] =
    mirrorToken !== undefined && mirrorToken !== ""
      ? [`--//${host}/:_authToken=${mirrorToken}`]
      : [];
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
