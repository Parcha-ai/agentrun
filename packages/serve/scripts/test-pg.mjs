// `npm run test:pg`: the store's tests on Postgres. Every test file that opens the store through the tests' helpers
// (store-helpers, store-support, runner-support, store-target) runs with AGENTRUN_TEST_PG_URL set: the given one, or the
// local database `npm run test:pg:up` starts (test/pg/compose.yaml). `--shard=<k>/<n>` runs the k-th of n shares of those
// files (scripts/test-pg-files.mjs), as CI's Postgres job does, one share a job; without it every file runs. Other
// arguments go to node --test. Each test has 10 minutes (--test-timeout), so one that hangs fails by its name instead of
// holding the job to its own limit. A file exits once its tests are done (--test-force-exit): a store a test left open
// (its connections, which its end names: store-target.mjs) fails that test, and never holds the file open on its owner
// lock's connection until the job's limit.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShard, pgTestFiles, shareOf } from "./test-pg-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const shardArgs = args.filter((arg) => arg.startsWith("--shard"));
let files = pgTestFiles(root);
if (shardArgs.length) {
  let shard;
  try {
    if (shardArgs.length > 1) throw new Error(`--shard is given once, not ${shardArgs.length} times`);
    shard = parseShard(shardArgs[0]);
  } catch (error) { console.error(`test-pg: ${error.message}`); process.exit(2); }
  const all = files.length;
  files = shareOf(files, shard);
  console.log(`test-pg: share ${shard.k} of ${shard.n}: ${files.length} of the ${all} test files that open the store`);
  // A share with no file ran nothing: it fails, so a suite cut into more shares than it has files is seen.
  if (!files.length) { console.error(`test-pg: share ${shard.k} of ${shard.n} has no test file`); process.exit(1); }
}
const env = { ...process.env, AGENTRUN_TEST_PG_URL: process.env.AGENTRUN_TEST_PG_URL || `postgres://agentrun:agentrun@127.0.0.1:${process.env.AGENTRUN_TEST_PG_PORT || "55433"}/agentrun` };
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=4", "--test-timeout=600000", "--test-force-exit", ...args.filter((arg) => !shardArgs.includes(arg)), ...files], { cwd: root, env, stdio: "inherit" });
process.exit(run.status ?? 1);
