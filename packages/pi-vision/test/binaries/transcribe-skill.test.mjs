// The transcribe skill's steps run as written: each ```bash block of skills/transcribe/SKILL.md in one shell, and its
// ```js block in pi-codemode's sandbox with a `bash` tool and the handle's `vision.transcribe`, over a workspace holding
// a 20 s clip of a public-domain film's audio (assets/apollo11-landing.webm, see ASSETS.md) under the name the skill
// gives its video. A fake speech-to-text model says what each chunk says, by the chunk's name, in seconds of the chunk;
// the transcript has it in seconds of the whole clip. Needs ffmpeg, ffprobe and node: `npm run test:binaries` runs it.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";

const SKILL = fs.readFileSync(new URL("../../skills/transcribe/SKILL.md", import.meta.url), "utf8");
const blocks = (lang) => [...SKILL.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1]);
const [settings, chunk, write, search, ...moreShell] = blocks("bash");
const [transcribe, ...moreCode] = blocks("js");
const CLIP = new URL("./assets/apollo11-landing.webm", import.meta.url);

/** What the fake model hears in each chunk, by its file name: [word, start, end] in seconds of the chunk. */
const SAID = {
  "c000.mp3": [["We", 2.04, 2.2], ["copy", 2.2, 2.5], ["you", 2.5, 2.6], ["down,", 2.6, 2.9], ["Eagle.", 2.9, 3.4], ["Tranquility", 8.06, 8.7], ["Base", 8.7, 9.0], ["here.", 9.0, 9.4]],
  "c001.mp3": [["The", 0.3, 0.45], ["Eagle", 0.45, 0.8], ["has", 0.8, 1.0], ["landed.", 1.0, 1.6]],
  "c002.mp3": [["Roger,", 0.2, 0.6], ["Tranquility.", 0.6, 1.4]],
};
/** Every audio file the fake model was sent, in order. */
const sent = [];
/** The host's speech-to-text model, faked: `said` is what it hears, `refuse` names chunks it fails on; `maxBytes` and
 *  `limit` cap one request. */
const model = ({ said = SAID, refuse = [], ...limits } = {}) => ({
  provider: "fake", model: "fake-stt", usdPerMinute: 0.008, ...limits,
  async transcribe(audio) {
    sent.push({ name: audio.name, mimeType: audio.mimeType, bytes: audio.bytes.length });
    if (refuse.includes(audio.name)) throw new Error("the model refused the request: 503");
    const words = said[audio.name].map(([text, start, end]) => ({ text, start, end }));
    return { words, text: words.map((w) => w.text).join(" ") };
  },
});

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vision-transcribe-skill-"));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
fs.copyFileSync(CLIP, path.join(cwd, "talk.mp4"));
const env = { ...process.env, CHUNK: "12" };
delete env.VIDEO;
/** Runs shell code in the workspace as an agent's shell would, resolving its output. */
const sh = (code, more = {}) => new Promise((resolve, reject) => execFile("bash", ["-euo", "pipefail", "-c", code], { cwd, env: { ...env, ...more } }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout))));
/** The folder the skill keeps a video's files in, relative to the workspace: a hash of the path it was named by. */
const folder = (video) => `.hear/${createHash("sha256").update(video).digest("hex").slice(0, 16)}`;
const at = (...parts) => path.join(cwd, ...parts);
/** A bash tool as a host's code mode gives one: the command's output, or a rejection with it. */
const bash = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(`${stdout}${stderr}`)))) };
/** Runs the skill's code step for `video` as an agent would, naming the folder step 1 printed for it: the run, and the
 *  transcriptions the host was told of. */
async function code(video = "talk.mp4", stt = model()) {
  const looks = [];
  const vision = createVisionExtension({ transcriber: stt, evidence: { file: async (label) => ({ path: `evidence/${label}/${looks.length + 1}.md` }) }, scope: () => ({ label: "skill", deriveDir: ".vision" }), onLook: (look) => looks.push(look) });
  const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.transcribe(nodeVisionEnv({ cwd }), { conversationId: "skill", callId: "1" })] });
  try {
    return { run: await sandbox.execute(transcribe.replace('"talk.mp4"', JSON.stringify(video)).replace(folder("talk.mp4"), folder(video))), looks };
  } finally { await sandbox.close(); }
}
const chunks = (video) => fs.readFileSync(at(folder(video), "chunks.csv"), "utf8").trim().split("\n").map((line) => line.split(",").map((cell, i) => (i ? Number(cell) : cell)));
const rows = (video = "talk.mp4") => fs.readFileSync(at(folder(video), "transcript.tsv"), "utf8").trim().split("\n").map((line) => line.split("\t"));

