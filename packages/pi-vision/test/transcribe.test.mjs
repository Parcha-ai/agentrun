// `vision.transcribe` and its transcribers. Each adapter makes the call its provider documents, with the host's key and
// nothing else, and gives the words in one shape; the global, as an agent's code calls it on a real pi-durable Harness,
// reads one file through the call's environment, answers with the words, files and tells one receipt, reads the same
// file back without paying, refuses what it cannot send with a typed miss, and never lets the key out. A run killed
// between two files pays for each once. Every file is built by the test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { fakeTranscriptionFetch, pngBytes, SENTINEL_TRANSCRIBER_KEY } from "@parcha/pi-vision/testing";
import { elevenLabsTranscriber, falTranscriber, openAiTranscriber } from "@parcha/pi-vision/transcribers";
import { codeTool } from "./durable/code-tool.mjs";
import { drive, textOf, tmp } from "./durable/rig.mjs";

const WORDS = [{ text: "Tranquility", start: 3.06, end: 3.7 }, { text: "Base", start: 3.7, end: 4 }, { text: "here.", start: 4, end: 4.3 }, { text: "The", start: 5.5, end: 5.6 }, { text: "Eagle", start: 5.6, end: 5.9 }];
/** An MP3 as its first bytes say: an ID3 tag, then frame bytes the fakes never decode. */
const mp3 = (size = 4096) => Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(size, 0x55)]);
const AUDIO = { bytes: mp3(), mimeType: "audio/mpeg", name: "landing.mp3" };
const key = () => SENTINEL_TRANSCRIBER_KEY;

test("fal's queue: the data URI submitted with fal's own Key header, polled to COMPLETED, words without spacing", async () => {
  const fake = fakeTranscriptionFetch("fal", { words: WORDS });
  const t = await falTranscriber({ apiKey: key, fetch: fake.fetch, pollMs: 1 }).transcribe(AUDIO, { language: "eng" });
  assert.deepEqual(fake.requests.map((r) => [r.method, r.url]), [
    ["POST", "https://queue.fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2"],
    ["GET", "https://queue.fal.run/fal-ai/elevenlabs/requests/fake-1/status"],
    ["GET", "https://queue.fal.run/fal-ai/elevenlabs/requests/fake-1/status"],
    ["GET", "https://queue.fal.run/fal-ai/elevenlabs/requests/fake-1"],
  ]);
  assert.ok(fake.requests.every((r) => r.headers.Authorization === `Key ${SENTINEL_TRANSCRIBER_KEY}`));
  const sent = fake.requests[0].fields;
  assert.deepEqual([sent.audio_url.slice(0, 23), Buffer.from(sent.audio_url.split(",")[1], "base64").equals(AUDIO.bytes), sent.language_code, sent.diarize], ["data:audio/mpeg;base64,", true, "eng", false]);
  assert.deepEqual(t.words, WORDS, "spacing entries dropped, one shape");
});

test("fal through a pass-through: a bearer key at the pass-through's address, fal's own addresses rewritten to it", async () => {
  const fake = fakeTranscriptionFetch("fal", { words: WORDS });
  await falTranscriber({ apiKey: key, fetch: fake.fetch, pollMs: 1, queueUrl: "http://broker.invalid/fal-queue/", auth: "bearer" }).transcribe(AUDIO, {});
  assert.deepEqual(fake.requests.map((r) => r.url), [
    "http://broker.invalid/fal-queue/fal-ai/elevenlabs/speech-to-text/scribe-v2",
    "http://broker.invalid/fal-queue/fal-ai/elevenlabs/requests/fake-1/status",
    "http://broker.invalid/fal-queue/fal-ai/elevenlabs/requests/fake-1/status",
    "http://broker.invalid/fal-queue/fal-ai/elevenlabs/requests/fake-1",
  ]);
  assert.ok(fake.requests.every((r) => r.headers.Authorization === `Bearer ${SENTINEL_TRANSCRIBER_KEY}`));
});

