// The package's test entry. Every `*.test.mjs` under test/, at any depth, runs in its own process. The suites that drive a real
// local Chrome (those that import test/fixtures/local-chrome.mjs) are split out: `npm test` runs the rest, `npm run test:chrome`
// runs only those, against the Chrome named by CHROME_PATH, and fails a test that cannot get one instead of skipping it.
//   node scripts/run-tests.mjs [--chrome] [--list]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const chromeMode = process.argv.includes("--chrome");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
  const at = join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(at);
  return entry.isFile() && entry.name.endsWith(".test.mjs") ? [at] : [];
});
const needsChrome = (file) => /fixtures\/local-chrome\.mjs/.test(readFileSync(file, "utf8"));
const files = walk(join(ROOT, "test")).filter((file) => needsChrome(file) === chromeMode).map((file) => relative(ROOT, file));
if (!files.length) { console.error(`no ${chromeMode ? "real-Chrome " : ""}test files found`); process.exit(1); }
if (process.argv.includes("--list")) { console.log(files.join("\n")); process.exit(0); }
if (chromeMode && !process.env.CHROME_PATH) { console.error("test:chrome needs CHROME_PATH, the Chrome for Testing binary to drive"); process.exit(1); }
const env = chromeMode ? { ...process.env, AGENTRUN_REQUIRE_LOCAL_CHROME: "1" } : process.env;
// The package's own test/preload.mjs, when it has one, is imported into each test file's process, as the harness's runner does: it gives a file
// a short private TMPDIR (Chrome aborts a singleton socket path past 107 bytes) and fails a file that leaves a process or a directory behind.
const preload = existsSync(join(ROOT, "test", "preload.mjs")) ? ["--import", join(ROOT, "test", "preload.mjs")] : [];
const run = spawnSync(process.execPath, [...preload, "--test", ...files], { cwd: ROOT, stdio: "inherit", env });
process.exit(run.status ?? 1);
