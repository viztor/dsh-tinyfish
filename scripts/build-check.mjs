/**
 * Build-freshness check.
 *
 * `lib/` is the artifact DSH loads and npm publishes, and it is gitignored so
 * that nobody can commit a stale copy. The cost of that choice is that `lib/`
 * can fall behind `src/` — so this rebuilds into a scratch directory and diffs
 * it against what is on disk.
 *
 * Without this, "edit src, forget to rebuild" is invisible: the tests pass
 * because they import `src/` directly, and the failure only shows up in the
 * harness. That is exactly the staleness class a no-build package avoids by
 * having no build at all, so the property has to be enforced instead.
 *
 *   node scripts/build-check.mjs
 */

import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");

/**
 * The scratch output directory has to sit inside the project at exactly the
 * same depth as `lib/` — one level below the root — rather than in the system
 * temp dir. TypeScript writes the `sources` entry of
 * a source map relative to the output directory, so building to `/tmp/x` emits
 * `../../Users/.../src/index.ts` and every map would differ from `lib/` for a
 * reason that has nothing to do with staleness.
 */
const SCRATCH = join(ROOT, `.build-check-${process.pid}`);

/** Relative paths of every emitted file under a directory. */
function tree(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full.slice(dir.length + 1));
    }
  };
  walk(dir);
  return out.toSorted((a, b) => a.localeCompare(b));
}

const scratch = SCRATCH;
let failed = false;

try {
  execFileSync("pnpm", ["exec", "tsc", "--outDir", scratch], {
    cwd: ROOT,
    stdio: "pipe",
  });

  const built = tree(scratch);
  const current = tree(LIB);

  if (current.length === 0) {
    console.error("  FAIL lib/ is empty — run `pnpm run build`");
    failed = true;
  } else {
    const missing = built.filter((file) => !current.includes(file));
    const extra = current.filter((file) => !built.includes(file));

    for (const file of missing) {
      console.error(`  FAIL lib/${file} is missing — run \`pnpm run build\``);
      failed = true;
    }
    for (const file of extra) {
      console.error(`  FAIL lib/${file} is not produced by src/ — delete it`);
      failed = true;
    }

    if (!failed) {
      // Presence is not freshness: the file lists can match while the contents
      // have drifted, which is the case that actually bites.
      for (const file of built) {
        const a = await readFile(join(scratch, file), "utf8");
        const b = await readFile(join(LIB, file), "utf8");
        if (a !== b) {
          console.error(
            `  FAIL lib/${file} is stale — run \`pnpm run build\` to refresh it`
          );
          failed = true;
        }
      }
    }
  }

  if (!failed) {
    console.log(
      `  ok   lib/ matches a fresh build of src/ (${current.length} files)`
    );
  }
} finally {
  // No process.exit() above: it terminates without unwinding, so the scratch
  // directory would be left behind on every failing run.
  rmSync(scratch, { recursive: true, force: true });
}

if (failed) {
  console.error("\nbuild:check failed — lib/ does not match src/");
  process.exit(1);
}
