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

// `PUBLISH_DRY_RUN=1` inspects the scratch tree without touching the network,
// so it must not consult the registry either — otherwise a version that is
// already published short-circuits before the transform is ever shown.
const dryRun = process.env.PUBLISH_DRY_RUN === "1";

// Skip, don't fail, when this version is already out on the registry being
// written to. npm refuses to republish a version, so without this a retried
// tag fails the whole release instead of resuming. The check reads from the
// target registry — consulting npmjs about a version that lives only on the
// mirror would republish it every time.
try {
  if (dryRun) throw new Error("dry run");
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
  //
  // `files` may also hold glob patterns, such as `locale/*.json`. `cpSync`
  // copies a path, not a pattern, so a pattern is reduced to the directory it
  // selects from: the whole directory lands in the scratch tree and npm applies
  // the pattern again when it packs. Naming a pattern here used to abort the
  // release with ENOENT on a literal `locale/*.json`.
  const copyRoot = (entry: string): string => {
    if (!entry.includes("*")) return entry;
    const slash = entry.indexOf("/");
    return slash === -1 ? "." : entry.slice(0, slash);
  };
  for (const file of new Set([...pkg.files, "package.json"].map(copyRoot))) {
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
  if (!existsSync(patchPath)) {
    // The patch is in `files`, so this can only mean the manifest dropped it.
    // Publishing anyway would ship an alias whose plugin DSH installs and then
    // ignores — the silent half of a release that looks successful.
    throw new Error(
      "cordis.patch.yml is missing from the scratch tree; the scoped alias would publish without the bundle patch"
    );
  }
  const patchContent = readFileSync(patchPath, "utf8");
  const unscoped = 'name: "dsh-tinyfish"';
  const scopedPatch = patchContent.replaceAll(unscoped, `name: "${SCOPED}"`);
  // `replaceAll` returns its input unchanged when it matches nothing, and the
  // only sign of that would be a scoped package whose patch still names the
  // unscoped one: an alias installing a plugin that points somewhere else,
  // with no error on either end. The rewrite is asserted here because this is
  // the only place it happens and `PUBLISH_DRY_RUN=1` the only place it is
  // otherwise seen — and a dry run that prints the unrewritten value reads as
  // a success either way.
  if (scopedPatch === patchContent) {
    throw new Error(
      `cordis.patch.yml has no \`${unscoped}\` line to rewrite; the scoped alias would publish a patch still naming "dsh-tinyfish"`
    );
  }
  writeFileSync(patchPath, scopedPatch);

  // `PUBLISH_DRY_RUN=1` builds the scratch tree, prints what this alias would
  // publish, and stops before the first network call. The per-alias
  // transformation is otherwise only observable after a real release.
  if (dryRun) {
    console.log(`--- ${SCOPED}@${version} (dry run) ---`);
    console.log(readFileSync(join(scratch, "package.json"), "utf8"));
    console.log(
      `${
        existsSync(join(scratch, "lib", "client.js"))
          ? "ships"
          : "does not ship"
      } lib/client.js`
    );
    console.log(
      `${existsSync(join(scratch, "locale", "en.json")) ? "ships" : "does not ship"} locale/en.json`
    );
    // The rewrite is what makes the alias point at itself, and printing it here
    // is what lets `scripts/check.ts` assert it at gate time rather than
    // discovering it at a tag. Asserting on output the script already produces
    // beats a second copy of the transform living in the check.
    console.log(
      `patch row name: ${
        scopedPatch
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("name:")) ?? "none"
      }`
    );
    process.exit(0);
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
  // Capture the output instead of inheriting stdio: a failure has to be
  // *classified*, because npm reports the one benign case only in its text.
  //
  // The benign case is a re-pushed tag. The `npm view` guard above still says
  // "no such version" while the registry has the tarball staged but not yet
  // indexed, so the PUT returns 409 "Cannot publish over previously staged
  // version". That version is on its way; it must not fail the rerun.
  //
  // Everything else — a missing Trusted Publisher (404), an expired token, a
  // network failure — is a release that did NOT happen, and it is thrown so the
  // workflow stops reporting a publish that never landed. The release
  // workflow's final verification step then names every target that is
  // actually absent from the registry.
  try {
    const output = execFileSync(
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
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (output.trim() !== "") console.log(output.trim());
    console.log(`published ${SCOPED}@${version}`);
  } catch (error: unknown) {
    const failure = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}${
      failure.message ?? ""
    }`;
    if (
      /previously published|previously staged|EPUBLISHCONFLICT|E409/u.test(
        output
      )
    ) {
      console.log(
        `${SCOPED}@${version} was already staged on ${host}; continuing`
      );
    } else {
      console.error(output.trim());
      throw error;
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
