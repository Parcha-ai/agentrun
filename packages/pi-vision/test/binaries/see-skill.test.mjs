// The look skill's examples run as written: each ```js block of skills/look/SKILL.md runs in pi-codemode's sandbox with a
// `bash` tool over a workspace the test builds and the handle's `vision.see` and `vision.judge`; fake eyes answer with
// the fragments they were shown, and a fake Jev with each question type's shape. Needs pdftoppm, ffmpeg and ffprobe:
// `npm run test:binaries` runs it, `npm test` does not.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { imageHeader } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fakeEyes, fixtureDir, pdfBytes, pngBytes } from "@parcha/pi-vision/testing";
import { ANSWERS, fakeJev } from "../support/jev.mjs";

const SKILL = fs.readFileSync(new URL("../../skills/look/SKILL.md", import.meta.url), "utf8");
const [pdfPages, longVideo, manyImages, region, classify, aroundEyes, byExample, presence, tiles, edges, ...more] = [...SKILL.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);

const dir = await fixtureDir("pi-vision-see-skill-");
after(() => dir.remove());
const cwd = dir.path;
await dir.file("report.pdf", pdfBytes(Array.from({ length: 12 }, (_, i) => ({ lines: [`Invented report for a test, page ${i + 1}`, `Invoice INV-${1000 + i}, total ${(i + 1) * 10}.00`] }))));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=35:size=320x240:rate=5", "-pix_fmt", "yuv420p", path.join(cwd, "talk.mp4")]);
fs.mkdirSync(path.join(cwd, "photos"));
for (const name of ["attic.png", "hall.png", "roof.png"]) fs.writeFileSync(path.join(cwd, "photos", name), pngBytes(64, 48));
fs.writeFileSync(path.join(cwd, "photos", "notes.txt"), "not a photo");
fs.writeFileSync(path.join(cwd, "scan.png"), pngBytes(800, 1000));
fs.mkdirSync(path.join(cwd, "examples"));
for (const name of ["roof.png", "hall.png"]) fs.writeFileSync(path.join(cwd, "examples", name), pngBytes(320, 240));

/** A bash tool as a host's code mode gives one: the command's output, or a rejection with it. */
const bash = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(`${stdout}${stderr}`)))) };
/** Runs one example: what it returned, every request the eyes saw, every request Jev got, and the looks the host was
 *  told of. `answer` is the fake Jev's answer to a question. */
async function example(code, answer) {
  const eyes = fakeEyes({ answers: [(request) => `saw ${request.parts.filter((p) => p.type === "image").map((p) => p.fragment).join(", ")}`] });
  const jev = fakeJev(answer ? { answer } : {});
  const examples = (params) => Object.keys(params.assets).filter((ref) => !ref.startsWith("<vision.judge image"));
  const looks = [];
  const vision = createVisionExtension({ eyes, jev: { judge: jev.judge }, evidence: { file: async (label) => ({ path: `evidence/${label}/${looks.length + 1}.md` }) }, scope: () => ({ label: "skill", deriveDir: ".vision" }), onLook: (look) => looks.push(look) });
  const call = { conversationId: "skill", callId: "1", model: undefined, signal: undefined };
  const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(nodeVisionEnv({ cwd }), call), vision.judge(nodeVisionEnv({ cwd }), call)] });
  try {
    const run = await sandbox.execute(code);
    assert.ok(run.ok, run.ok ? "" : run.error.message);
    return { value: run.value, requests: eyes.ledger.map((r) => r.parts.filter((p) => p.type === "image").map((p) => p.fragment)), judged: jev.requests.map((r) => ({ ...r.params, examples: examples(r.params) })), looks };
  } finally { await sandbox.close(); }
}

test("the skill holds the ten examples this test runs, and nothing more", () => {
  assert.deepEqual([pdfPages, longVideo, manyImages, region, classify, aroundEyes, byExample, presence, tiles, edges].map((code) => typeof code), Array(10).fill("string"));
  assert.deepEqual(more, []);
});