test("ElevenLabs: multipart with scribe_v2, word times, the key as xi-api-key", async () => {
  const fake = fakeTranscriptionFetch("elevenlabs", { words: WORDS });
  const t = await elevenLabsTranscriber({ apiKey: key, fetch: fake.fetch }).transcribe(AUDIO, {});
  const [r] = fake.requests;
  assert.deepEqual([r.method, r.url, r.headers["xi-api-key"], r.headers.Authorization], ["POST", "https://api.elevenlabs.io/v1/speech-to-text", SENTINEL_TRANSCRIBER_KEY, undefined]);
  assert.deepEqual([r.fields.model_id, r.fields.timestamps_granularity, r.fields.file], ["scribe_v2", "word", { name: "landing.mp3", type: "audio/mpeg", size: AUDIO.bytes.length }]);
  assert.deepEqual([t.words, t.model], [WORDS, "scribe_v2"]);
});

test("OpenAI: whisper-1 with verbose_json and word times, a bearer key, and the file's duration", async () => {
  const fake = fakeTranscriptionFetch("openai", { words: WORDS, durationS: 30 });
  const t = await openAiTranscriber({ apiKey: key, fetch: fake.fetch }).transcribe(AUDIO, { language: "en" });
  const [r] = fake.requests;
  assert.deepEqual([r.url, r.headers.Authorization], ["https://api.openai.com/v1/audio/transcriptions", `Bearer ${SENTINEL_TRANSCRIBER_KEY}`]);
  assert.deepEqual([r.fields.model, r.fields.response_format, r.fields["timestamp_granularities[]"], r.fields.language], ["whisper-1", "verbose_json", "word", "en"]);
  assert.deepEqual([t.words, t.durationS], [WORDS, 30]);
});

const workspace = (files) => {
  const dir = tmp("vision-transcribe-");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};
