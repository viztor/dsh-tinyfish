/**
 * Install verification.
 *
 * Everything else in the gate runs against this working tree. That misses the
 * one thing a consumer actually does: `npm install dsh-tinyfish` and load it.
 * That path has its own failure modes the local gate cannot see — a peer range
 * npm cannot parse, a `files` list that omits the entry, a tarball missing its
 * prebuilt output — and every one of them ships fine and breaks on install.
 *
 * It already caught one: `workspace:^` satisfies DSH's loader and is a pnpm/yarn
 * protocol, so `npm install` answered EUNSUPPORTEDPROTOCOL. A package nobody
 * can install is worse than one that needs a range bump on a DSH minor release.
 *
 * This packs the tarball and installs it into a scratch project with plain npm,
 * then loads it and drives the plugin surface. No pnpm, no link:, no working
 * tree — only what a consumer would receive.
 *
 *   node scripts/install-check.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const pass = (message) => notes.push(message);

const scratch = mkdtempSync(join(tmpdir(), "dsh-tinyfish-install-"));

try {
  /* ---------------------------------------------------- pack the real thing */

  // `npm pack`, not a hand-built file list: this is the tarball npm will serve.
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
      cwd: ROOT,
      encoding: "utf8",
    })
  )[0];
  const tarball = join(scratch, packed.filename);
  pass(
    `packed ${packed.filename} (${packed.entryCount} entries, ${(packed.size / 1024).toFixed(1)} kB)`
  );

  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  /* ------------------------------- every peer must be a range npm can parse */

  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (typeof range !== "string" || range.trim() === "") {
      fail(`peer ${name} is not a usable range: ${JSON.stringify(range)}`);
      continue;
    }
    // A workspace protocol satisfies DSH's loader and means nothing to npm.
    if (/^(workspace|link|file|catalog):/.test(range)) {
      fail(
        `peer ${name} uses the "${range.split(":")[0]}:" protocol, which npm ` +
          "cannot parse — `npm install` of this package would fail outright"
      );
    }
  }
  if (!failures.length) {
    pass(
      `all ${Object.keys(manifest.peerDependencies ?? {}).length} peer ranges are ` +
        "plain semver npm can resolve"
    );
  }

  /* ---------------------------------------------- install as a real consumer */

  const project = join(scratch, "consumer");
  execFileSync("mkdir", ["-p", project]);
  // The peers are installed explicitly, at the manifest's own ranges,
  // because a DSH host provides them and this check is about whether the
  // package works in a host-like environment. Skipping them would test a
  // scenario that cannot occur: a bundle that is never loaded by DSH.
  //
  // `--legacy-peer-deps` is deliberate rather than lazy — it stops npm trying
  // to resolve the whole @deepseek-ai dependency graph on its own, which would
  // make the check slow and would fail for reasons unrelated to this package.
  const peers = Object.entries(manifest.peerDependencies ?? {}).map(
    ([name, range]) => `${name}@${range}`
  );
  execFileSync(
    "npm",
    [
      "install",
      tarball,
      ...peers,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
    { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  pass(
    `npm installed the package alongside ${peers.length} host-supplied peers`
  );

  const installed = join(project, "node_modules/dsh-tinyfish");
  if (!existsSync(installed)) {
    fail("npm reported success but nothing landed in node_modules");
  } else {
    /* ------------------------------------------------ the tarball is complete */

    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "cordis.patch.yml",
      manifest.main,
      manifest.types,
    ]) {
      if (!existsSync(join(installed, required))) {
        fail(`the installed tarball is missing ${required} — check files[]`);
      }
    }
    if (!failures.length) {
      pass(`tarball carries the entry, the types, the patch, and the docs`);
    }

    // A consumer profile resolves the bundle by this field; if it is absent the
    // package installs and is then silently ignored at boot.
    const installedManifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8")
    );
    if (installedManifest.dsh?.bundle?.patch === undefined) {
      fail(
        "the published manifest has lost dsh.bundle.patch — DSH will ignore it"
      );
    } else {
      pass(
        `dsh.bundle.patch survives publication: ${installedManifest.dsh.bundle.patch}`
      );
    }

    /* --------------------------------------------------- it loads and registers */

    // Exercised from the installed copy, not this tree: the point is the
    // artifact a consumer holds.
    const probe = `
      const m = await import(${JSON.stringify(join(installed, manifest.main))});
      const ctx = {
        web: {
          registerSearchProvider: (p) => (globalThis.__s = p),
          registerFetchProvider: (p) => (globalThis.__f = p),
        },
        get: () => undefined,
      };
      if (typeof m.apply !== "function") throw new Error("no apply() export");
      if (typeof m.Config !== "function") throw new Error("no Config export");
      if (m.name !== ${JSON.stringify(manifest.name)}) {
        throw new Error('name export is "' + m.name + '", manifest says "' + ${JSON.stringify(manifest.name)} + '"');
      }
      m.apply(ctx, m.Config({}));
      if (globalThis.__s?.id !== "tinyfish" || globalThis.__f?.id !== "tinyfish") {
        throw new Error("providers did not register under the expected id");
      }
      for (const symbol of ["WebError", "toIsoDate", "resolveApiKey"]) {
        if (typeof m[symbol] === "undefined") throw new Error(symbol + " is not exported");
      }
      process.stdout.write("ok");
    `;

    // The probe's own stderr is the only diagnostic that matters here, and it
    // is the part a one-line summary throws away. A truncated "ERR_MODULE_NOT_
    // FOUND" names neither the module nor the importer.
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: project,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = [error.stderr, error.message]
        .filter(Boolean)
        .join("\n")
        .split("\n")
        .filter((line) => /Error|Cannot find|not provide/.test(line))
        .slice(0, 3)
        .join(" | ");
      throw new Error(`the installed package did not load: ${detail}`, {
        cause: error,
      });
    }
    pass(
      "the installed package loads, validates a config row, and registers both providers"
    );
  }
} catch (error) {
  fail(`install check failed: ${String(error).split("\n")[0]}`);
} finally {
  // No process.exit() above: it would skip this and leak the scratch.
  rmSync(scratch, { recursive: true, force: true });
}

for (const note of notes) console.log(`  ok   ${note}`);
for (const message of failures) console.error(`  FAIL ${message}`);

if (failures.length) {
  console.error(`\ninstall:check failed — ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("\ninstall:check passed");
