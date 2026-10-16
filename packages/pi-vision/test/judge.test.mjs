// `vision.judge` as an agent's code calls it: a host's code-mode tool on a real pi-durable Harness runs the script with
// the handle's globals, and a fake Jev in the SDK's shape answers. All four question types with the images in the
// state; example images by reference in criteria; every image Jev gets within its limits; a box mapped back to its
// image's fragment; typed misses; the same judgment again read back; a run killed between two judgments pays for each
// once. Every file is built by the test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { imageHeader, JEV_USD_PER_MTOK } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { pngBytes } from "@parcha/pi-vision/testing";
import { codeTool } from "./durable/code-tool.mjs";
import { drive, textOf, tmp } from "./durable/rig.mjs";
import { fakeJev } from "./support/jev.mjs";

const workspace = (files) => {
  const dir = tmp("vision-judge-");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};
const host = () => {
  const filed = [], looks = [], misses = [];
  return {
    filed, looks, misses,
    options: { evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}.md` }; } }, onLook: (look) => looks.push(look), onMiss: (miss) => misses.push(miss), scope: () => ({ label: "judge", deriveDir: ".vision" }) },
  };
};
const ran = async (vision, cwd, code) => JSON.parse(textOf((await drive({ extensions: [codeTool(vision), vision.extension], rounds: [[["code", { code }]]], cwd })).results[0]));
const QUESTIONS = {
  kind: { type: "choice", instructions: "What does `images[0].image` show?", criteria: { chart: "A chart.", text: "Text only." } },
  blank: { type: "noul", instructions: "Is `images[1].image` blank?" },
  legible: { type: "score", instructions: "How legible is `images[0].image`?", criteria: ["unreadable", "readable", "crisp"] },
  logo: { type: "box", instructions: "the logo in `images[1].image`", image: 1 },
};

test("one request answers all four question types about the images in the state, with the images header, priced from its tokens, filed and told once", async () => {
  const cwd = workspace({ "p1.png": pngBytes(800, 600), "p2.png": pngBytes(800, 600) });
  const rows = host();
  const jev = fakeJev();
  const vision = createVisionExtension({ jev, ...rows.options });
  const seen = await ran(vision, cwd, `return await vision.judge({ paths: ["p1.png", "p2.png"], fragments: ["r.pdf#page=1", "r.pdf#page=2"], state: { note: "two pages" }, questions: ${JSON.stringify(QUESTIONS)} });`);
  assert.equal(seen.ok, true, seen.error);
  assert.equal(jev.requests.length, 1);
  const [{ request, options }] = jev.requests;
  assert.deepEqual([request.model, options.headers], ["jev-1.14.0", { "TypeSafe-Danger-Zone-Images": "true" }]);
  assert.deepEqual([request.state.note, request.state.images.map((i) => i.source)], ["two pages", ["r.pdf#page=1", "r.pdf#page=2"]], "the images in the state, named by their fragments, beside the script's own fields");
  assert.deepEqual(request.questions.logo, { type: "box", instructions: "the logo in `images[1].image`" }, "the image index stays with pi-vision");
  assert.equal(request.assets, undefined);
  const { answers, model, costUsd, receipts, kept } = seen.value;
  assert.deepEqual([answers.kind.choice, answers.blank.noul, answers.legible.score, answers.logo.confidence], ["chart", 0.8, 1, 0.9]);
  assert.equal(answers.logo.fragment, "r.pdf#page=2&xywh=percent:50,25,50,50", "the box as a region of the page it was found on");
  assert.deepEqual([model, costUsd, receipts, kept], ["jev-1.14.0", (2000 * JEV_USD_PER_MTOK) / 1e6, ["evidence/judge/1.md"], undefined]);
  assert.deepEqual(rows.looks.map((l) => [l.tool, l.source, l.costUsd, l.kept]), [["vision.judge", "r.pdf#page=1, r.pdf#page=2", costUsd, undefined]]);
  assert.deepEqual([rows.filed[0].status, rows.filed[0].args.via, rows.filed[0].facts.tokens_in, JSON.parse(rows.filed[0].body).blank.noul], ["ok", "jev", 2000, 0.8]);
});

test("examples go to Jev by the reference the questions write; the same judgment again in the call is read back", async () => {
  const cwd = workspace({ "frame.png": pngBytes(640, 480), "chart.png": pngBytes(400, 300) });
  const rows = host();
  const jev = fakeJev();
  const vision = createVisionExtension({ jev, ...rows.options });
  const ask = `{ paths: ["frame.png"], examples: { "<chart>": "chart.png" }, questions: { kind: { type: "choice", instructions: "Which is \`images[0].image\`?", criteria: { chart: "<chart>", other: "Anything else." } } } }`;
  const seen = await ran(vision, cwd, `const a = await vision.judge(${ask}); const b = await vision.judge(${ask}); return [a, b];`);
  assert.equal(seen.ok, true, seen.error);
  assert.equal(jev.requests.length, 1, "asked once");
  assert.deepEqual(Object.keys(jev.requests[0].request.assets), ["<chart>"]);
  assert.deepEqual(imageHeader(jev.requests[0].request.assets["<chart>"].bytes), { mimeType: "image/png", width: 400, height: 300, orientation: 1 });
  assert.deepEqual(seen.value.map((r) => [r.answers.kind.choice, r.kept]), [["chart", undefined], ["chart", true]]);
  assert.deepEqual(rows.looks.map((l) => l.kept), [undefined, true], "told again as kept, not charged");
  const unnamed = await ran(vision, cwd, `try { await vision.judge({ paths: ["frame.png"], examples: { "<dog>": "chart.png" }, questions: { q: { type: "noul", instructions: "Is it a chart?" } } }); } catch (error) { return error.message; }`);
  assert.match(unnamed.value, /^vision\.judge takes \{ questions/, "an example no question names is refused before anything is sent");
});

test("every image Jev gets is within its limits: shrunk, grown, padded, re-encoded, made baseline and upright; a box maps back through the fit and the crop", async () => {
  const raw = (w, h) => sharp(Buffer.from(pngBytes(w, h)));
  const files = {
    "big.png": pngBytes(3000, 2000),
    "small.png": pngBytes(200, 100),
    "strip.png": pngBytes(2000, 60),
    "photo.webp": await raw(600, 400).webp().toBuffer(),
    "progressive.jpg": await raw(800, 600).jpeg({ progressive: true }).toBuffer(),
    "turned.jpg": await raw(800, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer(),
  };
  assert.equal(imageHeader(files["progressive.jpg"]).progressive, true);
  const cwd = workspace(files);
  const jev = fakeJev();
  const vision = createVisionExtension({ jev, ...host().options });
  const paths = Object.keys(files);
  const fragments = paths.map((p) => (p === "small.png" ? "scan.png#xywh=percent:50,0,50,50" : p));
  const seen = await ran(vision, cwd, `return await vision.judge({ paths: ${JSON.stringify(paths)}, fragments: ${JSON.stringify(fragments)}, questions: { where: { type: "box", instructions: "the mark in \`images[1].image\`", image: 1 }, strip: { type: "box", instructions: "the mark in \`images[2].image\`", image: 2 } } });`);
  assert.equal(seen.ok, true, seen.error);
  const sizes = jev.requests[0].sizes;
  for (const size of sizes) {
    assert.ok(["image/png", "image/jpeg"].includes(size.mimeType) && !size.progressive && size.orientation === 1, JSON.stringify(size));
    assert.ok(size.width >= 280 && size.height >= 280 && size.width <= 1568 && size.height <= 1568, JSON.stringify(size));
  }
  assert.deepEqual(sizes.map((s) => [s.width, s.height]), [[1568, 1045], [560, 280], [1568, 280], [600, 400], [800, 600], [400, 800]], "shrunk, grown, padded, re-encoded, baseline, upright");
  // The small image was grown whole, so the box's fractions are its own; the image is the right half of the top half of scan.png.
  assert.equal(seen.value.answers.where.fragment, "scan.png#xywh=percent:75,12.5,25,25");
  // The strip could not grow: its 1568x47 pixels are at the top left of a 1568x280 block, and the fake's box (0.25 to
  // 0.75 of the block's height) lies wholly in the padding below them.
  assert.equal(seen.value.answers.strip.fragment, undefined, "a box wholly in the padding names no region");
});

test("a look that cannot be made throws with its code and is filed and told: no Jev, a video, a refused request, one over the size", async () => {
  const cwd = workspace({ "p1.png": pngBytes(400, 300), "clip.mp4": Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]) });
  const asks = `const out = []; for (const request of input) { try { await vision.judge(request); out.push("judged"); } catch (error) { out.push(error.message); } } return out;`;
  const noul = { q: { type: "noul", instructions: "Is it a chart?" } };
  const none = host();
  const [noJev] = (await ran(createVisionExtension(none.options), cwd, `const input = [${JSON.stringify({ paths: ["p1.png"], questions: noul })}]; ${asks}`)).value;
  assert.equal(noJev, "no_vision_route: this host gives vision.judge no Jev client");
  const rows = host();
  const refused = Object.assign(new Error("400 Bad Request: an image was rejected"), { status: 400 });
  const tooBig = Object.assign(new Error("413 Payload Too Large"), { status: 413 });
  const [video] = (await ran(createVisionExtension({ jev: fakeJev(), ...rows.options }), cwd, `const input = [${JSON.stringify({ paths: ["clip.mp4"], questions: noul })}]; ${asks}`)).value;
  const [bad] = (await ran(createVisionExtension({ jev: fakeJev({ fail: refused }), ...rows.options }), cwd, `const input = [${JSON.stringify({ paths: ["p1.png"], questions: noul })}]; ${asks}`)).value;
  const [big] = (await ran(createVisionExtension({ jev: fakeJev({ fail: tooBig }), ...rows.options }), cwd, `const input = [${JSON.stringify({ paths: ["p1.png"], questions: noul })}]; ${asks}`)).value;
  assert.match(video, /^unsupported: clip\.mp4 is a video; Jev takes still images/);
  assert.equal(bad, "look_failed: Jev failed: 400 Bad Request: an image was rejected");
  assert.equal(big, "over_budget: Jev failed: 413 Payload Too Large");
  assert.deepEqual([...none.misses, ...rows.misses].map((m) => [m.tool, m.code]), [["vision.judge", "no_vision_route"], ["vision.judge", "unsupported"], ["vision.judge", "look_failed"], ["vision.judge", "over_budget"]]);
  assert.deepEqual(rows.filed.map((r) => [r.status, r.facts.cost_usd]), [["failed", 0], ["failed", undefined], ["failed", undefined]], "a miss before the request cost nothing; a request that threw has no known price");
});

// The kill: judge-child.mjs is one process of a run whose script asks two judgments, one image each.
const CHILD = path.join(import.meta.dirname, "durable", "judge-child.mjs");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
function child(paths, mode) {
  const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...paths, MODE: mode }, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk; });
  const exit = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, line: stdout.split("\n").find((l) => l.startsWith("RESULT ")) })));
  return { proc, exit, result: exit.then(({ line }) => (line === undefined ? undefined : JSON.parse(line.slice("RESULT ".length)))) };
}
async function run(cut) {
  const dir = tmp("vision-judge-kill-");
  const paths = { DB: path.join(dir, "run.sqlite"), CWD: path.join(dir, "work"), OUT: path.join(dir, "out"), LEDGER: path.join(dir, "jev.jsonl") };
  fs.mkdirSync(paths.CWD); fs.mkdirSync(paths.OUT);
  fs.writeFileSync(path.join(paths.CWD, "p1.png"), pngBytes(400, 300));
  fs.writeFileSync(path.join(paths.CWD, "p2.png"), pngBytes(500, 300));
  if (cut) {
    const first = child(paths, "first");
    for (let waited = 0; !fs.existsSync(path.join(paths.CWD, ".cut")); waited += 20) {
      assert.ok(waited < 60_000, "the first process never reached the second judgment");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    first.proc.kill("SIGKILL");
    assert.deepEqual(await first.exit, { code: null, signal: "SIGKILL", line: undefined });
  }
  const second = await child(paths, "second").result;
  return { ...second, asks: lines(paths.LEDGER).length, told: lines(path.join(paths.OUT, "looks.jsonl")) };
}

test("killed between two judgments, the rerun asks only the second and tells the first as kept; the script gets the same answers, the first marked kept", async () => {
  const clean = await run(false);
  const keys = clean.told.map((look) => look.key);
  assert.deepEqual([clean.settled, clean.asks, new Set(keys).size], ["done", 2, 2]);
  const cut = await run(true);
  assert.equal(cut.settled, "done");
  const values = (outcome) => JSON.parse(outcome.results[0].content[0].text).value;
  assert.deepEqual(values(cut).map((v) => v.kept), [true, undefined], "the first judgment read back, the second asked");
  assert.deepEqual(values(cut).map(({ kept: _kept, ...v }) => v), values(clean), "and otherwise what an uncut run returns");
  assert.equal(cut.asks, 2, "Jev was asked once per judgment in all");
  assert.deepEqual(cut.told.map((look) => [look.by, look.key, look.kept]), [["first", keys[0], false], ["second", keys[0], true], ["second", keys[1], false]]);
});
