// `npm run test:pg`: the store's tests on Postgres. Every test file that opens the store through the tests' helpers
// (store-helpers, store-support, runner-support, store-target) runs with AGENTRUN_TEST_PG_URL set: the given one, or the
// local database `npm run test:pg:up` starts (test/pg/compose.yaml). Extra arguments go to node --test. Each test has 10
// minutes (--test-timeout), so one that hangs fails by its name instead of holding the job to its own limit. A file exits
// once its tests are done (--test-force-exit): a store a test left open (its connections, which its end names: store-
// target.mjs) fails that test, and never holds the file open on its owner lock's connection until the job's limit.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = /from "\.\/(?:store-helpers|store-support|runner-support|store-target)\.mjs"/;
const files = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .filter((name) => HELPERS.test(readFileSync(join(root, "test", name), "utf8")))
  .sort()
  .map((name) => join("test", name));
const env = { ...process.env, AGENTRUN_TEST_PG_URL: process.env.AGENTRUN_TEST_PG_URL || `postgres://agentrun:agentrun@127.0.0.1:${process.env.AGENTRUN_TEST_PG_PORT || "55433"}/agentrun` };
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=4", "--test-timeout=600000", "--test-force-exit", ...process.argv.slice(2), ...files], { cwd: root, env, stdio: "inherit" });
process.exit(run.status ?? 1);
