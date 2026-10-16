// `vision.judge` as an agent's code calls it: a host's code-mode tool on a real pi-durable Harness runs the script with
// the handle's globals, and a fake Jev port in the shape `createJevRunner` returns answers. All four question types with the images in the
// state; example images by reference in criteria; every image Jev gets within its limits; a box mapped back to its
// image's fragment; typed misses; the same judgment again read back; a run killed between two judgments pays for each
// once. Every file is built by the test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { fitImage, imageHeader } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { pngBytes } from "@parcha/pi-vision/testing";
import { codeTool } from "./durable/code-tool.mjs";
import { drive, textOf, tmp } from "./durable/rig.mjs";
import { fakeJev, USD_PER_MTOK } from "./support/jev.mjs";

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

test("one request through the port answers all four question types about the images in the state, priced by the port, filed and told once", async () => {
  const cwd = workspace({ "p1.png": pngBytes(800, 600), "p2.png": pngBytes(800, 600) });
  const rows = host();
  const jev = fakeJev();
  const vision = createVisionExtension({ jev: { judge: jev.judge }, ...rows.options });
  const seen = await ran(vision, cwd, `return await vision.judge({ paths: ["p1.png", "p2.png"], fragments: ["r.pdf#page=1", "r.pdf#page=2"], state: { note: "two pages" }, questions: ${JSON.stringify(QUESTIONS)} });`);
  assert.equal(seen.ok, true, seen.error);
  assert.equal(jev.requests.length, 1);
  const [{ params }] = jev.requests;
  assert.deepEqual([params.label, params.kind, params.model, params.signal instanceof AbortSignal], ["vision.judge", "judge", "jev-1.14.0", true], "the caller names the model, Box's");
  assert.deepEqual([params.state.note, params.state.images], ["two pages", [{ source: "r.pdf#page=1", image: "<vision.judge image 1>" }, { source: "r.pdf#page=2", image: "<vision.judge image 2>" }]], "the images in the state by reference, named by their fragments, beside the script's own fields");
  assert.deepEqual(Object.entries(params.assets).map(([ref, a]) => [ref, a.mime, a.bytes instanceof Uint8Array]), [["<vision.judge image 1>", "image/png", true], ["<vision.judge image 2>", "image/png", true]], "plain bytes and their type; the port builds what it sends");
  assert.deepEqual(params.questions.logo, { type: "box", instructions: "the logo in `images[1].image`" }, "the image index stays with pi-vision");
  const { answers, model, costUsd, receipts, kept } = seen.value;
  assert.deepEqual([answers.kind.choice, answers.blank.noul, answers.legible.score, answers.logo.confidence], ["chart", 0.8, 1, 0.9]);
  assert.equal(answers.logo.fragment, "r.pdf#page=2&xywh=percent:50,25,50,50", "the box as a region of the page it was found on");
  assert.deepEqual([model, costUsd, receipts, kept], ["jev-1.14.0", (2000 * USD_PER_MTOK) / 1e6, ["evidence/judge/1.md"], undefined], "the port's price, as it gave it");
  assert.deepEqual(rows.looks.map((l) => [l.tool, l.source, l.costUsd, l.kept]), [["vision.judge", "r.pdf#page=1, r.pdf#page=2", costUsd, undefined]]);
  assert.deepEqual([rows.filed[0].status, rows.filed[0].args.via, rows.filed[0].facts.tokens_in, JSON.parse(rows.filed[0].body).blank.noul], ["ok", "jev", 2000, 0.8]);
  assert.deepEqual(JSON.parse(rows.filed[0].args.ask), QUESTIONS, "the receipt holds the questions as asked, each box's image index included");
  assert.equal(JSON.parse(rows.filed[0].body).logo.fragment, answers.logo.fragment, "and the box's region, so it stands on its own");
});