test("many PDF pages: rendered, asked in batches of ten, each page cited by its number", async () => {
  const { value, requests, looks } = await example(pdfPages);
  const pages = Array.from({ length: 12 }, (_, i) => `report.pdf#page=${i + 1}`);
  assert.deepEqual(requests.flat(), pages, "every page once, in order, named by its page");
  assert.deepEqual(requests.map((r) => r.length), [8, 2, 2], "a batch of ten is two requests within eight images; the last batch one");
  assert.match(value, /^\(report\.pdf#page=1, .* report\.pdf#page=8; look filed at evidence\/skill\/1\.md\)\nsaw report\.pdf#page=1, /);
  assert.match(value, /\(receipts: evidence\/skill\/1\.md, evidence\/skill\/2\.md\)\n\n.*\(receipts: evidence\/skill\/3\.md\)$/s);
  assert.equal(looks.length, 3);
});

test("a long video: a frame every ten seconds by seek, each cited by its time; run again on a shorter video, no frame of the first", async () => {
  const { value, requests } = await example(longVideo);
  assert.deepEqual(requests.flat(), ["talk.mp4#t=0", "talk.mp4#t=10", "talk.mp4#t=20", "talk.mp4#t=30"]);
  const frames = path.join(cwd, ".look", "frames");
  assert.ok(fs.readdirSync(frames).every((name) => imageHeader(fs.readFileSync(path.join(frames, name)))?.width === 320));
  assert.match(value, /^saw talk\.mp4#t=0, talk\.mp4#t=10, talk\.mp4#t=20, talk\.mp4#t=30\n\(receipts: evidence\/skill\/1\.md; \$\d/);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=15:size=320x240:rate=5", "-pix_fmt", "yuv420p", path.join(cwd, "talk.mp4")]);
  assert.deepEqual((await example(longVideo)).requests.flat(), ["talk.mp4#t=0", "talk.mp4#t=10"]);
});

test("many images: every photo by its own path, the file that is not one left out", async () => {
  const { value, requests } = await example(manyImages);
  assert.deepEqual(requests, [["photos/attic.png", "photos/hall.png", "photos/roof.png"]]);
  assert.equal(value, "saw photos/attic.png, photos/hall.png, photos/roof.png");
});

test("a region: cropped with ffmpeg first, cited by where it was", async () => {
  const { value } = await example(region);
  assert.deepEqual(imageHeader(fs.readFileSync(path.join(cwd, ".look", "scan-top-right.png"))), { mimeType: "image/png", width: 400, height: 250, orientation: 1 });
  assert.equal(value, "saw scan.png#xywh=percent:50,0,50,25");
});

const PAGES = Array.from({ length: 12 }, (_, i) => `report.pdf#page=${i + 1}`);

test("Jev: every page classified, one request a page, each named by its page", async () => {
  const { value, judged } = await example(classify);
  assert.deepEqual(judged.map((r) => r.state.images.map((i) => i.source)), PAGES.map((page) => [page]));
  assert.deepEqual(value[0], { page: 1, kind: "table", signed: true });
  assert.equal(value.length, 12);
});

test("Jev before and after the eyes: only the pages worth a look go to the eyes, and Jev checks what they said", async () => {
  // Odd pages are invoices; the eyes are asked about the first and Jev confirms it.
  const answer = (q, request) => (q.instructions.startsWith("Is `images[0].image` a readable page") ? { type: "noul", noul: parseInt(request.state.images[0].source.match(/p-(\d+)/)[1], 10) % 2 ? 0.9 : 0.1 } : ANSWERS[q.type](q));
  const { value, requests, judged } = await example(aroundEyes, answer);
  assert.deepEqual(value.pages, ["p-01.png", "p-03.png", "p-05.png", "p-07.png", "p-09.png", "p-11.png"]);
  assert.deepEqual(requests, [[".look/pages/p-01.png"]], "the eyes saw one page, not twelve");
  assert.equal(judged.length, 13, "twelve skips, then one check");
  assert.equal(judged.at(-1).questions.same.instructions, "Does `images[0].image` show the invoice number saw .look/pages/p-01.png?");
  assert.equal(value.confirmed, true);
  const none = await example(aroundEyes, (q) => (q.type === "noul" ? { type: "noul", noul: 0.1 } : ANSWERS[q.type](q)));
  assert.deepEqual([none.value, none.requests, none.judged.length], [{ pages: [], number: null, confirmed: false }, [], 12], "no page worth a look: the eyes are not asked");
});

test("Jev: photos classified by example images in the criteria", async () => {
  const { value, judged } = await example(byExample);
  assert.deepEqual(value, { "attic.png": "roof", "hall.png": "roof", "roof.png": "roof" });
  assert.deepEqual(judged.map((r) => r.examples), [["<roof>", "<hall>"], ["<roof>", "<hall>"], ["<roof>", "<hall>"]]);
  assert.deepEqual(judged[0].questions.room.criteria, { roof: "A roof seen from outside, like <roof>", hall: "A hallway indoors, like <hall>", neither: "Neither of these." });
});

test("Jev: a presence noul beside the box, and the box as a region of the scan", async () => {
  const { value, judged } = await example(presence);
  assert.equal(value, "signature at scan.png#xywh=percent:50,25,50,50");
  assert.deepEqual(Object.keys(judged[0].questions), ["present", "where"]);
});

test("Jev: tiles as the choice's options, then a box on the chosen tile, given back as a region of the whole scan", async () => {
  const { value, judged } = await example(tiles);
  assert.deepEqual(judged[0].examples, ["<tile top_left>", "<tile top_right>", "<tile bottom_left>", "<tile bottom_right>"]);
  assert.deepEqual(judged[0].state.images.map((i) => i.source), ["scan.png"]);
  for (const t of ["top_left", "top_right", "bottom_left", "bottom_right"]) assert.deepEqual(imageHeader(fs.readFileSync(path.join(cwd, ".look", "tiles", `${t}.png`))), { mimeType: "image/png", width: 400, height: 500, orientation: 1 });
  assert.deepEqual(judged[1].state.images.map((i) => i.source), ["scan.png#xywh=percent:0,0,50,50"], "the first tile, named by where it was cut");
  assert.equal(value, "scan.png#xywh=percent:25,12.5,25,25", "the box on the tile, as a region of the whole");
});

test("Jev: the box's crop asked about its four edges", async () => {
  const { value, judged } = await example(edges);
  assert.deepEqual(imageHeader(fs.readFileSync(path.join(cwd, ".look", "table.png"))), { mimeType: "image/png", width: 400, height: 500, orientation: 1 });
  assert.deepEqual(Object.keys(judged[1].questions), ["left", "right", "top", "bottom"]);
  assert.deepEqual(judged[1].state.images.map((i) => i.source), ["scan.png#xywh=percent:50,25,50,50"]);
  assert.deepEqual(value, ["left", "right", "top", "bottom"], "every edge the fake says yes to");
});

/** The skill's window cut, as written in its text. */
const CUT = SKILL.match(/`(mkdir -p \.look\/clips && ffmpeg [^`]*)`/)[1];
const run = (command) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout))));
/** The frame at `at` seconds of a video, small and grey, decoded with or without the container's edit list. */
const frameAt = (file, at, editList = true) => execFileSync("ffmpeg", ["-v", "error", ...(editList ? [] : ["-ignore_editlist", "1"]), "-ss", String(at), "-i", path.join(cwd, file), "-frames:v", "1", "-vf", "scale=32:24", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
const distance = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;

test("the skill's window cut is the same bytes when it is made again, from an MP4 or a WebM, so its look is found again", async () => {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=95:size=160x120:rate=5", "-c:v", "libvpx", "-b:v", "100k", path.join(cwd, "talk.webm")]);
  for (const source of ["talk.mp4", "talk.webm"]) {
    const sha = async () => {
      await run(CUT.replaceAll("talk.mp4", source));
      return createHash("sha256").update(fs.readFileSync(path.join(cwd, ".look", "clips", "60.mp4"))).digest("hex");
    };
    assert.equal(await sha(), await sha(), `${source} cut twice with the skill's flags: the same bytes`);
  }
});

