// store-target.mjs ends each Postgres test (endTest): after every after-hook of the test's own, one that throws too, it
// runs what the test's helpers handed to atTestEnd, then fails the test when a connection to a schema made in it is still
// open, naming each one. Each case runs a child file (test/fixtures/pg-end-*.mjs, outside the suite's glob) with
// `node --test` on the same database and reads its TAP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { client, postgresOnly } from "./store-target.mjs";

/** A child's whole run may take this long (the leaking child's end waits 5 s for its connections to close). */
const CHILD_MS = 60_000;

/** Runs fixtures/<name>.mjs as a test file of its own, on this run's database: its exit code, its TAP. */
async function child(name) {
  const env = { ...process.env };
  // A nested `node --test` under a test runner (NODE_TEST_CONTEXT set) reports to its parent and runs nothing here.
  delete env.NODE_TEST_CONTEXT;
  const file = fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
  const proc = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-force-exit", file], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (chunk) => (out += chunk));
  proc.stderr.on("data", (chunk) => (out += chunk));
  let timer;
  const code = await Promise.race([
    new Promise((resolve) => proc.on("close", (status, signal) => resolve(status ?? signal))),
    new Promise((resolve) => (timer = setTimeout(() => resolve("timeout"), CHILD_MS))),
  ]);
  clearTimeout(timer);
  if (code === "timeout") {
    proc.kill("SIGKILL");
    assert.fail(`${name} ran past ${CHILD_MS} ms:\n${out}`);
  }
  return { code, out };
}

/** The TAP block of the child's test `name`: its result line through the end of its YAML. */
function block(out, name) {
  const at = out.search(new RegExp(`^(?:not )?ok \\d+ - ${name}$`, "m"));
  assert.notEqual(at, -1, `no result for "${name}" in:\n${out}`);
  return out.slice(at, out.indexOf("\n  ...", at) + 6);
}

/** The schemas a child printed ("schema: <name>"). */
const schemasOf = (out) => [...out.matchAll(/schema: (t_\w+)/g)].map((match) => match[1]);

/** Ends every connection still open to the child's schemas (its process has exited), then drops them. */
async function dropChildSchemas(schemas) {
  if (schemas.length === 0) return;
  const c = await client();
  try {
    await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND split_part(application_name, ':', 2) = ANY($1)", [schemas]);
    for (const schema of schemas) await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await c.end();
  }
}

test("a test's end runs after the test's own after-hooks, and after the rest of them when one throws", postgresOnly("store-target's test end"), async () => {
  const { code, out } = await child("pg-end-order");
  const steps = (name) => [...out.matchAll(new RegExp(`^# step ${name}: (.+)$`, "gm"))].map((match) => match[1]);
  assert.deepEqual(steps("pass"), ["own hook 1", "own hook 2", "end closer"], out);
  assert.deepEqual(steps("throw"), ["own hook 1", "own hook 2 throws", "own hook 3 closed its client", "end closer"], out);
  assert.match(block(out, "after-hooks that pass"), /^ok /);
  // The thrown error fails its test; the client the third hook closed is not left open.
  const thrown = block(out, "a second after-hook that throws");
  assert.match(thrown, /^not ok /);
  assert.match(thrown, /error: 'own hook 2 threw'/);
  assert.doesNotMatch(out, /left open/);
  assert.equal(code, 1);
});

test("a test that leaves a store open fails, naming the test and each of the store's connections", postgresOnly("store-target's test end"), async (t) => {
  const { code, out } = await child("pg-end-leak");
  const schemas = schemasOf(out);
  t.after(() => dropChildSchemas(schemas));
  assert.equal(schemas.length, 1, out);
  const [schema] = schemas;
  const failed = block(out, "a test that leaves its store open");
  assert.match(failed, /^not ok /);
  assert.match(failed, /Postgres connections left open after the test, 5 s after its after-hooks: /);
  assert.ok(failed.includes(`agentrun-store-owner:${schema} (`), `the owner lock's session named:\n${failed}`);
  assert.ok(failed.includes(`agentrun-store:${schema} (`), `the pool's connection named:\n${failed}`);
  assert.equal(code, 1);
});

test("a test that closes everything it opens passes", postgresOnly("store-target's test end"), async (t) => {
  const { code, out } = await child("pg-end-closed");
  t.after(() => dropChildSchemas(schemasOf(out)));
  assert.match(block(out, "a test that closes its store"), /^ok /);
  assert.equal(code, 0, out);
});
