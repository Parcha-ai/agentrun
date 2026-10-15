// The package's test entry. Every `*.test.mjs` under test/, at any depth, runs in its own process. The suites that drive a real
// local Chrome (those that import test/fixtures/local-chrome.mjs) are split out: `npm test` runs the rest, `npm run test:chrome`
// runs only those, against the Chrome named by CHROME_PATH, and fails a test that cannot get one instead of skipping it.
//   node scripts/run-tests.mjs [--chrome] [--list] [--concurrency N]
// The files run in parallel, as many as node's test runner picks for the machine; --concurrency N (or TEST_CONCURRENCY=N, the flag wins)
// passes --test-concurrency=N to it, for a shared or busy machine. Neither given: node's default, which is what CI runs.
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
const flagAt = process.argv.indexOf("--concurrency");
const wanted = flagAt >= 0 ? process.argv[flagAt + 1] : process.env.TEST_CONCURRENCY;
if (wanted !== undefined && wanted !== "" && !/^[1-9]\d*$/.test(wanted)) { console.error(`--concurrency / TEST_CONCURRENCY must be a positive integer, got "${wanted}"`); process.exit(2); }
const concurrency = wanted ? [`--test-concurrency=${wanted}`] : [];
const run = spawnSync(process.execPath, [...preload, "--test", ...concurrency, ...files], { cwd: ROOT, stdio: "inherit", env });
process.exit(run.status ?? 1);
