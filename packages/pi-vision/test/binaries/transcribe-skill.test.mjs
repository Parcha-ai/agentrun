// The transcribe skill's steps run as written: each ```bash block of skills/transcribe/SKILL.md, in order, in one shell
// over a workspace holding a 20 s clip of a public-domain film's audio (assets/apollo11-landing.webm, see ASSETS.md),
// against a fake fal queue on 127.0.0.1 reached the way a host's pass-through is (its status and response addresses
// name fal's own host, so the skill must call them through the queue address it was given). The first chunk is
// answered in fal's word shape, the second in OpenAI's verbose_json shape; the transcript holds both, in seconds of
// the whole clip. Needs ffmpeg and node: `npm run test:binaries` runs it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const SKILL = fs.readFileSync(new URL("../../skills/transcribe/SKILL.md", import.meta.url), "utf8");
const [settings, chunk, transcribe, write, search, ...more] = [...SKILL.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
const CLIP = new URL("./assets/apollo11-landing.webm", import.meta.url);
const MODEL = "fal-ai/elevenlabs/speech-to-text/scribe-v2";

/** What fal answers for each chunk, in order: its own word shape with spacing entries, then OpenAI's. */
const ANSWERS = [
  { text: "We copy you down, Eagle. Tranquility Base here.", language_code: "eng", words: [["We", 2.04, 2.2], ["copy", 2.2, 2.5], ["you", 2.5, 2.6], ["down,", 2.6, 2.9], ["Eagle.", 2.9, 3.4], ["Tranquility", 8.06, 8.7], ["Base", 8.7, 9.0], ["here.", 9.0, 9.4]].flatMap(([text, start, end], i) => [...(i ? [{ text: " ", start, end: start, type: "spacing" }] : []), { text, start, end, type: "word", speaker_id: null }]) },
  { text: "The Eagle has landed.", task: "transcribe", words: [["The", 0.3, 0.45], ["Eagle", 0.45, 0.8], ["has", 0.8, 1.0], ["landed.", 1.0, 1.6]].map(([word, start, end]) => ({ word, start, end })) },
];

/** The fake queue: submits, each request's status polls, and the answer each request id gives once COMPLETED. */
const submits = [], polls = new Map(), answers = new Map();
const fal = (id) => `https://queue.fal.run/fal-ai/elevenlabs/requests/${id}`;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const reply = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const url = req.url ?? "";
    if (req.method === "POST" && url === `/fal-queue/${MODEL}`) {
      const id = `r${submits.length + 1}`;
      submits.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      if (!answers.has(id)) answers.set(id, ANSWERS[submits.length - 1] ?? { error: "no more chunks" });
      return reply(200, { request_id: id, status_url: `${fal(id)}/status`, response_url: fal(id) });
    }
    const status = /^\/fal-queue\/fal-ai\/elevenlabs\/requests\/([^/]+)\/status$/.exec(url);
    if (req.method === "GET" && status && status[1].startsWith("denied")) {
      polls.set(status[1], (polls.get(status[1]) ?? 0) + 1);
      return reply(401, { detail: "the key was refused" });
    }
    if (req.method === "GET" && status && answers.has(status[1])) {
      const n = (polls.get(status[1]) ?? 0) + 1;
      polls.set(status[1], n);
      return reply(200, { status: n === 1 ? "IN_PROGRESS" : "COMPLETED", request_id: status[1] });
    }
    const response = /^\/fal-queue\/fal-ai\/elevenlabs\/requests\/([^/]+)$/.exec(url);
    if (req.method === "GET" && response && answers.has(response[1])) return reply(200, answers.get(response[1]));
    reply(404, { detail: "not found" });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vision-transcribe-skill-"));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
fs.copyFileSync(CLIP, path.join(cwd, "landing.webm"));
const env = { ...process.env, VIDEO: "landing.webm", CHUNK: "12", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_API_KEY: "test-key" };
delete env.STT_MODEL;
delete env.FAL_QUEUE_URL;
/** Runs shell code in the workspace as an agent's shell would, resolving its output. */
const sh = (code, more = {}) => new Promise((resolve, reject) => execFile("bash", ["-euo", "pipefail", "-c", code], { cwd, env: { ...env, ...more } }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout))));
/** The folder the skill keeps a video's files in: a hash of the path it was named by. */
const folder = (video) => path.join(cwd, ".hear", createHash("sha256").update(video).digest("hex").slice(0, 16));
const HEAR = folder("landing.webm");
const rows = () => fs.readFileSync(path.join(HEAR, "transcript.tsv"), "utf8").trim().split("\n").map((line) => line.split("\t"));
const pollCount = () => [...polls.values()].reduce((a, b) => a + b, 0);

