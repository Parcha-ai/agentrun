// The attach binding's conformance cases (src/attach-conformance.ts) against the test driver (fixtures/attach-driver.mjs),
// on a fiftieth of the protocol's clock: the driver passes every case. And they fail when they should: a driver that keeps
// a socket a binary frame came on fails that case, and one that dials again after it was removed fails revoke, each by
// name, the other cases passing. The same cases run against a real driver on a person's computer from the CLI form,
// `node dist/attach-conformance-cli.js`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachDriver, pairDriver } from "./fixtures/attach-driver.mjs";

const { ATTACH_CASES, runAttachConformance } = await import("../dist/attach-conformance.js");

const SCALE = 0.02;

/** The cases run against the test driver given `options`, which pairs with the code the run prints. */
async function against(t, options = {}) {
  let driver;
  t.after(() => driver?.stop());
  const lines = [];
  const results = await runAttachConformance({
    scale: SCALE,
    pairMs: 10_000,
    say: (line) => lines.push(line),
    pair: async (address, code) => {
      const paired = await pairDriver({ address, code, name: "conformance" });
      assert.equal(paired.status, 201, JSON.stringify(paired.body));
      driver = attachDriver({ address, token: paired.body.token, scale: SCALE, ...options });
      driver.start();
    },
  });
  return { results, lines, driver };
}

test("the test driver passes every case of the attach binding, in order", { timeout: 120_000 }, async (t) => {
  const { results, lines } = await against(t);
  assert.deepEqual(results.map((result) => result.name), [...ATTACH_CASES]);
  assert.deepEqual(results.filter((result) => !result.ok), [], lines.join("\n"));
  assert.match(lines[0], /^Server address http:\/\/127\.0\.0\.1:\d+, code [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}: /);
  assert.ok(lines.slice(1).every((line) => line.startsWith("PASS ")), lines.join("\n"));
});

test("a driver that keeps a socket a binary frame came on fails binary-frame by name, and passes the rest", { timeout: 120_000 }, async (t) => {
  const { results, lines } = await against(t, { takesBinary: true });
  assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.name), ["binary-frame"], lines.join("\n"));
  assert.match(results.find((result) => result.name === "binary-frame").detail, /did not close its socket on a binary frame/);
});

test("a driver that dials again after it was removed fails revoke by name, and passes the rest", { timeout: 120_000 }, async (t) => {
  const { results, lines, driver } = await against(t, { redialsAfter: () => true });
  assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.name), ["revoke"], lines.join("\n"));
  assert.match(results.find((result) => result.name === "revoke").detail, /dialed again after 4401/);
  driver.stop();
});
