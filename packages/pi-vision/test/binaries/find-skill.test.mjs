// The find skill's five steps run as written: each ```js block of skills/find/SKILL.md runs in pi-codemode's sandbox with
// a `bash` tool over a workspace the test builds and the handle's `vision.see` and `vision.judge`. The video is a grey
// field where an orange box (a lookalike) shows from second 100 to 130 and a red box (the thing) from 187 to 240, with
// keyframes 30 seconds apart. The fake Jev looks at the pixels it is sent (red: yes, and the red's box; orange: maybe);
// the fake eyes decode the clip they are sent, ignoring any edit list as some decoders do, and name the first second with
// red, or the first image with red when they take no video. Needs ffmpeg and ffprobe: `npm run test:binaries` runs it,
// `npm test` does not.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { imageHeader } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fakeEyes, fixtureDir } from "@parcha/pi-vision/testing";
import { USD_PER_MTOK } from "../support/jev.mjs";

const SKILL = fs.readFileSync(new URL("../../skills/find/SKILL.md", import.meta.url), "utf8");
const [heard, narrow, scan, halve, name, check, ...more] = [...SKILL.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);

const FIRST = 187;
const JEV_USD = (1000 * USD_PER_MTOK) / 1e6;
/** A 300-second video at 5 frames a second with sound and a keyframe every 30 seconds, never at a scene change; at
 *  160x120 unless `scale` grows it. The red box shows over each span of `red` (seconds, both ends in). */
