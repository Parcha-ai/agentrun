// The tests' model gateway is keyed to its test (support.mjs keyedGateway): a request carrying another key is another
// process's, refused, printed and never counted, so a test that asks "did anything reach the gateway" counts only its
// own run's requests; one carrying its own key always counts, so a run's own leak stays red.
import assert from "node:assert/strict";
import { test } from "node:test";
import { foreignLine, keyedGateway } from "./support.mjs";

const post = (gw, key, model) => fetch(`${gw.origin}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model }) });

test("a request with another key (the key every test once shared) is refused, printed with a key prefix only, and never counted", async (t) => {
  const gw = await keyedGateway(t);
  const shared = `not-a-secret-${"gateway"}`;
  assert.equal((await post(gw, shared, "gpt-test")).status, 401);
  assert.equal(gw.seen.length, 0, "never counted as the test's own");
  assert.equal(gw.foreign.length, 1);
  assert.match(gw.foreign[0], /\/v1\/responses, model gpt-test, key Bearer not-a-s\.\.\. \(27 characters\)/);
  assert.ok(!gw.foreign[0].includes(shared), "the whole key is never printed");
});

test("a request with the test's own key is counted, so a run whose own request gets through stays red", async (t) => {
  const gw = await keyedGateway(t);
  assert.equal((await post(gw, gw.key, "gpt-test")).status, 200);
  assert.deepEqual(gw.seen.map((s) => [s.path, s.body.model]), [["/v1/responses", "gpt-test"]]);
  assert.equal(gw.foreign.length, 0);
});

test("each gateway has a key of its own", async (t) => {
  const [a, b] = [await keyedGateway(t), await keyedGateway(t)];
  assert.notEqual(a.key, b.key);
});

test("the printed line never holds a whole key, however long", () => {
  const key = `Bearer ${"k".repeat(80)}`;
  const line = foreignLine("/v1/responses", "m", key);
  assert.ok(!line.includes(key));
  assert.match(line, /\(87 characters\)/);
});