test("the skill holds the four shell steps and the one code step this test runs, and the code names the folder step 1 prints", async () => {
  assert.deepEqual([settings, chunk, write, search, transcribe].map((block) => typeof block), Array(5).fill("string"));
  assert.deepEqual([...moreShell, ...moreCode], []);
  assert.equal((await sh(settings)).trim(), folder("talk.mp4"));
  assert.ok(transcribe.startsWith(`const video = "talk.mp4", H = "${folder("talk.mp4")}";`), "the code's folder is the one step 1 prints for its video");
});

test("each chunk transcribed once by the host's model, one transcript in seconds of the whole clip, a phrase found with its second", async () => {
  await sh(settings + chunk);
  const [[, , firstEnd], [, start, end]] = chunks("talk.mp4");
  assert.equal(chunks("talk.mp4").length, 2, "a 20 s clip in 12 s chunks is two");
  assert.ok(Math.abs(start - 12) < 0.1, `the second chunk starts at ${start}`);

  const { run, looks } = await code();
  assert.ok(run.ok, run.ok ? "" : run.error.message);
  assert.deepEqual(sent.map((s) => [s.name, s.mimeType]), [["c000.mp3", "audio/mpeg"], ["c001.mp3", "audio/mpeg"]], "each chunk sent once, as the audio it is");
  assert.ok(sent.every((s) => s.bytes > 1000));
  assert.deepEqual(run.value.map((d) => [d.file, d.rows, d.receipts.length]), [["c000.mp3", 2, 1], ["c001.mp3", 1, 1]]);
  assert.ok(Math.abs(run.value[0].costUsd - (firstEnd / 60) * 0.008) < 1e-5, `the first chunk priced by its length: ${run.value[0].costUsd}`);
  assert.deepEqual(looks.map((look) => look.record.args.path), [`talk.mp4#t=0,${firstEnd}`, `talk.mp4#t=${start},${end}`], "each receipt cites its window of the video");

  await sh(settings + write);
  const s = (n) => n.toFixed(2);
  assert.deepEqual(rows(), [
    ["2.04", "3.40", "We copy you down, Eagle."],
    ["8.06", "9.40", "Tranquility Base here."],
    [s(start + 0.3), s(start + 1.6), "The Eagle has landed."],
  ], "a pause starting a row, the second chunk's words at its start plus their own");

  const found = await sh(settings + search).catch(() => sh(settings + search.replace(/^rg /m, "grep ")));
  assert.deepEqual(found.trim().split("\n"), [folder("talk.mp4"), `3:${s(start + 0.3)}\t${s(start + 1.6)}\tThe Eagle has landed.`], "step 1's folder, then the row and its start, which is the second to cite");
});

test("run again, the skill sends nothing: each chunk's rows are the cache", async () => {
  const before = sent.length;
  const { run } = await code();
  assert.ok(run.ok, run.ok ? "" : run.error.message);
  assert.deepEqual(run.value, []);
  assert.equal(sent.length, before);
  await sh(settings + chunk + write);
  assert.equal(rows().length, 3);
});

test("a run stopped by a refused chunk keeps the chunks before it, writes no transcript without it, and the next run sends only that chunk", async () => {
  fs.copyFileSync(CLIP, at("resume.webm"));
  const more = { VIDEO: "resume.webm" };
  await sh(settings + chunk, more);
  const before = sent.length;
  const { run } = await code("resume.webm", model({ refuse: ["c001.mp3"] }));
  assert.equal(run.ok, false);
  assert.match(run.error.message, /^look_failed: fake failed: the model refused the request: 503/);
  assert.ok(fs.existsSync(at(folder("resume.webm"), "c000.tsv")), "the first chunk's rows are kept");
  assert.equal(fs.existsSync(at(folder("resume.webm"), "c001.tsv")), false);
  await assert.rejects(sh(settings + write, more), /c001\.tsv/, "the transcript step names the chunk it lacks");
  assert.equal(fs.existsSync(at(folder("resume.webm"), "transcript.tsv")), false, "no transcript with a piece left out");

  const again = await code("resume.webm");
  assert.ok(again.run.ok, again.run.ok ? "" : again.run.error.message);
  assert.deepEqual(sent.slice(before).map((s) => s.name), ["c000.mp3", "c001.mp3", "c001.mp3"], "the first chunk once, the refused one again");
  await sh(settings + write, more);
  assert.deepEqual(rows("resume.webm"), rows());
});