function video(file, { red = [[FIRST, 240]], orange = true, scale = 1 } = {}) {
  const box = (color, x, y, w, h, from, to) => `drawbox=x=${x * scale}:y=${y * scale}:w=${w * scale}:h=${h * scale}:color=${color}@1:t=fill:enable='between(t,${from},${to})'`;
  const boxes = [orange && box("orange", 16, 60, 40, 40, 100, 130), ...red.map(([from, to]) => box("red", 96, 24, 40, 48, from, to))].filter(Boolean);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x707070:s=${160 * scale}x${120 * scale}:r=5:d=300`, "-f", "lavfi", "-i", "sine=frequency=440:duration=300",
    ...(boxes.length ? ["-vf", boxes.join(",")] : []), "-g", "150", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", file]);
}

const dir = await fixtureDir("pi-vision-find-skill-");
after(() => dir.remove());
const cwd = dir.path;
video(path.join(cwd, "film.mp4"));
video(path.join(cwd, "film-best.mp4"), { scale: 4 });
video(path.join(cwd, "glimpse.mp4"), { red: [] });
video(path.join(cwd, "plain.mp4"), { red: [], orange: false });
video(path.join(cwd, "early.mp4"), { red: [[60, 80], [FIRST, 240]] });
video(path.join(cwd, "late.mp4"), { red: [[240, 280]] });
fs.copyFileSync(path.join(cwd, "film.mp4"), path.join(cwd, "my film.mp4"));
const ONCE = ["12.00\t14.40\tGood morning, it looks like rain.", "190.50\t193.20\tSomeone left an umbrella by the door.", "260.10\t262.00\tThat is all for today."];
/** The transcribe skill's transcript of a video, as it leaves it: one row a phrase, start and end in seconds. */
function transcript(rows = ONCE, name = "film.mp4") {
  fs.rmSync(path.join(cwd, ".hear"), { recursive: true, force: true });
  if (!rows) return;
  fs.mkdirSync(path.join(cwd, ".hear", "0123456789abcdef"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".hear", "0123456789abcdef", "video"), `${name}\n`);
  fs.writeFileSync(path.join(cwd, ".hear", "0123456789abcdef", "transcript.tsv"), `${rows.join("\n")}\n`);
}

const isRed = (r, g, b) => r > 150 && g < 100 && b < 100;
const isOrange = (r, g, b) => r > 150 && g > 120 && g < 200 && b < 100;
/** Whether an image holds red (with the red's box as fractions of its sides) or only orange. */
async function look(bytes) {
  const { data, info } = await sharp(Buffer.from(bytes)).raw().toBuffer({ resolveWithObject: true });
  let [left, top, right, bottom, red, orange] = [info.width, info.height, -1, -1, 0, 0];
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (isOrange(data[i], data[i + 1], data[i + 2])) orange++;
    if (!isRed(data[i], data[i + 1], data[i + 2])) continue;
    red++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { red: red >= 20 ? { left: left / info.width, right: (right + 1) / info.width, top: top / info.height, bottom: (bottom + 1) / info.height } : null, orange: orange >= 20 };
}

/** A Jev port that answers from the pixels of the one image it is sent: red is the thing, orange looks like it. */
function pixelJev() {
  const requests = [];
  const judge = async (params) => {
    const { bytes } = params.assets[params.state.images[0].image];
    const { red, orange } = await look(bytes);
    requests.push({ source: params.state.images[0].source, size: imageHeader(bytes), questions: params.questions });
    const answers = Object.fromEntries(Object.entries(params.questions).map(([key, q]) => [key, q.type === "noul"
      ? { type: "noul", noul: red ? 0.95 : orange ? 0.6 : 0.05 }
      : { type: "box", box: red ?? { top: 0, bottom: 1, left: 0, right: 1 }, confidence: red ? 0.9 : 0.2 }]));
    return { answers, model: params.model, usage: { input_tokens: 1000, output_tokens: 0 }, cost_usd: JEV_USD };
  };
  return { judge, requests };
}

/** The first second of a clip with red, decoded as a decoder that ignores the edit list decodes it; null when none. */
function firstRedSecond(clip) {
  const file = path.join(cwd, ".eyes-clip.mp4");
  fs.writeFileSync(file, Buffer.from(clip, "base64"));
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ignore_editlist", "1", "-i", file, "-vf", "fps=1,scale=16:12", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  for (let s = 0; s * 576 < raw.length; s++) {
    const frame = raw.subarray(s * 576, (s + 1) * 576);
    for (let i = 0; i < frame.length; i += 3) if (isRed(frame[i], frame[i + 1], frame[i + 2])) return s;
  }
  return null;
}

/** Eyes that look: a clip's first second with red, or the first image with red by the name it was sent under. */
function watchingEyes({ video: takesVideo = true } = {}) {
  let text = "";
  const base = fakeEyes({ accepts: { video: takesVideo }, answers: [() => text] });
  return { ...base, see: async (request, signal) => {
    const clip = request.parts.find((p) => p.type === "video");
    if (clip) {
      const s = firstRedSecond(clip.data);
      text = s === null ? "It is not seen in this clip." : `SECOND=${s}\nA red box appears.`;
    } else {
      let at = null;
      for (const part of request.parts) if (part.type === "image" && at === null && (await look(Buffer.from(part.data, "base64"))).red) at = part.fragment;
      text = at ? `AT=${at}\nA red box appears.` : "It is not in these images.";
    }
    return base.see(request, signal);
  } };
}

/** A bash tool as a host's code mode gives one: the command's output, or a rejection with it. */
const bash = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd, maxBuffer: 1 << 26 }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(`${stdout}${stderr}`)))) };
/** Runs the given steps in order, each in a sandbox of its own over the same workspace and the same eyes and Jev; `task`
 *  is the search's task.json after them. */
async function steps(codes, { eyes = watchingEyes(), jev = pixelJev() } = {}) {
  const vision = createVisionExtension({ eyes, jev: { judge: jev.judge }, evidence: { file: async () => null }, scope: () => ({ label: "find", deriveDir: ".vision" }) });
  const values = [];
  for (const [i, code] of codes.entries()) {
    const call = { conversationId: "find", callId: String(i + 1), model: undefined, signal: undefined };
    const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(nodeVisionEnv({ cwd }), call), vision.judge(nodeVisionEnv({ cwd }), call)] });
    try {
      const run = await sandbox.execute(code);
      assert.ok(run.ok, run.ok ? "" : run.error.message);
      values.push(run.value);
    } finally { await sandbox.close(); }
  }
  const kept = path.join(cwd, ".find", "umbrella", "task.json");
  return { values, eyes, jev, task: fs.existsSync(kept) ? JSON.parse(fs.readFileSync(kept, "utf8")) : null };
}
/** Step 1 with one of the task's fields set otherwise. */
const narrowWith = (from, to) => { const code = narrow.replace(from, to); assert.notEqual(code, narrow, `the task line holds ${from}`); return code; };
const xywh = (cite) => cite.split("xywh=percent:")[1].split(",").map(Number);
const near = (got, want, by, what) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= by, `${what}: ${got} is not within ${by} of ${want}`));

test("the skill holds the heard search and the five steps this test runs, and nothing more", () => {
  assert.deepEqual([heard, narrow, scan, halve, name, check].map((code) => typeof code), Array(6).fill("string"));
  assert.deepEqual(more, []);
});

test("heard: every time the phrase is said, with the rows around it; a phrase cut by a row's end is found across the two rows", async () => {
  transcript(["12.00\t14.40\tGood morning, it looks like rain.", "40.00\t41.50\tRemember the umbrella", "41.70\t43.40\tby the door, she said.",
    "120.00\t121.00\tLeave the umbrella by the doorway.", "190.50\t193.20\tSomeone left an umbrella by the door.", "193.90\t195.10\tAn umbrella by the door again?", "260.10\t262.00\tThat is all for today.",
    "300.00\t301.00\tTake the umbrella", "301.20\t303.00\tby the door; umbrella by the door."]);
  const { values: [found], jev, eyes } = await steps([heard]);
  assert.equal(found.transcript, ".hear/0123456789abcdef/transcript.tsv");
  assert.deepEqual(found.hits.map((h) => [h.at, h.cite, h.said]), [
    [40, "film.mp4#t=40.00", "Remember the umbrella by the door, she said."],
    [190.5, "film.mp4#t=190.50", "Someone left an umbrella by the door."],
    [193.9, "film.mp4#t=193.90", "An umbrella by the door again?"],
    [300, "film.mp4#t=300.00", "Take the umbrella by the door; umbrella by the door."],
    [301.2, "film.mp4#t=301.20", "by the door; umbrella by the door."],
  ], "across two rows, in rows one after another, across a row end with another in the next row; never 'by the doorway'");
  assert.deepEqual([found.hits[0].before, found.hits[0].after], ["Good morning, it looks like rain.", "Leave the umbrella by the doorway. Someone left an umbrella by the door."]);
  assert.deepEqual([found.hits[1].before, found.hits[1].after], ["by the door, she said. Leave the umbrella by the doorway.", "An umbrella by the door again? That is all for today."]);
  assert.deepEqual([jev.requests.length, eyes.ledger.length], [0, 0], "the transcript answers alone");
  transcript(null);
  assert.deepEqual((await steps([heard])).values[0], { transcript: null, hits: [] });
});

test("the loop: the transcript's hit narrows the search, Jev scans the window, the eyes name the second, Jev checks it and boxes it", async () => {
  transcript();
  const { values: [words, scanned, halved, named, checked], eyes, jev, task } = await steps([narrow, scan, halve, name, check]);
  assert.deepEqual(words.windows, [[130, 254]], "a minute either side of the one row that says umbrella");
  assert.deepEqual(words.hits, ["190.50\t193.20\tSomeone left an umbrella by the door."]);
  assert.deepEqual([scanned.step, scanned.frames, scanned.likely], [10, 26, [190, 200, 210, 220, 230, 240]], "13 in the window, then 13 before it (0 to 120)");
  assert.deepEqual(halved.window, [155, 215], "a minute around the span from the last low frame to the first likely one");
  assert.deepEqual(eyes.ledger.map((r) => r.parts.filter((p) => p.type !== "text").map((p) => `${p.type} ${p.fragment}`)), [["video film.mp4#t=155,215"]]);
  assert.equal(named.at, FIRST, "the eyes' second, counted from the window's start");
  assert.deepEqual(jev.requests.slice(0, 26).map((r) => r.source), [...Array.from({ length: 13 }, (_, i) => 130 + 10 * i), ...Array.from({ length: 13 }, (_, i) => 10 * i)].map((t) => `film.mp4#t=${t}`));
  assert.deepEqual(jev.requests.slice(26).map((r) => r.source), [186, 187, 188].map((t) => `film.mp4#t=${t}`));
  assert.deepEqual(jev.requests[26].questions.where, { type: "box", instructions: "the umbrella in `images[0].image`" }, "the box asked by its short name");
  assert.deepEqual([checked.found, checked.t], [true, FIRST], "the first of the three frames that passes");
  assert.match(checked.cite, /^film\.mp4#t=187&xywh=percent:/);
  near(xywh(checked.cite), [60, 20, 25, 40], 2, "the box");
  assert.equal(jev.requests.length, 29, "26 frames scanned, 3 checked");
  assert.ok(Math.abs(scanned.spentUsd - 26 * JEV_USD) < 1e-12, "the scan's answers, priced");
  assert.ok(named.spentUsd > halved.spentUsd, "the eyes' price added");
  assert.ok(Math.abs(checked.spentUsd - named.spentUsd - 3 * JEV_USD) < 1e-12 && task.spentUsd === checked.spentUsd, "the checks' price added and kept");
});