test("the skill's window starts at its second 0 for every decoder: a copy starts at the keyframe before it, which a decoder that ignores the edit list shows first", async () => {
  // Keyframes every 25 s, so the one before 60 is at 50.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=95:size=160x120:rate=5", "-g", "125", "-sc_threshold", "0", "-pix_fmt", "yuv420p", path.join(cwd, "talk.mp4")]);
  const [at50, at60] = [frameAt("talk.mp4", 50), frameAt("talk.mp4", 60)];
  await run(CUT);
  for (const editList of [true, false]) assert.ok(distance(frameAt(".look/clips/60.mp4", 0, editList), at60) < 8, `second 0 is 60 with the edit list ${editList ? "read" : "ignored"}`);
  await run("mkdir -p .look/clips && ffmpeg -v error -y -ss 60 -t 30 -i talk.mp4 -c copy -fflags +bitexact .look/clips/copy.mp4");
  assert.ok(distance(frameAt(".look/clips/copy.mp4", 0), at60) < 8, "a copy read with its edit list starts at 60");
  assert.ok(distance(frameAt(".look/clips/copy.mp4", 0, false), at50) < 8, "a copy read without it starts at the keyframe at 50");
});

/** `pdf` with every page's crop box set to `box` (points), its cross-reference table written again. */
function withCropBox(pdf, box) {
  const body = Buffer.from(pdf).toString("latin1").replace(/\/MediaBox \[[^\]]*\]/g, (media) => `${media} /CropBox [${box.join(" ")}]`);
  const objects = body.slice(0, body.lastIndexOf("xref\n"));
  const offsets = [...objects.matchAll(/^(\d+) 0 obj$/gm)].map((match) => match.index);
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${objects}xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${objects.length}\n%%EOF\n`, "latin1");
}

test("every page the skill renders is its crop box, the area a citation's percents are of, not the whole sheet", async () => {
  const commands = [...SKILL.matchAll(/pdftoppm [^"`]*?\.look\/[\w/]+/g)].map((match) => match[0]);
  assert.equal(commands.length, 4, "the three page renders and the region");
  // Half-inch margins cropped from a 612 x 792 point page leave 540 x 720.
  fs.writeFileSync(path.join(cwd, "cropped.pdf"), withCropBox(pdfBytes(Array.from({ length: 3 }, (_, i) => ({ lines: [`Invented page ${i + 1}`] }))), [36, 36, 576, 756]));
  assert.equal(execFileSync("pdfinfo", ["-box", path.join(cwd, "cropped.pdf")], { encoding: "utf8" }).match(/CropBox:\s+([\d. ]+)/)[1].trim().split(/\s+/).map(Number).join(), "36,36,576,756");
  for (const command of commands) {
    assert.match(command, /-cropbox /);
    await run(`rm -rf .look && mkdir -p .look/pages && ${command.replace("report.pdf", "cropped.pdf").replace(/-f 3 -l 3/, "-f 2 -l 2")}`);
    const dpi = Number(command.match(/-r (\d+)/)[1]);
    const [width, height] = [540, 720].map((points) => Math.ceil((points * dpi) / 72));
    const files = execFileSync("find", [".look", "-name", "*.png"], { cwd, encoding: "utf8" }).trim().split("\n");
    assert.ok(files.length >= 1, command);
    for (const file of files) {
      const size = imageHeader(fs.readFileSync(path.join(cwd, file)));
      if (command.includes(" -W ")) assert.deepEqual([size.width, size.height], [Math.min(1275, width - 1275), 825], `${command}: the region, cut from the crop box`);
      else assert.ok(Math.abs(size.width - width) <= 1 && Math.abs(size.height - height) <= 1, `${command}: ${size.width}x${size.height}, not the crop box's ${width}x${height}`);
    }
  }
});
