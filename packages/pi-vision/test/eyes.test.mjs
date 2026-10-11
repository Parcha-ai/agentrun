// The fake eyes other suites count on: answers in the order scripted (the last repeats), every request in the ledger
// before it is answered, in a file a parent can read when one is named, usage in pi-ai's shape, an unknown price as
// null, and a failure that carries the sentinel key only where an SDK error would, on the request.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_LIMITS } from "@parcha/pi-vision";
import { SENTINEL_EYES_KEY, fakeEyes, fixtureDir } from "@parcha/pi-vision/testing";

const signal = () => new AbortController().signal;
const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", width: 10, height: 20, fragment: "a.png" };

test("answers come in the order scripted, the last repeats, and each request is in the ledger in order", async () => {
  const eyes = fakeEyes({ answers: ["first", (request) => `second: ${request.ask}`, { text: "third", model: "other-model", billedBy: "reviewer", costUsd: 0 }] });
  const asks = ["one", "two", "three", "four"];
  const answers = [];
  for (const ask of asks) answers.push(await eyes.see({ parts: [image, { type: "text", text: "page text" }], ask }, signal()));
  assert.deepEqual(answers.map((a) => a.text), ["first", "second: two", "third", "third"]);
  assert.deepEqual(answers.map((a) => a.model), ["fake-eyes", "fake-eyes", "other-model", "other-model"]);
  assert.deepEqual([answers[2].costUsd, answers[2].billedBy], [0, "reviewer"]);
  assert.deepEqual(eyes.ledger.map((r) => [r.n, r.ask]), [[1, "one"], [2, "two"], [3, "three"], [4, "four"]]);
  assert.deepEqual(eyes.ledger[0].parts, [{ type: "image", mimeType: "image/png", fragment: "a.png", width: 10, height: 20, chars: 12 }, { type: "text", chars: 9 }]);
  assert.equal(eyes.limits, DEFAULT_LIMITS);
  assert.deepEqual(eyes.accepts, { image: true, video: false, pdf: false });
});

test("usage is pi-ai's shape, priced per million tokens; an unknown price is null, never 0", async () => {
  const priced = await fakeEyes({ answers: [{ text: "ok", input: 2000, output: 500 }], price: { input: 1, output: 4 } }).see({ parts: [], ask: "q" }, signal());
  assert.deepEqual(priced.usage, { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 2500, cost: { input: 0.002, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.004 } });
  assert.equal(priced.costUsd, 0.004);
  const unknown = await fakeEyes({ price: null }).see({ parts: [image], ask: "q" }, signal());
  assert.equal(unknown.costUsd, null);
  assert.equal(unknown.usage.cost.total, 0);
  assert.ok(unknown.usage.input >= 1000, "a media part counts a flat 1,000 tokens");
});

test("a failure carries the key on its request, as an SDK error carries headers, and never in its message", async () => {
  const eyes = fakeEyes({ answers: [{ fail: "upstream 500" }] });
  const error = await eyes.see({ parts: [], ask: "q" }, signal()).then(() => null, (e) => e);
  assert.equal(error.message, "upstream 500");
  assert.ok(!error.message.includes(SENTINEL_EYES_KEY) && !String(error.stack).includes(SENTINEL_EYES_KEY));
  assert.ok(JSON.stringify(error.request).includes(SENTINEL_EYES_KEY));
  assert.equal(eyes.apiKey, SENTINEL_EYES_KEY);
  assert.equal(eyes.ledger.length, 1, "a failed request was still made");
});

test("a request that hangs, or is slow, ends when its signal aborts", async () => {
  const eyes = fakeEyes({ answers: [{ hang: true }, { text: "late", delayMs: 60_000 }] });
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    const pending = eyes.see({ parts: [], ask: "q" }, controller.signal);
    setTimeout(() => controller.abort(new Error("cut at the timeout")), 20);
    await assert.rejects(pending, /cut at the timeout/);
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(eyes.see({ parts: [], ask: "q" }, aborted.signal));
  assert.equal(eyes.ledger.length, 3);
});

test("with a ledger file, each request is one JSON line written before the answer", async () => {
  const dir = await fixtureDir();
  try {
    const ledgerPath = `${dir.path}/eyes.jsonl`;
    let seenBeforeAnswer = null;
    const eyes = fakeEyes({ ledgerPath, answers: [() => { seenBeforeAnswer ??= readFileSync(ledgerPath, "utf8"); return "ok"; }] });
    await eyes.see({ parts: [image], ask: "first" }, signal());
    await eyes.see({ parts: [], ask: "second", context: "ctx" }, signal());
    assert.deepEqual(JSON.parse(seenBeforeAnswer.trim()), eyes.ledger[0]);
    assert.deepEqual(readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)), eyes.ledger);
    assert.equal(eyes.ledger[1].context, "ctx");
  } finally { await dir.remove(); }
});