test("no transcript: the whole video is the window, and a lookalike Jev half believes does not start the search", async () => {
  transcript(null);
  const { values: [words, scanned, halved, named, checked], task } = await steps([narrow, scan, halve, name, check]);
  assert.deepEqual([words.transcript, words.windows], [null, [[0, 300]]]);
  assert.deepEqual(task.scores.filter(([, p]) => p === 0.6).map(([t]) => t), [100, 110, 120, 130], "the lookalike's frames");
  assert.deepEqual([scanned.step, scanned.frames, scanned.likely[0]], [10, 30, 190]);
  assert.deepEqual([halved.window, named.at, checked.t], [[155, 215], FIRST, FIRST]);
});

test("only a lookalike: the search starts from the best frame, and the eyes, seeing nothing, name no second", async () => {
  transcript(null);
  const { values: [, scanned, halved, named], eyes } = await steps([narrowWith('video: "film.mp4", best: "film.mp4"', 'video: "glimpse.mp4", best: "glimpse.mp4"'), scan, halve, name]);
  assert.deepEqual(scanned.likely, []);
  assert.deepEqual(halved.window, [65, 125], "around the span from 90 to 100, where the best frame scored 0.6");
  assert.equal(eyes.ledger.length, 1);
  assert.deepEqual([named.at, named.said], [null, "It is not seen in this clip."]);
});

