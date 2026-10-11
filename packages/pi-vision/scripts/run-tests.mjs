// The package's test entry. Every `*.test.mjs` under test/, at any depth, runs in its own process. Suites that need a
// program in the environment (ffmpeg, poppler) live under test/binaries/: `npm test` runs the rest, `npm run
// test:binaries` runs only those, with PI_VISION_REQUIRE_BINARIES=1 so a provider that cannot find its program fails
// instead of skipping.
//   node scripts/run-tests.mjs [--binaries] [--list]
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const binaries = process.argv.includes("--binaries");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
  const at = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(at);
  return entry.isFile() && entry.name.endsWith(".test.mjs") ? [at] : [];
});
const needsBinaries = (file) => relative(join(ROOT, "test"), file).split(sep)[0] === "binaries";
const files = walk(join(ROOT, "test")).filter((file) => needsBinaries(file) === binaries).map((file) => relative(ROOT, file));
if (process.argv.includes("--list")) { console.log(files.join("\n")); process.exit(0); }
if (!files.length) {
  // No suite needs a program yet: the binaries job passes, and says so.
  if (binaries) { console.log("no test files under test/binaries yet"); process.exit(0); }
  console.error("no test files found");
  process.exit(1);
}
const env = binaries ? { ...process.env, PI_VISION_REQUIRE_BINARIES: "1" } : process.env;
const run = spawnSync(process.execPath, ["--test", ...files], { cwd: ROOT, stdio: "inherit", env });
process.exit(run.status ?? 1);