test("examples go to Jev by the reference the questions write; the same judgment again in the call is read back", async () => {
  const cwd = workspace({ "frame.png": pngBytes(640, 480), "chart.png": pngBytes(400, 300), "other.png": pngBytes(400, 320) });
  const rows = host();
  const jev = fakeJev();
  const vision = createVisionExtension({ jev: { judge: jev.judge }, ...rows.options });
  const ask = `{ paths: ["frame.png"], examples: { "<chart>": "chart.png" }, questions: { kind: { type: "choice", instructions: "Which is \`images[0].image\`?", criteria: { chart: "<chart>", other: "Anything else." } } } }`;
  const seen = await ran(vision, cwd, `const a = await vision.judge(${ask}); const b = await vision.judge(${ask}); const c = await vision.judge(${ask.replace("chart.png", "other.png")}); return [a, b];`);
  assert.equal(seen.ok, true, seen.error);
  assert.equal(jev.requests.length, 2, "the same judgment asked once; the one with another example image asked again");
  assert.equal(imageHeader(jev.requests[1].params.assets["<chart>"].bytes).height, 320);
  assert.deepEqual(Object.keys(jev.requests[0].params.assets), ["<vision.judge image 1>", "<chart>"]);
  assert.deepEqual(imageHeader(jev.requests[0].params.assets["<chart>"].bytes), { mimeType: "image/png", width: 400, height: 300, orientation: 1 });
  assert.deepEqual(seen.value.map((r) => [r.answers.kind.choice, r.kept]), [["chart", undefined], ["chart", true]]);
  assert.deepEqual(rows.looks.map((l) => l.kept), [undefined, true, undefined], "told again as kept, not charged; the changed example paid");
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
  const vision = createVisionExtension({ jev: { judge: jev.judge }, ...host().options });
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

test("a processor that only fits images to their largest size is held to Jev's other limits, and baseline holds without formats", async () => {
  const cwd = workspace({ "small.png": pngBytes(200, 100) });
  const prepareOnly = { prepare: async (bytes, mimeType) => ({ data: Buffer.from(bytes).toString("base64"), mimeType }) };
  const seen = await ran(createVisionExtension({ images: prepareOnly, jev: { judge: fakeJev().judge }, ...host().options }), cwd, `try { await vision.judge({ paths: ["small.png"], questions: { q: { type: "noul", instructions: "Is it blank?" } } }); } catch (error) { return error.message; }`);
  assert.match(seen.value, /^needs: small\.png: .*growing one, re-encoding its format or making a JPEG baseline needs Photon or sharp$/);
  const progressive = await sharp(Buffer.from(pngBytes(800, 600))).jpeg({ progressive: true }).toBuffer();
  const fit = await fitImage(sharpImages(sharp), progressive, "image/jpeg", { maxWidth: 2000, maxHeight: 2000, maxBytes: 10_000_000, baseline: true });
  assert.equal(fit.fit, "resized");
  assert.equal(imageHeader(Buffer.from(fit.blocks[0].data, "base64")).progressive, undefined, "re-encoded baseline though no formats were named");
});

test("a tall image cut into tiles has every tile held to the minimum edge", async () => {
  const fit = await fitImage(sharpImages(sharp), pngBytes(200, 10000), "image/png", { maxWidth: 1568, maxHeight: 1568, maxBytes: 10_000_000, minEdge: 280 });
  assert.equal(fit.fit, "tiled");
  assert.ok(fit.blocks.length > 1, `${fit.blocks.length} tiles`);
  assert.deepEqual([...new Set(fit.blocks.map((b) => b.width))], [280], "each 200 px wide tile padded to 280 at its right");
  assert.ok(fit.blocks.every((b) => b.height >= 280 && b.height <= 1568), JSON.stringify(fit.blocks.map((b) => b.height)));
  assert.equal(fit.tile.width, 200, "the tile's own pixels are what the fit says it shows");
});

test("a price the port does not know is filed as unknown, never as $0", async () => {
  const cwd = workspace({ "p1.png": pngBytes(400, 300) });
  const rows = host();
  const seen = await ran(createVisionExtension({ jev: { judge: fakeJev({ priced: false }).judge }, ...rows.options }), cwd, `return await vision.judge({ paths: ["p1.png"], questions: { q: { type: "noul", instructions: "Is it blank?" } } });`);
  assert.equal(seen.value.costUsd, null);
  assert.deepEqual([rows.filed[0].facts.cost_usd, rows.filed[0].facts.tokens_in, rows.looks[0].costUsd], [null, 1000, null]);
});

test("a look that cannot be made throws with its code and is filed and told: no Jev, a video, a refused request, one over the size, a box the model cannot answer", async () => {
  const cwd = workspace({ "p1.png": pngBytes(400, 300), "clip.mp4": Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]) });
  const asks = `const out = []; for (const request of input) { try { await vision.judge(request); out.push("judged"); } catch (error) { out.push(error.message); } } return out;`;
  const noul = { q: { type: "noul", instructions: "Is it a chart?" } };
  const none = host();
  const [noJev] = (await ran(createVisionExtension(none.options), cwd, `const input = [${JSON.stringify({ paths: ["p1.png"], questions: noul })}]; ${asks}`)).value;
  assert.equal(noJev, "no_vision_route: this host gives vision.judge no Jev port");
  const rows = host();
  const refused = Object.assign(new Error("400 Bad Request: an image was rejected"), { status: 400 });
  const tooBig = Object.assign(new Error("413 Payload Too Large"), { status: 413 });
  // The port refuses a box of a model that has none before any request, as `JevError` with this diagnostic.
  const noBox = Object.assign(new Error("A Box question needs a model that answers it. No request was sent."), { code: "invalid_request", requestDiagnostic: { reason: "unsupported_model" } });
  const judged = (jev, request) => ran(createVisionExtension({ jev, ...rows.options }), cwd, `const input = [${JSON.stringify(request)}]; ${asks}`).then((r) => r.value[0]);
  const video = await judged({ judge: fakeJev().judge }, { paths: ["clip.mp4"], questions: noul });
  const bad = await judged({ judge: fakeJev({ fail: refused }).judge }, { paths: ["p1.png"], questions: noul });
  const big = await judged({ judge: fakeJev({ fail: tooBig }).judge }, { paths: ["p1.png"], questions: noul });
  const box = await judged({ judge: fakeJev({ fail: noBox }).judge, model: "jev-latest" }, { paths: ["p1.png"], questions: { where: { type: "box", instructions: "the logo" } } });
  assert.match(video, /^unsupported: clip\.mp4 is a video; Jev takes still images/);
  assert.equal(bad, "look_failed: Jev failed: 400 Bad Request: an image was rejected");
  assert.equal(big, "over_budget: Jev failed: 413 Payload Too Large");
  assert.equal(box, "unsupported: Jev failed: A Box question needs a model that answers it. No request was sent.");
  assert.deepEqual([...none.misses, ...rows.misses].map((m) => [m.tool, m.code]), [["vision.judge", "no_vision_route"], ["vision.judge", "unsupported"], ["vision.judge", "look_failed"], ["vision.judge", "over_budget"], ["vision.judge", "unsupported"]]);
  assert.deepEqual(rows.filed.map((r) => [r.status, r.facts.cost_usd]), [["failed", 0], ["failed", undefined], ["failed", undefined], ["failed", 0]], "a miss before the request cost nothing, a box refused before any request too; a request that threw has no known price");
});

