// The transcribe skill's steps run as written: each ```bash block of skills/transcribe/SKILL.md, in order, in one shell
// over a workspace holding a 20 s clip of a public-domain film's audio (assets/apollo11-landing.webm, see ASSETS.md),
// against a fake OpenAI-compatible transcription server on 127.0.0.1. The first chunk is answered in OpenAI's
// verbose_json word shape, the second in fal's; the transcript holds both, in seconds of the whole clip. Needs ffmpeg,
// curl and node: `npm run test:binaries` runs it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const SKILL = fs.readFileSync(new URL("../../skills/transcribe/SKILL.md", import.meta.url), "utf8");
const [settings, chunk, transcribe, write, search, ...more] = [...SKILL.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
const CLIP = new URL("./assets/apollo11-landing.webm", import.meta.url);

/** What a transcription server answers for each chunk, in order: OpenAI's word shape, then fal's with spacing entries. */
const ANSWERS = [
  { text: "We copy you down, Eagle. Tranquility Base here.", words: [["We", 2.04, 2.2], ["copy", 2.2, 2.5], ["you", 2.5, 2.6], ["down,", 2.6, 2.9], ["Eagle.", 2.9, 3.4], ["Tranquility", 8.06, 8.7], ["Base", 8.7, 9.0], ["here.", 9.0, 9.4]].map(([word, start, end]) => ({ word, start, end })) },
  { text: "The Eagle has landed.", words: [["The", 0.3, 0.45], ["Eagle", 0.45, 0.8], ["has", 0.8, 1.0], ["landed.", 1.0, 1.6]].flatMap(([text, start, end], i) => [...(i ? [{ text: " ", start, end: start, type: "spacing" }] : []), { text, start, end, type: "word", speaker_id: null }]) },
];

/** The fields of a multipart body: each name with its text, or with `bytes` for a file. */
function fields(body, type) {
  const out = {};
  const boundary = /boundary=(.+)$/.exec(type ?? "")?.[1];
  if (!boundary) return out;
  for (const part of body.toString("latin1").split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = part.split("\r\n\r\n");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (!name) continue;
    const value = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    out[name] = /filename="/.test(head) ? { bytes: Buffer.from(value, "latin1").length } : value;
  }
  return out;
}

const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    // Only the transcription route is the skill's; anything else on this port is not counted.
    if (req.method !== "POST" || req.url !== "/v1/audio/transcriptions") { res.writeHead(404).end(); return; }
    requests.push({ path: req.url, auth: req.headers.authorization, fields: fields(Buffer.concat(chunks), req.headers["content-type"]) });
    const answer = ANSWERS[requests.length - 1];
    res.writeHead(answer ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(answer ? { task: "transcribe", language: "english", duration: 12, ...answer } : { error: "no more chunks" }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vision-transcribe-skill-"));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
fs.copyFileSync(CLIP, path.join(cwd, "landing.webm"));
const env = { ...process.env, VIDEO: "landing.webm", CHUNK: "12", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_API_KEY: "test-key" };
delete env.STT_MODEL;
/** Runs shell code in the workspace as an agent's shell would, resolving its output. */
const sh = (code, more = {}) => new Promise((resolve, reject) => execFile("bash", ["-euo", "pipefail", "-c", code], { cwd, env: { ...env, ...more } }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout))));
const HEAR = path.join(cwd, ".hear", "landing.webm");
const rows = () => fs.readFileSync(path.join(HEAR, "transcript.tsv"), "utf8").trim().split("\n").map((line) => line.split("\t"));

test("the skill holds the five steps this test runs, and nothing more", () => {
  assert.deepEqual([settings, chunk, transcribe, write, search].map((code) => typeof code), ["string", "string", "string", "string", "string"]);
  assert.deepEqual(more, []);
});

test("two chunks transcribed once each, one transcript in seconds of the whole clip, and a phrase found with its second", async () => {
  await sh(settings + chunk + transcribe + write);
  const starts = fs.readFileSync(path.join(HEAR, "chunks.csv"), "utf8").trim().split("\n").map((line) => Number(line.split(",")[1]));
  assert.equal(starts.length, 2, "a 20 s clip in 12 s chunks is two");
  assert.ok(Math.abs(starts[1] - 12) < 0.1, `the second chunk starts at ${starts[1]}`);

  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.equal(r.path, "/v1/audio/transcriptions");
    assert.equal(r.auth, "Bearer test-key");
    assert.deepEqual([r.fields.model, r.fields.response_format, r.fields["timestamp_granularities[]"]], ["fal-ai/elevenlabs/speech-to-text/scribe-v2", "verbose_json", "word"]);
    assert.ok(r.fields.file.bytes > 1000, "each chunk's audio is sent");
  }

  const at = (s) => s.toFixed(2);
  assert.deepEqual(rows(), [
    ["2.04", "3.40", "We copy you down, Eagle."],
    ["8.06", "9.40", "Tranquility Base here."],
    [at(starts[1] + 0.3), at(starts[1] + 1.6), "The Eagle has landed."],
  ], "both word shapes read, a pause starting a row, the second chunk's words at its start plus their own");

  const found = await sh(settings + search).catch(() => sh(settings + search.replace(/^rg /m, "grep ")));
  assert.equal(found.trim(), `3:${at(starts[1] + 0.3)}\t${at(starts[1] + 1.6)}\tThe Eagle has landed.`, "the row and its start, which is the second to cite");
});

test("run again, the skill sends nothing: each chunk's answer is the cache", async () => {
  const before = requests.length;
  await sh(settings + chunk + transcribe + write);
  assert.equal(requests.length, before);
  assert.equal(rows().length, 3);
});

test("a second video in the same workspace gets its own audio and chunks, and the first's are untouched", async () => {
  fs.copyFileSync(CLIP, path.join(cwd, "other.webm"));
  const first = fs.readFileSync(path.join(HEAR, "chunks.csv"), "utf8");
  await sh(settings + chunk, { VIDEO: "other.webm" });
  const other = path.join(cwd, ".hear", "other.webm");
  assert.ok(fs.statSync(path.join(other, "audio.mp3")).size > 1000, "its own audio");
  assert.equal(fs.readFileSync(path.join(other, "chunks.csv"), "utf8").trim().split("\n").length, 2, "its own chunks");
  assert.equal(fs.readFileSync(path.join(HEAR, "chunks.csv"), "utf8"), first);
  assert.equal(fs.existsSync(path.join(other, "transcript.tsv")), false, "no transcript borrowed from the first video");
});