test("a chunk over the model's limit stops the step with the limit named, before anything is sent", async () => {
  fs.copyFileSync(CLIP, at("long.webm"));
  await sh(settings + chunk, { VIDEO: "long.webm" });
  const before = sent.length;
  const { run } = await code("long.webm", model({ maxBytes: 1000, limit: "1 kB" }));
  assert.equal(run.ok, false);
  assert.match(run.error.message, new RegExp(`^over_budget: ${folder("long.webm").replace(".", "\\.")}/c000\\.mp3 is \\d+ bytes, over the 1 kB fake takes in one request; cut it into shorter pieces`));
  assert.equal(sent.length, before);
  assert.equal(fs.existsSync(at(folder("long.webm"), "c000.tsv")), false);
});

test("a word with a newline in it is written as text: no word a model returns can end the rows early and run a command", async () => {
  fs.copyFileSync(CLIP, at("inject.webm"));
  const more = { VIDEO: "inject.webm" };
  await sh(settings + chunk, more);
  const said = { ...SAID, "c000.mp3": [["here.\nROWS\ntouch injected\n", 2.04, 2.5]] };
  const { run } = await code("inject.webm", model({ said }));
  assert.ok(run.ok, run.ok ? "" : run.error.message);
  assert.equal(fs.existsSync(at("injected")), false, "no command ran");
  await sh(settings + write, more);
  assert.deepEqual(rows("inject.webm")[0], ["2.04", "2.50", "here. ROWS touch injected"]);
});

test("a write that fails leaves the chunk without rows, never a finished chunk", async () => {
  fs.copyFileSync(CLIP, at("full.webm"));
  const more = { VIDEO: "full.webm" };
  await sh(settings + chunk, more);
  fs.mkdirSync(at(folder("full.webm"), "c001.tsv.tmp"));
  const { run } = await code("full.webm");
  assert.equal(run.ok, false, "the failed write stops the step");
  assert.ok(fs.existsSync(at(folder("full.webm"), "c000.tsv")));
  assert.equal(fs.existsSync(at(folder("full.webm"), "c001.tsv")), false, "nothing renamed into place");
  fs.rmdirSync(at(folder("full.webm"), "c001.tsv.tmp"));
  const before = sent.length;
  assert.ok((await code("full.webm")).run.ok);
  assert.deepEqual(sent.slice(before).map((s) => s.name), ["c001.mp3"], "the next run writes it");
});

test("a shorter CHUNK after a chunk over the model's limit cuts the audio again, drops the old rows and fits", async () => {
  fs.copyFileSync(CLIP, at("short.webm"));
  const more = { VIDEO: "short.webm" };
  const capped = () => model({ maxBytes: 40_000, limit: "40 kB" });
  await sh(settings + chunk, more);
  const over = await code("short.webm", capped());
  assert.match(over.run.ok ? "" : over.run.error.message, /^over_budget: .*c000\.mp3 is \d+ bytes, over the 40 kB fake takes/);
  await sh(settings + chunk, { ...more, CHUNK: "8" });
  assert.equal(fs.readFileSync(at(folder("short.webm"), "chunk"), "utf8").trim(), "8");
  assert.deepEqual(chunks("short.webm").map(([file]) => file), ["c000.mp3", "c001.mp3", "c002.mp3"], "20 s in 8 s chunks");
  const before = sent.length;
  const fits = await code("short.webm", capped());
  assert.ok(fits.run.ok, fits.run.ok ? "" : fits.run.error.message);
  assert.deepEqual(sent.slice(before).map((s) => s.name), ["c000.mp3", "c001.mp3", "c002.mp3"]);
  await sh(settings + write, { ...more, CHUNK: "8" });
  assert.equal(rows("short.webm").length, 4);
  await sh(settings + chunk, { ...more, CHUNK: "8" });
  assert.equal(chunks("short.webm").length, 3, "the same CHUNK again keeps the chunks");
});