const host = (transcriber) => {
  const filed = [], looks = [], misses = [];
  const vision = createVisionExtension({ ...(transcriber ? { transcriber } : {}), evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}.md` }; } }, onLook: (look) => looks.push(look), onMiss: (miss) => misses.push(miss), scope: () => ({ label: "hear", deriveDir: ".vision" }) });
  return { vision, filed, looks, misses };
};
const ran = async (vision, cwd, code) => JSON.parse(textOf((await drive({ extensions: [codeTool(vision), vision.extension], rounds: [[["code", { code }]]], cwd })).results[0]));
const twice = `const out = []; for (const _ of [1, 2]) { try { const t = await vision.transcribe({ path: "landing.mp3", fragment: "film.mp4#t=780,840" }); out.push({ words: t.words, text: t.text, provider: t.provider, model: t.model, costUsd: t.costUsd, receipts: t.receipts, kept: t.kept ?? false }); } catch (error) { out.push(error.message); } } return out;`;

test("the global answers with the words, files and tells one receipt, reads the same file back without paying, and the key goes nowhere", async () => {
  const fake = fakeTranscriptionFetch("openai", { words: WORDS, durationS: 30 });
  const h = host(openAiTranscriber({ apiKey: key, fetch: fake.fetch, usdPerMinute: 0.006 }));
  const seen = await ran(h.vision, workspace({ "landing.mp3": mp3() }), twice);
  assert.equal(seen.ok, true, seen.error);
  const [first, again] = seen.value;
  assert.deepEqual([first.words, first.provider, first.model, first.costUsd, first.kept], [WORDS, "openai", "whisper-1", 0.003, false], "30 s at $0.006 a minute");
  assert.deepEqual([again.words, again.costUsd, again.kept], [WORDS, 0.003, true], "read back: the same words, the price it was paid");
  assert.equal(fake.requests.length, 1, "one request for the file");
  const [r] = h.filed;
  assert.deepEqual([r.tool, r.args.path, r.args.ask, r.args.model, r.args.via, r.facts.kind, r.facts.cost_usd, r.facts.provider], ["look", "film.mp4#t=780,840", "transcribe", "whisper-1", "openai", "audio", 0.003, "openai"]);
  assert.equal(r.body, "3.06\t4.30\tTranquility Base here.\n5.50\t5.90\tThe Eagle", "the receipt is the transcript in rows, a row at each pause");
  assert.deepEqual(h.looks.map((l) => l.kept ?? false), [false, true], "told once as paid, then as kept");
  const everything = JSON.stringify({ seen, filed: h.filed, looks: h.looks, misses: h.misses, requests: fake.requests.map((x) => x.fields) });
  assert.equal(everything.includes(SENTINEL_TRANSCRIBER_KEY), false, "no answer, receipt, row or miss carries the key");
});

test("a transcription that cannot be made throws its code: no model, over the provider's limit (named), not audio, a refused request; the key in none", async () => {
  const none = host();
  const cwd = workspace({ "landing.mp3": mp3(), "big.mp3": mp3(2_500_000), "scan.png": pngBytes(40, 30) });
  const ask = (file) => `try { await vision.transcribe({ path: "${file}" }); return "transcribed"; } catch (error) { return error.message; }`;
  assert.equal((await ran(none.vision, cwd, ask("landing.mp3"))).value, "no_vision_route: this host gives vision.transcribe no speech-to-text model");
  const fal = fakeTranscriptionFetch("fal", { words: WORDS });
  const capped = host(falTranscriber({ apiKey: key, fetch: fal.fetch, pollMs: 1 }));
  assert.match((await ran(capped.vision, cwd, ask("big.mp3"))).value, /^over_budget: big\.mp3 is 2500010 bytes, over the 2\.4 MB \(10 minutes at 32 kbps\) fal takes in one request; cut it into shorter pieces/);
  assert.equal(fal.requests.length, 0, "refused before any request");
  assert.match((await ran(capped.vision, cwd, ask("scan.png"))).value, /^unsupported: scan\.png reads as image, not audio or a video/);
  const refused = fakeTranscriptionFetch("elevenlabs", { words: WORDS, refuse: { status: 401, body: '{"detail":"invalid api key"}' } });
  const denied = host(elevenLabsTranscriber({ apiKey: key, fetch: refused.fetch }));
  assert.equal((await ran(denied.vision, cwd, ask("landing.mp3"))).value, 'look_failed: elevenlabs failed: ElevenLabs refused the request: 401 {"detail":"invalid api key"}');
  assert.deepEqual([...none.misses, ...capped.misses, ...denied.misses].map((m) => m.code), ["no_vision_route", "over_budget", "unsupported", "look_failed"]);
  assert.deepEqual(denied.filed.map((r) => [r.status, r.facts.kind, r.facts.cost_usd]), [["failed", "audio", undefined]], "a request that threw has no known price");
  const everything = JSON.stringify([none, capped, denied].map(({ filed, looks, misses }) => ({ filed, looks, misses })));
  assert.equal(everything.includes(SENTINEL_TRANSCRIBER_KEY), false);
});

const CHILD = path.join(import.meta.dirname, "durable", "transcribe-child.mjs");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

test("killed while the second file is sent, on a host that never reruns a cut call: the next call reads the first back and sends only the second", async (t) => {
  const dir = tmp("vision-transcribe-kill-");
  const paths = { DB: path.join(dir, "run.sqlite"), CWD: path.join(dir, "work"), OUT: path.join(dir, "out"), LEDGER: path.join(dir, "sent.jsonl") };
  fs.mkdirSync(paths.CWD); fs.mkdirSync(paths.OUT);
  fs.writeFileSync(path.join(paths.CWD, "a.mp3"), mp3(1000));
  fs.writeFileSync(path.join(paths.CWD, "b.mp3"), mp3(2000));
  const child = (mode) => {
    const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...paths, MODE: mode }, stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    return { proc, exit: new Promise((resolve) => proc.on("exit", () => resolve(stdout.split("\n").find((l) => l.startsWith("RESULT "))))) };
  };
  const first = child("first");
  for (let waited = 0; !fs.existsSync(path.join(paths.CWD, ".cut")); waited += 20) {
    assert.ok(waited < 60_000, "the first process never sent the second file");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  first.proc.kill("SIGKILL");
  await first.exit;
  const line = await child("second").exit;
  assert.ok(line, "the second process printed its result");
  const { settled, results } = JSON.parse(line.slice("RESULT ".length));
  assert.equal(settled, "done");
  const calls = results.filter((r) => r.tool === "code");
  assert.deepEqual(JSON.parse(calls.at(-1).content[0].text).value.map((v) => v.kept ?? false), [true, false], "the first read back, the second sent");
  assert.deepEqual(lines(paths.LEDGER).map((l) => [l.by, l.file]), [["first", "a.mp3"], ["first", "b.mp3"], ["second", "b.mp3"]], "a.mp3 sent once in all");
  const told = lines(path.join(paths.OUT, "looks.jsonl"));
  assert.deepEqual(told.map((l) => [l.by, l.kept]), [["first", false], ["second", true], ["second", false]]);
});
