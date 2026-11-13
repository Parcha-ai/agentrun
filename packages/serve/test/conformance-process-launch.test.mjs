// The harness conformance suite's process cases start a runner process of their own (child.ts) on the suite's store. On
// Postgres that store is a URL, which may hold the database's password: it goes to the process on its stdin, never on its
// argv (or in its environment), which another process of the user reads (ps, /proc/<pid>/cmdline).
import assert from "node:assert/strict";
import { test } from "node:test";

const harness = await import("../dist/runner/conformance/harness.js");

test("a process case's runner process gets the store's URL on its stdin, never on its argv, which holds its config alone", () => {
  assert.equal(typeof harness.processLaunch, "function", "the harness says how it starts its runner process");
  const secret = "s".repeat(12);
  const url = `postgres://runner:${secret}@db.invalid:5432/agentrun`;
  const config = { dataDir: "/data", storeEnv: { AGENTRUN_STORE_SCHEMA: "agentrun_c1" }, module: "subject.js", export: "subject" };
  const launch = harness.processLaunch(config, url);
  const argv = launch.args.join("\u0000");
  assert.ok(!argv.includes(secret) && !argv.includes("db.invalid"), `no store URL on argv: ${argv}`);
  assert.deepEqual(JSON.parse(launch.args.at(-1)), config, "argv carries the config");
  assert.deepEqual(JSON.parse(launch.stdin), { storeUrl: url }, "stdin carries the URL");
});