// The kill: judge-child.mjs is one process of a run whose script asks two judgments, one image each.
const CHILD = path.join(import.meta.dirname, "durable", "judge-child.mjs");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const DEADLINE_MS = 60_000;
const within = (promise, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} within ${DEADLINE_MS} ms`)), DEADLINE_MS); })]).finally(() => clearTimeout(timer));
};
/** One run, cut by a SIGKILL at the second judgment when `cut`; every child is killed when the test ends, however it
 *  ends. */
async function run(t, cut, replay = "safe") {
  const dir = tmp("vision-judge-kill-");
  const paths = { DB: path.join(dir, "run.sqlite"), CWD: path.join(dir, "work"), OUT: path.join(dir, "out"), LEDGER: path.join(dir, "jev.jsonl") };
  fs.mkdirSync(paths.CWD); fs.mkdirSync(paths.OUT);
  fs.writeFileSync(path.join(paths.CWD, "p1.png"), pngBytes(400, 300));
  fs.writeFileSync(path.join(paths.CWD, "p2.png"), pngBytes(500, 300));
  const child = (mode) => {
    const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...paths, MODE: mode, REPLAY: replay }, stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); });
    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    return { proc, exit: new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, line: stdout.split("\n").find((l) => l.startsWith("RESULT ")) }))) };
  };
  if (cut) {
    const first = child("first");
    for (let waited = 0; !fs.existsSync(path.join(paths.CWD, ".cut")); waited += 20) {
      assert.ok(waited < DEADLINE_MS, "the first process never reached the second judgment");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    first.proc.kill("SIGKILL");
    assert.deepEqual(await within(first.exit, "the first process exits"), { code: null, signal: "SIGKILL", line: undefined });
  }
  const { line } = await within(child("second").exit, "the second process prints its result");
  assert.ok(line, "the second process printed its result");
  return { ...JSON.parse(line.slice("RESULT ".length)), asks: lines(paths.LEDGER).length, told: lines(path.join(paths.OUT, "looks.jsonl")) };
}
const values = (call) => JSON.parse(call.content[0].text).value;

test("killed between two judgments, the rerun asks only the second and tells the first as kept; the script gets the same answers, the first marked kept", async (t) => {
  const clean = await run(t, false);
  const keys = clean.told.map((look) => look.key);
  assert.deepEqual([clean.settled, clean.asks, new Set(keys).size], ["done", 2, 2]);
  const cut = await run(t, true);
  assert.equal(cut.settled, "done");
  assert.deepEqual(values(cut.results[0]).map((v) => v.kept), [true, undefined], "the first judgment read back, the second asked");
  assert.deepEqual(values(cut.results[0]).map(({ kept: _kept, ...v }) => v), values(clean.results[0]), "and otherwise what an uncut run returns");
  assert.equal(cut.asks, 2, "Jev was asked once per judgment in all");
  assert.deepEqual(cut.told.map((look) => [look.by, look.key, look.kept]), [["first", keys[0], false], ["second", keys[0], true], ["second", keys[1], false]]);
});

test("killed between two judgments on a host that never reruns a cut call, the next call reads the first back and asks only the second", async (t) => {
  const cut = await run(t, true, "unsafe");
  assert.equal(cut.settled, "done");
  const calls = cut.results.filter((r) => r.tool === "code");
  assert.equal(calls.length, 2, "the cut call stays cut, and the lead called the tool again");
  assert.deepEqual(values(calls.at(-1)).map((v) => v.kept), [true, undefined], "the first judgment read back, the second asked");
  assert.equal(cut.asks, 2, "Jev was asked once per judgment in all");
  const [first, ...rest] = cut.told;
  assert.deepEqual([[first.by, first.kept], ...rest.map((look) => [look.by, look.key === first.key, look.kept])], [["first", false], ["second", true, true], ["second", false, false]],
    "the first judgment told paid, then again as kept; the second, never answered before the cut, told paid once");
});
