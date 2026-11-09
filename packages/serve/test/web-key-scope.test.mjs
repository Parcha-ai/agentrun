// The web tools in the runner: one process serves many claims, each handed its own keys in its own environment
// (claim-secrets.ts). Each call reads the Parallel key from the environment it is given, never from a process-wide cache,
// so one claim's key never serves another's; and the pages a run fetched serve that run alone. A claim's environment here
// is what the runner hands the claim's tools: its key and its tool plane, under --faux with a fake Parallel that files
// which key each request carried (fixtures/faux-parallel-keys.mjs). Keys are made at run time, never real.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { searchFor } = await import("../dist/web-search.js");
const { webFetchTool } = await import("../dist/web-fetch.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { bookedIn } = await import("../dist/paid-calls.js");

const KEYED_PARALLEL = new URL("./fixtures/faux-parallel-keys.mjs", import.meta.url).pathname;
/** The faux web the public-host guard resolves hosts through under --faux (as web-fetch.test.mjs uses it). */
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;
const KEYS_ENV = "AGENTRUN_TEST_FAUX_PARALLEL_KEYS";
const newKey = () => `par-test-${randomBytes(8).toString("hex")}`;
/** A claim's tool environment as the runner hands it: its own Parallel key and a plane resolving the web tools to Parallel. */
const claimEnv = (key) => ({ AGENTRUN_SERVE_FAUX: "1", AGENTRUN_SERVE_FAUX_PARALLEL: KEYED_PARALLEL, PARALLEL_API_KEY: key, [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "parallel", web_fetch: "parallel" }) });

/** A call to book each request to Parallel under (paid-calls.ts), as a run's call gives one: a request with none is never sent. */
const inCall = (fn) => (t) => bookedIn({ call: "test-call", record: async () => undefined }, () => fn(t));

/** The requests the fake Parallel was sent in this test, each with the key it carried. */
function keyLog(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "web-keys-"));
  const file = join(dir, "keys.ndjson");
  writeFileSync(file, "");
  const before = process.env[KEYS_ENV];
  process.env[KEYS_ENV] = file;
  t.after(() => {
    if (before === undefined) delete process.env[KEYS_ENV]; else process.env[KEYS_ENV] = before;
    rmSync(dir, { recursive: true, force: true });
  });
  return () => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a claim whose environment holds the Parallel key searches through Parallel on that key (no pipe in the runner)", inCall(async (t) => {
  const sent = keyLog(t);
  const key = newKey();
  const found = await searchFor(claimEnv(key), { query: "widgets", n: 3 });
  assert.equal(found.error, undefined, `the search ran: ${JSON.stringify(found)}`);
  assert.equal(found.provider, "parallel");
  assert.deepEqual(sent().map((r) => [r.path, r.key]), [["/v1/search", key]], "one search, on the claim's own key");
}));

test("two claims in one process each call Parallel on their own key, in either order", inCall(async (t) => {
  const sent = keyLog(t);
  const [a, b] = [newKey(), newKey()];
  const [envA, envB] = [claimEnv(a), claimEnv(b)];
  for (const env of [envA, envB, envA, envB]) {
    const found = await searchFor(env, { query: "widgets", n: 3 });
    assert.equal(found.error, undefined, `the search ran: ${JSON.stringify(found)}`);
  }
  assert.deepEqual(sent().map((r) => r.key), [a, b, a, b], "each request carried its own claim's key");
  assert.ok(!sent().some((r) => r.key !== a && r.key !== b), "no other key was sent");
}));

test("the pages a run fetched serve that run alone: another claim's fetch of the same page is its own request, on its own key", inCall(async (t) => {
  const sent = keyLog(t);
  const [a, b] = [newKey(), newKey()];
  const withWeb = (key) => ({ ...claimEnv(key), AGENTRUN_SERVE_FAUX_WEB: FAUX_WEB });
  const [toolA, toolB] = [webFetchTool(withWeb(a)), webFetchTool(withWeb(b))];
  const url = "http://public.example/notes.txt";
  const read = async (tool) => (await tool.execute({ url }, {}, {})).details;
  const first = await read(toolA);
  assert.equal(first.ok, true, `run A read the page: ${JSON.stringify(first)}`);
  const second = await read(toolB);
  assert.equal(second.ok, true, `run B read the page: ${JSON.stringify(second)}`);
  const again = await read(toolA);
  assert.equal(again.ok, true, "run A reads it again from its own pages");
  const extracts = sent().filter((r) => r.path === "/v1/extract");
  assert.deepEqual(extracts.map((r) => r.key), [a, b], "one extract per run, each on that run's key; A's second read came from A's own pages");
}));