test("a coarse scan is halved to a minute before the eyes watch it", async () => {
  transcript(null);
  const { values: [, scanned, halved, named, checked], jev } = await steps([narrowWith("scanFrames: 300", "scanFrames: 4"), scan, halve, name, check]);
  assert.deepEqual([scanned.step, scanned.likely], [75, [225]], "frames at 0, 75, 150 and 225: the span 150 to 225 holds the first second");
  assert.deepEqual(jev.requests.slice(4, 8).map((r) => r.source), [160, 169, 179, 188].map((t) => `film.mp4#t=${t}`), "four frames across the span's first half");
  assert.deepEqual(halved.window, [139, 199], "one halving: 150 to 188 is under a minute");
  assert.deepEqual([named.at, checked.t, jev.requests.length], [FIRST, FIRST, 11]);
});

test("the eyes' minute is encoded, not copied: a copy starts at the keyframe before it, and a decoder that ignores the edit list names a later second", async () => {
  transcript();
  await steps([narrow, scan, halve]);
  const copied = name.replace(/-c:v libx264 [^$]*?-flags \+bitexact/, "-c copy -fflags +bitexact");
  assert.notEqual(copied, name);
  const { values: [late] } = await steps([copied]);
  assert.equal(late.at, FIRST + 5, "the copy starts at the keyframe at 150, five seconds before the window");
  const { values: [right] } = await steps([name]);
  assert.equal(right.at, FIRST);
});

test("eyes that take no video get a frame a second of the minute, each named by its time", async () => {
  transcript();
  const { values: [, , , named, checked], eyes } = await steps([narrow, scan, halve, name, check], { eyes: watchingEyes({ video: false }) });
  const shown = eyes.ledger.flatMap((r) => r.parts.filter((p) => p.type === "image").map((p) => p.fragment));
  assert.deepEqual(shown, Array.from({ length: 60 }, (_, i) => `film.mp4#t=${155 + i}`));
  assert.deepEqual([named.at, checked.t], [FIRST, FIRST]);
});