test("the skill holds the five steps this test runs, and nothing more", () => {
  assert.deepEqual([settings, chunk, transcribe, write, search].map((code) => typeof code), ["string", "string", "string", "string", "string"]);
  assert.deepEqual(more, []);
});

test("two chunks submitted once each and polled to their answers, one transcript in seconds of the whole clip, a phrase found with its second", async () => {
  await sh(settings + chunk + transcribe + write);
  const starts = fs.readFileSync(path.join(HEAR, "chunks.csv"), "utf8").trim().split("\n").map((line) => Number(line.split(",")[1]));
  assert.equal(starts.length, 2, "a 20 s clip in 12 s chunks is two");
  assert.ok(Math.abs(starts[1] - 12) < 0.1, `the second chunk starts at ${starts[1]}`);

  assert.equal(submits.length, 2);
  for (const s of submits) {
    assert.equal(s.auth, "Bearer test-key");
    assert.deepEqual(Object.keys(s.body), ["audio_url"]);
    assert.ok(s.body.audio_url.startsWith("data:audio/mpeg;base64,") && Buffer.from(s.body.audio_url.split(",")[1], "base64").length > 1000, "each chunk's audio is sent as a data URI");
  }
  assert.deepEqual([...polls.values()], [2, 2], "each request polled through the queue address until COMPLETED");

  const at = (s) => s.toFixed(2);
  assert.deepEqual(rows(), [
    ["2.04", "3.40", "We copy you down, Eagle."],
    ["8.06", "9.40", "Tranquility Base here."],
    [at(starts[1] + 0.3), at(starts[1] + 1.6), "The Eagle has landed."],
  ], "both word shapes read, a pause starting a row, the second chunk's words at its start plus their own");

  const found = await sh(settings + search).catch(() => sh(settings + search.replace(/^rg /m, "grep ")));
  assert.equal(found.trim(), `3:${at(starts[1] + 0.3)}\t${at(starts[1] + 1.6)}\tThe Eagle has landed.`, "the row and its start, which is the second to cite");
});

test("run again, the skill sends nothing: each chunk's transcript is the cache", async () => {
  const before = [submits.length, pollCount()];
  await sh(settings + chunk + transcribe + write);
  assert.deepEqual([submits.length, pollCount()], before);
  assert.equal(rows().length, 3);
});

test("a run cut after a chunk was submitted resumes by polling that request, never by sending the chunk again", async () => {
  fs.copyFileSync(CLIP, path.join(cwd, "resume.webm"));
  await sh(settings + chunk, { VIDEO: "resume.webm" });
  answers.set("kept-1", ANSWERS[0]);
  fs.writeFileSync(path.join(folder("resume.webm"), "c000.req.json"), JSON.stringify({ request_id: "kept-1", status_url: `${fal("kept-1")}/status`, response_url: fal("kept-1") }));
  const before = submits.length;
  answers.set(`r${before + 1}`, ANSWERS[1]);
  await sh(settings + chunk + transcribe, { VIDEO: "resume.webm" });
  assert.equal(submits.length, before + 1, "only the chunk that had no request was sent");
  assert.equal(polls.get("kept-1"), 2, "the kept request was polled to its answer");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder("resume.webm"), "c000.json"), "utf8")), ANSWERS[0]);
});

