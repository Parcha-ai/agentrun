// A look says when its model call began (`startedAt`, epoch milliseconds) and the tool call it ran under (`toolCallId`),
// in the record the host files and in the event it is told, so a timeline draws the call as a bar under that tool call. A
// look with neither files as it always did: a native look made no request, an answer read back from a memo began none now,
// and a caller that names no tool call leaves `toolCallId` out.
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { guardResult, judge, readMedia, receiptFacts, resolveLimits, see, transcribe } from "@parcha/pi-vision";
import { callContext, createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { SENTINEL_EYES_KEY, fakeEyes, fixtureDir, imageSize, pngBytes } from "@parcha/pi-vision/testing";
import { codeTool } from "./durable/code-tool.mjs";
import { ctx, open, tmp } from "./durable/rig.mjs";
import { fakeJev } from "./support/jev.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const png = (w, h) => ({ type: "image", data: b64(pngBytes(w, h)), mimeType: "image/png" });
const SEES = { id: "lead-model", input: ["text", "image"] };
const TEXT_ONLY = { id: "lead-model", input: ["text"] };
const mp3 = () => Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(2048, 0x55)]);

function host(over = {}) {
  const filed = [], looks = [], misses = [];
  return {
    filed, looks, misses,
    setup: {
      limits: resolveLimits(TEXT_ONLY), eyes: undefined, providers: [], sources: {}, scope: { label: "n", deriveDir: "evidence/n/media" },
      evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}.md` }; } },
      onLook: (look) => looks.push(look),
      onMiss: (miss) => misses.push(miss),
      ...over,
    },
  };
}
const callOf = (model, extra = {}) => ({ conversationId: "c1", callId: "t1", model, signal: undefined, ...extra });
const shot = () => ({ content: [{ type: "text", text: "a screenshot" }, png(40, 30)], details: { path: "evidence/n/1-screenshot.png", media: { kind: "image", path: "shot.png", ask: "What is shown?", sha256: "ab".repeat(32) } } });
/** Eyes whose answer is given at the moment the request arrives: the clock then, to hold `startedAt` between it and the call. */
function timedEyes(...answers) {
  const arrived = [];
  const eyes = fakeEyes({ answers: answers.map((answer) => () => { arrived.push(Date.now()); return answer; }) });
  return Object.assign(eyes, { arrived });
}
const within = (before, value, arrived, after) => Number.isInteger(value) && before <= value && value <= arrived && arrived <= after;

test("a look the eyes made says when its request began and which tool call it ran under, in the record and in the event", async () => {
  const h = host();
  const eyes = timedEyes({ text: "A form.", input: 800, output: 12 });
  const before = Date.now();
  const out = await guardResult(shot(), callOf(TEXT_ONLY, { toolCallId: "call-7" }), { ...h.setup, eyes }, imageSize);
  const after = Date.now();
  assert.match(out.content[1].text, /seen for you by fake-eyes/);
  const [record] = h.filed;
  assert.ok(within(before, record.facts.startedAt, eyes.arrived[0], after), `startedAt ${record.facts.startedAt} is when the request began (${before}..${eyes.arrived[0]}..${after})`);
  assert.equal(record.facts.toolCallId, "call-7");
  const [look] = h.looks;
  assert.deepEqual([look.startedAt, look.toolCallId], [record.facts.startedAt, "call-7"], "the event says what the record says");
  assert.equal(look.record, record, "and carries that record");
  assert.deepEqual([receiptFacts(record).startedAt, receiptFacts(record).toolCallId], [record.facts.startedAt, "call-7"], "the receipt's header lines");
});

test("a look with neither files exactly as it did: a native look, an answer read back, and a caller that names no tool call", async () => {
  const native = host({ limits: resolveLimits(SEES) });
  await guardResult(shot(), callOf(SEES), native.setup, imageSize);
  assert.equal(native.looks.length, 1);
  assert.equal(native.filed[0].args.native, true);
  for (const where of [native.filed[0].facts, native.looks[0]]) assert.ok(!("startedAt" in where) && !("toolCallId" in where), "a native look made no request and no tool call was named");
  assert.ok(!("startedAt" in receiptFacts(native.filed[0])) && !("toolCallId" in receiptFacts(native.filed[0])), "no timing line in its receipt");

  const kept = new Map();
  const memo = async (key, compute) => (kept.has(key) ? kept.get(key) : (kept.set(key, await compute()), kept.get(key)));
  const first = host();
  await guardResult(shot(), callOf(TEXT_ONLY, { toolCallId: "call-1", memo }), { ...first.setup, eyes: fakeEyes() }, imageSize);
  const again = host();
  const eyes = fakeEyes();
  await guardResult(shot(), callOf(TEXT_ONLY, { toolCallId: "call-2", memo }), { ...again.setup, eyes }, imageSize);
  assert.equal(eyes.ledger.length, 0, "the answer was read back: no request");
  assert.equal(first.filed[0].facts.toolCallId, "call-1");
  assert.ok(Number.isInteger(first.filed[0].facts.startedAt));
  assert.equal(again.filed[0].facts.kept, true);
  assert.ok(!("startedAt" in again.filed[0].facts) && !("startedAt" in again.looks[0]), "no request began in this call, so there is no start to draw");
  assert.deepEqual([again.filed[0].facts.toolCallId, again.looks[0].toolCallId], ["call-2", "call-2"], "the tool call it was read back under");

  const bare = host();
  await guardResult(shot(), callOf(TEXT_ONLY), { ...bare.setup, eyes: fakeEyes() }, imageSize);
  assert.ok(!("toolCallId" in bare.filed[0].facts) && !("toolCallId" in bare.looks[0]), "a caller that names no tool call leaves it out");
});

test("a failed look says when its request began when it made one: an answer with no words, a request that threw; not one that made none", async () => {
  const empty = host();
  const eyes = timedEyes({ text: "", input: 500, output: 0 });
  const before = Date.now();
  await guardResult(shot(), callOf(TEXT_ONLY, { toolCallId: "call-3" }), { ...empty.setup, eyes }, imageSize);
  const after = Date.now();
  const [{ record: emptied }] = empty.misses;
  assert.ok(within(before, emptied.facts.startedAt, eyes.arrived[0], after));
  assert.deepEqual([emptied.facts.toolCallId, emptied.status, emptied.facts.cost_usd > 0], ["call-3", "failed", true]);
  assert.equal(emptied, empty.filed[0]);

  const threw = host();
  await guardResult(shot(), callOf(TEXT_ONLY, { toolCallId: "call-4" }), { ...threw.setup, eyes: fakeEyes({ answers: [{ fail: "route down" }] }) }, imageSize);
  const [{ record: thrown }] = threw.misses;
  assert.deepEqual([Number.isInteger(thrown.facts.startedAt), thrown.facts.toolCallId, "cost_usd" in thrown.facts], [true, "call-4", false], "timed, and still no price a nobody earned");

  const none = host();
  await guardResult(shot(), callOf(TEXT_ONLY, { toolCallId: "call-5" }), none.setup, imageSize);
  const [{ record: unasked }] = none.misses;
  assert.deepEqual([unasked.facts.toolCallId, "startedAt" in unasked.facts, unasked.facts.cost_usd], ["call-5", false, 0], "no request began");
});

test("vision.see, vision.judge and vision.transcribe each time their own request and name the tool call", async (t) => {
  const dir = await fixtureDir("pi-vision-look-timing-");
  t.after(() => dir.remove());
  await dir.file("landing.mp3", mp3());
  const env = nodeVisionEnv({ cwd: dir.path });
  const call = callOf(undefined, { toolCallId: "code-9" });

  const s = host();
  const eyes = timedEyes({ text: "A page.", input: 700, output: 7 });
  let t0 = Date.now();
  await see({ ask: "What is it?", images: [png(40, 30)] }, undefined, call, { ...s.setup, eyes });
  assert.ok(within(t0, s.filed[0].facts.startedAt, eyes.arrived[0], Date.now()), "see");
  assert.deepEqual([s.looks[0].startedAt, s.looks[0].toolCallId, s.filed[0].facts.toolCallId], [s.filed[0].facts.startedAt, "code-9", "code-9"]);

  const j = host({ images: sharpImages(sharp) });
  const jev = fakeJev();
  let arrivedJev = 0;
  const judged = { judge: async (params) => { arrivedJev = Date.now(); return jev.judge(params); } };
  t0 = Date.now();
  await judge({ images: [png(300, 300)], questions: { q: { type: "noul", instructions: "Is `images[0].image` blank?" } } }, undefined, call, { ...j.setup, jev: judged });
  assert.ok(within(t0, j.filed[0].facts.startedAt, arrivedJev, Date.now()), "judge");
  assert.deepEqual([j.looks[0].startedAt, j.looks[0].toolCallId], [j.filed[0].facts.startedAt, "code-9"]);

  const x = host();
  let arrivedStt = 0;
  const transcriber = { provider: "stt", model: "stt-1", transcribe: async () => { arrivedStt = Date.now(); return { text: "hello", words: [{ text: "hello", start: 0, end: 1 }], durationS: 1 }; } };
  t0 = Date.now();
  await transcribe({ path: "landing.mp3" }, env, call, { ...x.setup, transcriber });
  assert.ok(within(t0, x.filed[0].facts.startedAt, arrivedStt, Date.now()), "transcribe");
  assert.deepEqual([x.looks[0].startedAt, x.looks[0].toolCallId, x.filed[0].tool], [x.filed[0].facts.startedAt, "code-9", "transcribe"]);

  const failing = host({ images: sharpImages(sharp) });
  await assert.rejects(judge({ images: [png(300, 300)], questions: { q: { type: "noul", instructions: "Is `images[0].image` blank?" } } }, undefined, call, { ...failing.setup, jev: { judge: fakeJev({ fail: Object.assign(new Error("400 Bad Request"), { status: 400 }) }).judge } }), /Jev failed/);
  assert.deepEqual([Number.isInteger(failing.misses[0].record.facts.startedAt), failing.misses[0].record.facts.toolCallId], [true, "code-9"], "a failed judgment is timed too");
  const notSent = host();
  await assert.rejects(transcribe({ path: "landing.mp3" }, env, call, { ...notSent.setup, transcriber: { provider: "stt", model: "stt-1", transcribe: async () => { const { ProviderMiss } = await import("@parcha/pi-vision"); throw new ProviderMiss("over_budget", "too long for one request"); } } }));
  assert.deepEqual(["startedAt" in notSent.misses[0].record.facts, notSent.misses[0].record.facts.toolCallId], [false, "code-9"], "a request refused before it was sent began no call");
});

test("a recording read by handle is timed and named too", async (t) => {
  const dir = await fixtureDir("pi-vision-look-timing-");
  t.after(() => dir.remove());
  let arrived = 0;
  const h = host({ sources: { session: { via: "reviewer", look: async () => { arrived = Date.now(); return { text: "It loaded.", model: "reviewer-1", costUsd: 0.01 }; } } } });
  const t0 = Date.now();
  await readMedia(nodeVisionEnv({ cwd: dir.path }), { path: "session:abc", ask: "What happened?" }, callOf(SEES, { toolCallId: "call-8" }), h.setup);
  assert.ok(within(t0, h.filed[0].facts.startedAt, arrived, Date.now()));
  assert.deepEqual([h.looks[0].startedAt, h.looks[0].toolCallId], [h.filed[0].facts.startedAt, "call-8"]);
});

test("through a real Harness: the look a script's vision.see made is filed under the id of the tool call that ran the script", async () => {
  const cwd = tmp("vision-look-timing-");
  const fs = await import("node:fs");
  fs.writeFileSync(`${cwd}/p1.png`, pngBytes(40, 30));
  const h = host();
  const eyes = timedEyes({ text: "A page.", input: 700, output: 7 });
  const vision = createVisionExtension({ eyes, evidence: h.setup.evidence, scope: () => ({ label: "n", deriveDir: "evidence/n" }), onLook: h.setup.onLook, onMiss: h.setup.onMiss });
  const { harness, root } = await open({ extensions: [codeTool(vision), vision.extension], rounds: [[["code", { code: 'return await vision.see({ ask: "What is it?", paths: ["p1.png"] });' }]]], cwd });
  try {
    const before = Date.now();
    const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    const result = [...(await root.entries({}, 200, undefined, ctx)).items].find((entry) => entry.kind === "pi.tool-result");
    const toolCallId = result.model[0].toolCallId;
    assert.ok(typeof toolCallId === "string" && toolCallId.length > 0);
    assert.equal(h.filed.length, 1);
    assert.equal(h.filed[0].facts.toolCallId, toolCallId, "the code tool's call, as pi names it");
    assert.ok(within(before, h.filed[0].facts.startedAt, eyes.arrived[0], Date.now()));
    assert.deepEqual([h.looks[0].toolCallId, h.looks[0].startedAt], [toolCallId, h.filed[0].facts.startedAt]);
    // The same through the context a host builds for a tool of its own.
    const api = { callId: "host-call-1", conversationId: "c1", agent: async () => ({ model: { provider: "faux", modelId: "lead-1" } }), memo: async () => undefined };
    assert.equal((await callContext(api, ctx)).toolCallId, "host-call-1");
  } finally { await harness.close(ctx); }
  assert.ok(!JSON.stringify(h).includes(SENTINEL_EYES_KEY));
});
