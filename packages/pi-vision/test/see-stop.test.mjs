// vision.see when the code-mode script that called it ends first: its deadline, or its caller's abort, while the eyes are
// asked or while a path is read. pi-codemode aborts the signal of every call still running when the script's result
// settles (and from 1.3.0 settles without waiting for the worker to exit). The eyes request stops with it; nothing is
// filed, kept or told after the result settles; no rejection goes unhandled; the same call asked again pays once. Fake
// eyes, files built by the test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fakeEyes, pngBytes } from "@parcha/pi-vision/testing";
import { tmp } from "./durable/rig.mjs";

const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(error));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ASK = `return await vision.see({ ask: "What does it say?", paths: ["p1.png"] });`;

/** One call's vision: eyes that give `answers` in order (the last repeats), a memo port, and a host whose every filing,
 *  look and miss is logged with when it happened. */
function rig(answers, { env } = {}) {
  const cwd = tmp("vision-see-stop-");
  fs.writeFileSync(path.join(cwd, "p1.png"), pngBytes(40, 30));
  const log = [];
  const at = () => performance.now();
  const memos = new Map();
  const memo = async (key, compute) => {
    if (memos.has(key)) return memos.get(key);
    const value = await compute();
    if (!memos.has(key)) { memos.set(key, value); log.push({ kind: "memo", key: key.split(":")[1], at: at() }); }
    return memos.get(key);
  };
  const call = { conversationId: "c1", callId: "1", model: undefined, signal: undefined, memo };
  const fake = fakeEyes({ answers });
  const eyes = {
    ...fake,
    see: async (request, signal) => {
      log.push({ kind: "asked", at: at() });
      try { return await fake.see(request, signal); } catch (error) { log.push({ kind: "eyes stopped", aborted: signal.aborted, at: at() }); throw error; }
    },
  };
  const vision = createVisionExtension({
    eyes,
    evidence: { file: async (_label, record) => { log.push({ kind: "filed", status: record.status, at: at() }); return { path: "evidence/see.md" }; } },
    onLook: (look) => log.push({ kind: "told", kept: look.kept ?? false, at: at() }),
    onMiss: (miss) => log.push({ kind: "miss", code: miss.code, at: at() }),
    scope: () => ({ label: "see", deriveDir: ".vision" }),
  });
  /** Runs `code` once in a new sandbox with this call's global. */
  const run = async (code, options = {}) => {
    const sandbox = new CodemodeSandbox({ globals: [vision.see(env?.(cwd) ?? nodeVisionEnv({ cwd }), call)] });
    try { return { result: await sandbox.execute(code, options) }; } finally { await sandbox.close(); }
  };
  return { run, log, fake, memos };
}
const kinds = (log) => log.map((event) => event.kind);

test("a deadline while the eyes are asked stops the request; nothing is kept, filed or told after the result settles", async () => {
  const r = rig([{ hang: true }]);
  const { result } = await r.run(ASK, { timeoutMs: 1500 });
  assert.deepEqual([result.ok, result.error.kind], [false, "timeout"]);
  await wait(500);
  assert.deepEqual(r.log.map(({ at: _at, ...event }) => event), [{ kind: "asked" }, { kind: "eyes stopped", aborted: true }], "asked, then stopped by the deadline; no memo, receipt, look or miss, then or later");
  assert.equal(r.memos.size, 0);
  assert.deepEqual(unhandled, []);
});

test("an abort while the eyes are asked stops the request the same way", async () => {
  const r = rig([{ hang: true }]);
  const controller = new AbortController();
  const ran = r.run(ASK, { signal: controller.signal });
  for (let waited = 0; !r.log.length; waited += 10) { assert.ok(waited < 10_000, "the eyes were never asked"); await wait(10); }
  controller.abort(new Error("the caller stopped"));
  const { result } = await ran;
  assert.deepEqual([result.ok, result.error.kind], [false, "aborted"]);
  await wait(500);
  assert.deepEqual(r.log.map(({ at: _at, ...event }) => event), [{ kind: "asked" }, { kind: "eyes stopped", aborted: true }]);
  assert.equal(r.memos.size, 0);
  assert.deepEqual(unhandled, []);
});

test("an abort while a path is read files no miss: the read that the abort failed is not the file's", async () => {
  let gate;
  const opened = new Promise((resolve) => { gate = resolve; });
  // An environment that refuses an operation once its call is cancelled, as pi's do; its fileInfo waits for that.
  const env = (cwd) => {
    const node = nodeVisionEnv({ cwd });
    return { ...node, id: node.id, cwd, fileInfo: (file, context) => new Promise((resolve) => {
      gate();
      context.abortSignal?.addEventListener("abort", () => resolve({ ok: false, error: Object.assign(new Error("the operation was cancelled"), { code: "aborted" }) }), { once: true });
    }) };
  };
  const r = rig(["seen"], { env });
  const controller = new AbortController();
  const ran = r.run(ASK, { signal: controller.signal });
  await opened;
  controller.abort(new Error("the caller stopped"));
  const { result } = await ran;
  assert.deepEqual([result.ok, result.error.kind], [false, "aborted"]);
  await wait(300);
  assert.deepEqual(r.log, [], "no receipt filed and no miss told, then or later");
  assert.deepEqual(unhandled, []);
});

test("the same call asked again pays once: an answer that came before the deadline is read back, one that never came is asked", async () => {
  // The answer comes, then the script runs on past its deadline: the look was paid, kept, filed and told once.
  const r = rig([{ text: "seen", delayMs: 50 }]);
  const first = await r.run(`${ASK.replace("return await", "await")} while (true) {}`, { timeoutMs: 1500 });
  assert.equal(first.result.error.kind, "timeout");
  assert.deepEqual(kinds(r.log), ["asked", "memo", "filed", "told", "memo"], "the answer kept, filed and told before the deadline");
  const again = await r.run(ASK, { timeoutMs: 10_000 });
  assert.deepEqual([again.result.ok, again.result.value.kept, r.fake.ledger.length], [true, true, 1], "read back: no second request");
  assert.deepEqual(kinds(r.log).slice(5), ["filed", "told"], "told again as kept, not charged");
  assert.equal(r.log.at(-1).kept, true);

  // A request the deadline stopped left nothing kept, so the call asked again asks once more, and then never again.
  const twice = rig([{ hang: true }, "seen"]);
  assert.equal((await twice.run(ASK, { timeoutMs: 1500 })).result.error.kind, "timeout");
  const asked = await twice.run(ASK, { timeoutMs: 10_000 });
  const read = await twice.run(ASK, { timeoutMs: 10_000 });
  assert.deepEqual([asked.result.value.kept, read.result.value.kept, twice.fake.ledger.length], [undefined, true, 2], "the stopped request, the one that answered; the third run read back");
  assert.deepEqual(kinds(twice.log).filter((kind) => kind === "told").length, 2, "told when paid, and again as kept");
  assert.deepEqual(unhandled, []);
});