test("a second video in the same workspace gets its own audio and chunks, and the first's are untouched", async () => {
  fs.copyFileSync(CLIP, path.join(cwd, "other.webm"));
  const first = fs.readFileSync(path.join(HEAR, "chunks.csv"), "utf8");
  await sh(settings + chunk, { VIDEO: "other.webm" });
  const other = folder("other.webm");
  assert.ok(fs.statSync(path.join(other, "audio.mp3")).size > 1000, "its own audio");
  assert.equal(fs.readFileSync(path.join(other, "chunks.csv"), "utf8").trim().split("\n").length, 2, "its own chunks");
  assert.equal(fs.readFileSync(path.join(HEAR, "chunks.csv"), "utf8"), first);
  assert.equal(fs.existsSync(path.join(other, "transcript.tsv")), false, "no transcript borrowed from the first video");
});

test("two paths that differ only by a slash get two folders, never one transcript", async () => {
  fs.mkdirSync(path.join(cwd, "videos"), { recursive: true });
  fs.copyFileSync(CLIP, path.join(cwd, "videos", "talk.webm"));
  fs.copyFileSync(CLIP, path.join(cwd, "videos_talk.webm"));
  await sh(settings + chunk, { VIDEO: "videos/talk.webm" });
  await sh(settings + chunk, { VIDEO: "videos_talk.webm" });
  assert.notEqual(folder("videos/talk.webm"), folder("videos_talk.webm"));
  for (const name of ["videos/talk.webm", "videos_talk.webm"]) {
    assert.equal(fs.readFileSync(path.join(folder(name), "video"), "utf8"), `${name}\n`, "the folder says which video it holds");
    assert.ok(fs.statSync(path.join(folder(name), "audio.mp3")).size > 1000, `${name} has its own audio`);
    assert.equal(fs.readFileSync(path.join(folder(name), "chunks.csv"), "utf8").trim().split("\n").length, 2, `${name} has its own chunks`);
  }
});

test("a run cut short leaves only temporary files, and the next run redoes them instead of taking them as done", async () => {
  fs.copyFileSync(CLIP, path.join(cwd, "cut.webm"));
  const cut = folder("cut.webm");
  fs.mkdirSync(cut, { recursive: true });
  fs.writeFileSync(path.join(cut, "audio.tmp.mp3"), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(cut, "chunks.tmp.csv"), "c000.mp3,0.000000,1.000000\n");
  await sh(settings + chunk, { VIDEO: "cut.webm" });
  const lines = fs.readFileSync(path.join(cut, "chunks.csv"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "the whole clip, in two chunks");
  assert.ok(Number(lines[1].split(",")[2]) > 19, "the last chunk ends at the clip's end");
  assert.equal(fs.existsSync(path.join(cut, "chunks.tmp.csv")), false);
});

test("a queue that refuses a poll stops the run at once with its own error, and the request is kept for the next run", async () => {
  fs.copyFileSync(CLIP, path.join(cwd, "refused.webm"));
  await sh(settings + chunk, { VIDEO: "refused.webm" });
  const kept = path.join(folder("refused.webm"), "c000.req.json");
  fs.writeFileSync(kept, JSON.stringify({ request_id: "denied-1", status_url: `${fal("denied-1")}/status`, response_url: fal("denied-1") }));
  const before = submits.length;
  await assert.rejects(sh(settings + chunk + transcribe, { VIDEO: "refused.webm" }), /poll .*c000 \(its request is kept\): 401 .*the key was refused/);
  assert.equal(polls.get("denied-1"), 1, "one refused poll, not a loop of them");
  assert.equal(submits.length, before, "nothing sent");
  assert.ok(fs.existsSync(kept), "the request is kept");
});
