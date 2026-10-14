// The look skill's examples run as written: each ```js block of skills/look/SKILL.md runs in pi-codemode's sandbox with a
// `bash` tool over a workspace the test builds and the handle's `vision.see`, and fake eyes answer with the fragments
// they were shown. Needs pdftoppm, ffmpeg and ffprobe: `npm run test:binaries` runs it, `npm test` does not.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { imageHeader } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fakeEyes, fixtureDir, pdfBytes, pngBytes } from "@parcha/pi-vision/testing";

const SKILL = fs.readFileSync(new URL("../../skills/look/SKILL.md", import.meta.url), "utf8");
const [pdfPages, longVideo, manyImages, region, ...more] = [...SKILL.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);

const dir = await fixtureDir("pi-vision-see-skill-");
after(() => dir.remove());
const cwd = dir.path;
await dir.file("report.pdf", pdfBytes(Array.from({ length: 12 }, (_, i) => ({ lines: [`Invented report for a test, page ${i + 1}`, `Invoice INV-${1000 + i}, total ${(i + 1) * 10}.00`] }))));
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=35:size=320x240:rate=5", "-pix_fmt", "yuv420p", path.join(cwd, "talk.mp4")]);
fs.mkdirSync(path.join(cwd, "photos"));
for (const name of ["attic.png", "hall.png", "roof.png"]) fs.writeFileSync(path.join(cwd, "photos", name), pngBytes(64, 48));
fs.writeFileSync(path.join(cwd, "photos", "notes.txt"), "not a photo");
fs.writeFileSync(path.join(cwd, "scan.png"), pngBytes(800, 1000));

/** A bash tool as a host's code mode gives one: the command's output, or a rejection with it. */
const bash = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(`${stdout}${stderr}`)))) };
/** Runs one example: what it returned, every request the eyes saw, and the looks the host was told of. */
async function example(code) {
  const eyes = fakeEyes({ answers: [(request) => `saw ${request.parts.filter((p) => p.type === "image").map((p) => p.fragment).join(", ")}`] });
  const looks = [];
  const vision = createVisionExtension({ eyes, evidence: { file: async (label) => ({ path: `evidence/${label}/${looks.length + 1}.md` }) }, scope: () => ({ label: "skill", deriveDir: ".vision" }), onLook: (look) => looks.push(look) });
  const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(nodeVisionEnv({ cwd }), { conversationId: "skill", callId: "1", model: undefined, signal: undefined })] });
  try {
    const run = await sandbox.execute(code);
    assert.ok(run.ok, run.ok ? "" : run.error.message);
    return { value: run.value, requests: eyes.ledger.map((r) => r.parts.filter((p) => p.type === "image").map((p) => p.fragment)), looks };
  } finally { await sandbox.close(); }
}

test("the skill holds the four examples this test runs, and nothing more", () => {
  assert.deepEqual([pdfPages, longVideo, manyImages, region].map((code) => typeof code), ["string", "string", "string", "string"]);
  assert.deepEqual(more, []);
});

test("many PDF pages: rendered, asked in batches of ten, each page cited by its number", async () => {
  const { value, requests, looks } = await example(pdfPages);
  const pages = Array.from({ length: 12 }, (_, i) => `report.pdf#page=${i + 1}`);
  assert.deepEqual(requests.flat(), pages, "every page once, in order, named by its page");
  assert.deepEqual(requests.map((r) => r.length), [8, 2, 2], "a batch of ten is two requests within eight images; the last batch one");
  assert.match(value, /^\(report\.pdf#page=1, .* report\.pdf#page=8; look filed at evidence\/skill\/1\.md\)\nsaw report\.pdf#page=1, /);
  assert.match(value, /\(receipt: evidence\/skill\/3\.md\)$/);
  assert.equal(looks.length, 3);
});

test("a long video: a frame every ten seconds by seek, each cited by its time; run again on a shorter video, no frame of the first", async () => {
  const { value, requests } = await example(longVideo);
  assert.deepEqual(requests.flat(), ["talk.mp4#t=0", "talk.mp4#t=10", "talk.mp4#t=20", "talk.mp4#t=30"]);
  const frames = path.join(cwd, ".look", "frames");
  assert.ok(fs.readdirSync(frames).every((name) => imageHeader(fs.readFileSync(path.join(frames, name)))?.width === 320));
  assert.match(value, /^saw talk\.mp4#t=0, talk\.mp4#t=10, talk\.mp4#t=20, talk\.mp4#t=30\n\(receipt: evidence\/skill\/1\.md, \$\d/);
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
