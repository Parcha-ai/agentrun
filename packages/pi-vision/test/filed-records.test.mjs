// What each look tool files and tells the host, pinned byte for byte: the receipt label, the record's JSON in its field order,
// and the events (`onLook`, `onMiss`) that carry it, for the guard, vision.see, vision.judge, vision.transcribe and read. Any
// change to how a tool builds its Filing or its record that moves a field, a value or the order of its keys fails here.
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { guardResult, judge, readMedia, resolveLimits, see, transcribe } from "@parcha/pi-vision";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { fakeEyes, fixtureDir, imageSize, pngBytes } from "@parcha/pi-vision/testing";
import { fakeJev } from "./support/jev.mjs";
import { PINS } from "./filed-records.pins.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const png = (w, h) => ({ type: "image", data: b64(pngBytes(w, h)), mimeType: "image/png" });
const SEES = { id: "lead-model", input: ["text", "image"] };
const TEXT_ONLY = { id: "lead-model", input: ["text"] };
const mp3 = () => Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(2048, 0x55)]);
const NOW = 1_800_000_000_000;

function host(over = {}) {
  const labels = [], filed = [], looks = [], misses = [];
  return {
    labels, filed, looks, misses,
    setup: {
      limits: resolveLimits(TEXT_ONLY), eyes: undefined, providers: [], sources: {}, scope: { label: "scope-label", deriveDir: "evidence/n/media" },
      evidence: { file: async (label, record) => { labels.push(label); filed.push(record); return { path: `evidence/${label}/${filed.length}.md` }; } },
      onLook: (look) => looks.push(look),
      onMiss: (miss) => misses.push(miss),
      ...over,
    },
    bytes: () => JSON.stringify({ labels, filed, looks, misses }),
  };
}
const callOf = (model, extra = {}) => ({ conversationId: "conv-1", callId: "call-1", model, signal: undefined, toolCallId: "tool-call-7", ...extra });
const shot = () => ({ content: [{ type: "text", text: "a screenshot" }, png(40, 30)], details: { path: "evidence/n/1-screenshot.png", media: { kind: "image", path: "shot.png", ask: "What is shown?", sha256: "ab".repeat(32), original: "40x30" } } });

async function atFixedTime(run) {
  const real = Date.now;
  Date.now = () => NOW;
  try { return await run(); } finally { Date.now = real; }
}
const pinned = (name, bytes) => {
  if (process.env.PIN_PRINT) console.log(`PIN ${name} ${JSON.stringify(bytes)}`);
  else assert.equal(bytes, PINS[name], `${name}: what the tool files and tells the host changed`);
};

test("the guard files the same record and tells the same events: a look the eyes made, a native look, a miss", async () => {
  const eyesHost = host();
  await atFixedTime(() => guardResult(shot(), callOf(TEXT_ONLY), { ...eyesHost.setup, eyes: fakeEyes({ answers: [{ text: "A form.", input: 800, output: 12 }] }) }, imageSize));
  pinned("guard-eyes", eyesHost.bytes());
  const native = host({ limits: resolveLimits(SEES) });
  await atFixedTime(() => guardResult(shot(), callOf(SEES), native.setup, imageSize));
  pinned("guard-native", native.bytes());
  const missed = host();
  await atFixedTime(() => guardResult(shot(), callOf(TEXT_ONLY), missed.setup, imageSize));
  pinned("guard-miss", missed.bytes());
  const unnamed = host();
  const noPath = { content: shot().content, details: { media: { kind: "image" } } };
  await atFixedTime(() => guardResult(noPath, callOf(TEXT_ONLY, { tool: "bash" }), { ...unnamed.setup, eyes: fakeEyes({ answers: [{ text: "A page.", input: 10, output: 2 }] }) }, imageSize));
  pinned("guard-no-path", unnamed.bytes());
});

test("vision.see files the same record and tells the same events", async () => {
  const h = host();
  await atFixedTime(() => see({ ask: "What is it?", images: [png(40, 30)] }, undefined, callOf(undefined), { ...h.setup, eyes: fakeEyes({ answers: [{ text: "A page.", input: 700, output: 7 }] }) }));
  pinned("see", h.bytes());
});

test("vision.judge files the same record and tells the same events", async () => {
  const h = host({ images: sharpImages(sharp) });
  const jev = fakeJev();
  await atFixedTime(() => judge({ images: [png(300, 300)], questions: { q: { type: "noul", instructions: "Is `images[0].image` blank?" } } }, undefined, callOf(undefined), { ...h.setup, jev }));
  pinned("judge", h.bytes());
});

test("vision.transcribe files the same record and tells the same events", async (t) => {
  const dir = await fixtureDir("pi-vision-filed-records-");
  t.after(() => dir.remove());
  await dir.file("landing.mp3", mp3());
  const h = host();
  const transcriber = { provider: "stt", model: "stt-1", usdPerMinute: 0.006, transcribe: async () => ({ text: "hello there", words: [{ text: "hello", start: 0, end: 0.6 }, { text: "there", start: 0.7, end: 1.2 }], durationS: 30 }) };
  await atFixedTime(() => transcribe({ path: "landing.mp3" }, nodeVisionEnv({ cwd: dir.path }), callOf(undefined), { ...h.setup, transcriber }));
  pinned("transcribe", h.bytes());
});

test("read files the same record and tells the same events: a recording by handle, and a file it cannot read", async (t) => {
  const dir = await fixtureDir("pi-vision-filed-records-");
  t.after(() => dir.remove());
  await dir.file("notes.bin", Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  const env = nodeVisionEnv({ cwd: dir.path });
  const recording = host({ sources: { session: { via: "reviewer", look: async () => ({ text: "It loaded.", model: "reviewer-1", costUsd: 0.01 }) } } });
  await atFixedTime(() => readMedia(env, { path: "session:abc", ask: "What happened?" }, callOf(SEES), recording.setup));
  pinned("read-recording", recording.bytes());
  const unreadable = host({ limits: resolveLimits(SEES) });
  await atFixedTime(() => readMedia(env, { path: "notes.bin" }, callOf(SEES), unreadable.setup));
  pinned("read-unsupported", unreadable.bytes());
});