test("the frames checked come from the best copy, and the box is cited on the video the question named", async () => {
  transcript();
  const { values: [, , , , checked], jev } = await steps([narrowWith('best: "film.mp4"', 'best: "film-best.mp4"'), scan, halve, name, check]);
  assert.deepEqual(jev.requests.slice(0, 26).map((r) => `${r.size.width}x${r.size.height}`), Array(26).fill("373x280"), "the scan's 160x120 frames, grown to Jev's smallest edge");
  assert.deepEqual(jev.requests.slice(26).map((r) => `${r.size.width}x${r.size.height}`), Array(3).fill("640x480"), "the checked frames are the best copy's");
  assert.match(checked.cite, /^film\.mp4#t=187&xywh=percent:/);
  near(xywh(checked.cite), [60, 20, 25, 40], 1, "the box on the best copy");
});

test("a budget: the scan stops once it is spent, and says what it spent", async () => {
  transcript();
  const { values: [, scanned] } = await steps([narrowWith("budgetUsd: 0.1", "budgetUsd: 0.0001"), scan]);
  assert.equal(scanned.frames, 3, "three frames at $0.000042 pass $0.0001");
  assert.equal(scanned.stopped, "budget");
  assert.ok(scanned.spentUsd >= 0.0001 && scanned.spentUsd < 0.0002);
});

test("a budget the scan spends to the end: the eyes and the checks ask nothing", async () => {
  transcript();
  const { values: [, scanned, , named, checked], eyes, jev } = await steps([narrowWith("budgetUsd: 0.1", `budgetUsd: ${25.5 * JEV_USD}`), scan, halve, name, check]);
  assert.deepEqual([scanned.frames, scanned.stopped], [26, "budget"]);
  assert.deepEqual([named.at, named.stopped], [null, "budget"]);
  assert.deepEqual([eyes.ledger.length, jev.requests.length], [0, 26]);
  assert.deepEqual([checked.found, checked.stopped], [false, "budget"]);
});

test("a step run again asks nothing it has, and counts nothing twice", async () => {
  transcript();
  const { values: [, once, again], jev } = await steps([narrow, scan, scan]);
  assert.equal(jev.requests.length, 26, "the second scan asked nothing");
  assert.deepEqual([again.frames, again.likely, again.spentUsd], [once.frames, once.likely, once.spentUsd]);
});

test("words say where to look first: a sighting before the window they name is found", async () => {
  transcript(ONCE, "early.mp4");
  const { values: [words, scanned, halved, named, checked] } = await steps([narrowWith('video: "film.mp4", best: "film.mp4"', 'video: "early.mp4", best: "early.mp4"'), scan, halve, name, check]);
  assert.deepEqual(words.windows, [[130, 254]]);
  assert.deepEqual(scanned.likely, [60, 70, 80, 190, 200, 210, 220, 230, 240], "the scan before the window found the red box at 60");
  assert.deepEqual([halved.window, named.at, checked.t], [[25, 85], 60, 60]);
});

test("a thing first seen right at a scanned frame is inside the minute the eyes watch", async () => {
  transcript(null);
  const { values: [, scanned, halved, named, checked] } = await steps([narrowWith('video: "film.mp4", best: "film.mp4", thing: "a red umbrella", box: "the umbrella", words: "umbrella|parasol", chapters: null, scanFrames: 300', 'video: "late.mp4", best: "late.mp4", thing: "a red umbrella", box: "the umbrella", words: "umbrella|parasol", chapters: null, scanFrames: 5'), scan, halve, name, check]);
  assert.deepEqual([scanned.step, scanned.likely], [60, [240]]);
  assert.deepEqual([halved.span, halved.window], [[210, 240], [195, 255]], "halved below 40 seconds, the minute holds 240");
  assert.deepEqual([named.at, checked.t], [240, 240]);
});

test("a name with a space is quoted for the shell everywhere", async () => {
  transcript(null);
  const { values: [, , , named, checked] } = await steps([narrowWith('video: "film.mp4", best: "film.mp4"', 'video: "my film.mp4", best: "my film.mp4"'), scan, halve, name, check]);
  assert.deepEqual([named.at, checked.t], [FIRST, FIRST]);
  assert.match(checked.cite, /^my film\.mp4#t=187&xywh=percent:/);
});

test("not found: no frame scores even 0.5, so the eyes are never asked and the two best frames are given", async () => {
  transcript(null);
  const { values: [, scanned, halved], eyes } = await steps([narrowWith('video: "film.mp4", best: "film.mp4"', 'video: "plain.mp4", best: "plain.mp4"'), scan, halve]);
  assert.deepEqual(scanned.likely, []);
  assert.deepEqual(halved, { found: false, best: [[0, 0.05], [10, 0.05]] });
  assert.equal(eyes.ledger.length, 0);
});