test("a different recording at the same path empties the folder: it is cut and transcribed afresh, never answered with the old words", async () => {
  fs.copyFileSync(CLIP, at("swap.webm"));
  const more = { VIDEO: "swap.webm" };
  await sh(settings + chunk, more);
  assert.ok((await code("swap.webm")).run.ok);
  await sh(settings + write, more);
  assert.equal(rows("swap.webm").length, 3);

  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", fileURLToPath(CLIP), "-t", "8", "-c", "copy", at("swap.webm")]);
  const before = sent.length;
  await sh(settings, more);
  assert.deepEqual(fs.readdirSync(at(folder("swap.webm"))).sort(), ["source", "video"], "the old recording's audio, chunks, rows and transcript are gone");
  assert.equal(fs.readFileSync(at(folder("swap.webm"), "source"), "utf8").trim(), createHash("sha256").update(fs.readFileSync(at("swap.webm"))).digest("hex"));
  await sh(settings + chunk, more);
  assert.equal(chunks("swap.webm").length, 1, "the new 8 s recording, in one chunk");
  assert.ok((await code("swap.webm")).run.ok);
  assert.deepEqual(sent.slice(before).map((s) => s.name), ["c000.mp3"], "the new recording sent");
  await sh(settings + write, more);
  assert.equal(rows("swap.webm").length, 2, "only the new recording's rows");
});

test("a second video in the same workspace gets its own audio and chunks, and the first's are untouched", async () => {
  fs.copyFileSync(CLIP, at("other.webm"));
  const first = fs.readFileSync(at(folder("talk.mp4"), "chunks.csv"), "utf8");
  await sh(settings + chunk, { VIDEO: "other.webm" });
  const other = folder("other.webm");
  assert.ok(fs.statSync(at(other, "audio.mp3")).size > 1000, "its own audio");
  assert.equal(chunks("other.webm").length, 2, "its own chunks");
  assert.equal(fs.readFileSync(at(folder("talk.mp4"), "chunks.csv"), "utf8"), first);
  assert.equal(fs.existsSync(at(other, "transcript.tsv")), false, "no transcript borrowed from the first video");
});

test("two paths that differ only by a slash get two folders, never one transcript", async () => {
  fs.mkdirSync(at("videos"), { recursive: true });
  fs.copyFileSync(CLIP, at("videos", "talk.webm"));
  fs.copyFileSync(CLIP, at("videos_talk.webm"));
  await sh(settings + chunk, { VIDEO: "videos/talk.webm" });
  await sh(settings + chunk, { VIDEO: "videos_talk.webm" });
  assert.notEqual(folder("videos/talk.webm"), folder("videos_talk.webm"));
  for (const name of ["videos/talk.webm", "videos_talk.webm"]) {
    assert.equal(fs.readFileSync(at(folder(name), "video"), "utf8"), `${name}\n`, "the folder says which video it holds");
    assert.ok(fs.statSync(at(folder(name), "audio.mp3")).size > 1000, `${name} has its own audio`);
    assert.equal(chunks(name).length, 2, `${name} has its own chunks`);
  }
});

test("a run cut short leaves only temporary files, and the next run redoes them instead of taking them as done", async () => {
  fs.copyFileSync(CLIP, at("cut.webm"));
  const cut = folder("cut.webm");
  fs.mkdirSync(at(cut), { recursive: true });
  fs.writeFileSync(at(cut, "source"), `${createHash("sha256").update(fs.readFileSync(CLIP)).digest("hex")}\n`);
  fs.writeFileSync(at(cut, "audio.tmp.mp3"), Buffer.alloc(4096, 1));
  fs.writeFileSync(at(cut, "chunks.tmp.csv"), "c000.mp3,0.000000,1.000000\n");
  await sh(settings + chunk, { VIDEO: "cut.webm" });
  const lines = chunks("cut.webm");
  assert.equal(lines.length, 2, "the whole clip, in two chunks");
  assert.ok(lines[1][2] > 19, "the last chunk ends at the clip's end");
  assert.equal(fs.existsSync(at(cut, "chunks.tmp.csv")), false);
});
