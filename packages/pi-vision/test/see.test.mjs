// `vision.see` as an agent's code calls it: a host's code-mode tool on a real pi-durable Harness runs the script in
// pi-codemode's sandbox with the handle's global, and fake eyes answer. Images given as blocks and as paths, packed into
// requests within the eyes' limits, each request filed and told once; a look that cannot be made thrown with its code;
// and a run killed between two requests, which pays for each look and tells the host of it once. Every file is built
// by the test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_LIMITS, SeeMiss, VISION_SEE } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fakeEyes, pdfBytes, pngBytes } from "@parcha/pi-vision/testing";
import { drive, textOf, tmp } from "./durable/rig.mjs";
import { codeTool } from "./durable/code-tool.mjs";

const png = (width, height) => ({ type: "image", data: Buffer.from(pngBytes(width, height)).toString("base64"), mimeType: "image/png" });
const workspace = (files) => {
  const dir = tmp("vision-see-");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};
/** The host's sink and rows, each call kept. */
const host = () => {
  const filed = [], looks = [], misses = [];
  return {
    filed, looks, misses,
    options: { evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}.md` }; } }, onLook: (look) => looks.push(look), onMiss: (miss) => misses.push(miss), scope: () => ({ label: "see", deriveDir: ".vision" }) },
  };
};
/** Eyes that name the fragments of the images they were shown, two images a request. */
const twoAtATime = (more = {}) => fakeEyes({ limits: { ...DEFAULT_LIMITS, imagesPerCall: 2 }, answers: [(request) => `saw ${request.parts.filter((p) => p.type === "image").map((p) => p.fragment).join(" and ")}`], ...more });
/** What the script returned, or the sandbox's error. */
const ran = async (vision, cwd, code) => {
  const { results } = await drive({ extensions: [codeTool(vision), vision.extension], rounds: [[["code", { code }]]], cwd });
  return JSON.parse(textOf(results[0]));
};

test("a script sees image blocks and files together, packed two a request, and gets one text with each part's fragments, the price and the receipts", async () => {
  const cwd = workspace({ "p1.png": pngBytes(40, 30), "p2.png": pngBytes(50, 30), "p3.png": pngBytes(60, 30) });
  const rows = host();
  const eyes = twoAtATime();
  const vision = createVisionExtension({ eyes, ...rows.options });
  const shot = png(30, 30);
  const seen = await ran(vision, cwd, `return await vision.see({ ask: "What does each page say?", images: [${JSON.stringify(shot)}], paths: ["p1.png", "p2.png", "p3.png"], fragments: ["shot.png", "r.pdf#page=1", "r.pdf#page=2", "r.pdf#page=3"] });`);
  assert.equal(seen.ok, true);
  assert.deepEqual(eyes.ledger.map((r) => r.parts.map((p) => [p.type, p.fragment])), [
    [["text", "shot.png"], ["image", "shot.png"], ["text", "r.pdf#page=1"], ["image", "r.pdf#page=1"]],
    [["text", "r.pdf#page=2"], ["image", "r.pdf#page=2"], ["text", "r.pdf#page=3"], ["image", "r.pdf#page=3"]],
  ], "each image beside the line that names it, two a request, in order");
  assert.ok(eyes.ledger.every((r) => r.ask === "What does each page say?"));
  const { text, model, costUsd, receipts, kept } = seen.value;
  assert.equal(text, "(shot.png, r.pdf#page=1; look filed at evidence/see/1.md)\nsaw shot.png and r.pdf#page=1\n\n(r.pdf#page=2, r.pdf#page=3; look filed at evidence/see/2.md)\nsaw r.pdf#page=2 and r.pdf#page=3");
  assert.deepEqual([model, receipts, kept], ["fake-eyes", ["evidence/see/1.md", "evidence/see/2.md"], undefined], "one receipt a request, in order");
  assert.equal(costUsd, rows.looks.reduce((sum, look) => sum + look.costUsd, 0));
  assert.ok(costUsd > 0);
  assert.deepEqual(rows.looks.map((look) => [look.tool, look.source, look.kept]), [["vision.see", "shot.png, r.pdf#page=1", undefined], ["vision.see", "r.pdf#page=2, r.pdf#page=3", undefined]], "the host is told of each request once");
  assert.deepEqual(rows.filed.map((r) => [r.status, r.facts.kind, r.facts.shown_blocks, typeof r.facts.cost_usd]), [["ok", "image", 2, "number"], ["ok", "image", 2, "number"]], "a record per request, with its price");
});

test("one request's answer comes back as it is; the same images and question again in the call are read back, not asked", async () => {
  const cwd = workspace({ "p1.png": pngBytes(40, 30) });
  const rows = host();
  const eyes = twoAtATime();
  const vision = createVisionExtension({ eyes, ...rows.options });
  const seen = await ran(vision, cwd, `const a = await vision.see({ ask: "what?", paths: ["p1.png"] }); const b = await vision.see({ ask: "what?", paths: ["p1.png"] }); return [a, b];`);
  const [first, again] = seen.value;
  assert.deepEqual([first.text, first.kept, again.text, again.kept], ["saw p1.png", undefined, "saw p1.png", true]);
  assert.equal(again.costUsd, first.costUsd, "the answer's price, paid once");
  assert.equal(eyes.ledger.length, 1);
  assert.deepEqual(rows.looks.map((look) => look.kept), [undefined, true], "the host hears of the second as kept: not charged again");
});

test("the same images named otherwise are another look; the same request twice at once in one call is asked, filed and told once", async () => {
  const rows = host();
  // Each answer takes a moment, so the two requests made at once are both waiting before either is answered.
  const eyes = fakeEyes({ answers: [(request) => ({ text: `saw ${request.parts.filter((p) => p.type === "image").map((p) => p.fragment).join(" and ")}`, delayMs: 300 })] });
  const vision = createVisionExtension({ eyes, ...rows.options });
  const seen = await ran(vision, workspace({}), `const images = ${JSON.stringify([png(20, 20), png(20, 20), png(30, 20)])};
    const relabeled = [await vision.see({ ask: "what?", images, fragments: ["A", "A", "B"] }), await vision.see({ ask: "what?", images, fragments: ["A", "B", "B"] })];
    const together = await Promise.all([vision.see({ ask: "who?", images }), vision.see({ ask: "who?", images })]);
    return { relabeled, together };`);
  const { relabeled, together } = seen.value;
  assert.deepEqual(relabeled.map((r) => [r.text, r.kept]), [["saw A and A and B", undefined], ["saw A and B and B", undefined]], "asked again, and answered for the names they have now");
  assert.deepEqual(together.map((r) => r.text), ["saw image 1 and image 2 and image 3", "saw image 1 and image 2 and image 3"]);
  assert.deepEqual(together.map((r) => r.kept).sort(), [true, undefined], "one waited for the other and asked nothing");
  assert.equal(eyes.ledger.length, 3, "one request for each naming, one for the two at once");
  assert.deepEqual(rows.looks.map((look) => look.kept), [undefined, undefined, undefined], "the host is told of each look once");
});

test("a look that cannot be made throws with its code, filed and told as a miss; a malformed request is a TypeError", async () => {
  const cwd = workspace({ "p1.png": pngBytes(40, 30), "memo.pdf": pdfBytes([{ lines: ["Invented memo for a test"] }]) });
  const script = `const out = []; for (const request of input) { try { await vision.see(request); out.push("seen"); } catch (error) { out.push(error.message); } } return out;`;
  const requests = [{ ask: "what?", paths: ["memo.pdf"] }, { ask: "what?", paths: ["gone.png"] }, { ask: "what?", paths: ["p1.png"] }, { ask: "", paths: ["p1.png"] }];
  const rows = host();
  const failing = createVisionExtension({ eyes: fakeEyes({ answers: [{ fail: "upstream 500" }] }), ...rows.options });
  const seen = await ran(failing, cwd, `const input = ${JSON.stringify(requests)}; ${script}`);
  const [pdf, gone, failed, empty] = seen.value;
  assert.match(pdf, /^unsupported: memo\.pdf reads as pdf, not an image or a video/);
  assert.match(gone, /^unreadable: gone\.png is not a file that opens/);
  assert.equal(failed, "look_failed: the vision route fake-eyes failed: upstream 500");
  assert.match(empty, /^vision\.see takes \{ ask: string/);
  assert.deepEqual(rows.misses.map((m) => [m.tool, m.code]), [["vision.see", "unsupported"], ["vision.see", "unreadable"], ["vision.see", "look_failed"]]);
  assert.deepEqual(rows.filed.map((r) => [r.status, r.facts.cost_usd]), [["failed", 0], ["failed", 0], ["failed", undefined]], "a miss before a request cost nothing; a request that threw has no known price");

  const blind = host();
  const none = await ran(createVisionExtension(blind.options), cwd, `try { await vision.see({ ask: "what?", paths: ["p1.png"] }); } catch (error) { return error.message; }`);
  assert.equal(none.value, "no_vision_route: no vision route is configured for this run");
  assert.deepEqual(blind.misses.map((m) => m.code), ["no_vision_route"]);
});

/** The bytes of a small MP4 a sniff reads as video: an ISO box with an mp4 brand, then padding. */
const mp4Bytes = (size) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isommp41"), Buffer.alloc(size)]);
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

test("a miss about one medium is filed as that medium: a video over the eyes' budget or that the eyes do not take names the video, its kind, its hash and the window its name cites", async () => {
  const clip = mp4Bytes(4000);
  const cwd = workspace({ "w120.mp4": clip });
  const sha256 = createHash("sha256").update(clip).digest("hex");
  const request = { ask: "What does this window show?", paths: ["w120.mp4"], fragments: ["film.mp4#t=120,180"] };
  const script = `try { await vision.see(${JSON.stringify(request)}); return "seen"; } catch (error) { return error.message; }`;
  const small = { ...DEFAULT_LIMITS, video: { ...DEFAULT_LIMITS.video, native: true, inlineBytes: 1000 } };
  for (const [eyes, code] of [[fakeEyes({ accepts: { video: true }, limits: small }), "over_budget"], [fakeEyes(), "video_unseeable"]]) {
    const rows = host();
    const out = await ran(createVisionExtension({ eyes, ...rows.options }), cwd, script);
    assert.match(out.value, new RegExp(`^${code}: film\\.mp4#t=120,180`));
    const [record] = rows.filed;
    assert.deepEqual([record.status, record.args.path, record.facts.kind, record.facts.sha256, record.facts.fragment], ["failed", "film.mp4#t=120,180", "video", sha256, "t=120,180"], code);
    assert.deepEqual(rows.misses.map((m) => [m.code, m.source]), [[code, "film.mp4#t=120,180"]]);
    assert.equal(eyes.ledger.length, 0, "no request was sent");
  }
});

test("a name whose cited window rounds to nothing is still a name: the look is made, and a miss of it cites no window", async () => {
  const cwd = workspace({ "p1.png": pngBytes(40, 30) });
  const rows = host();
  const label = "film.mp4#t=1.0001,1.0004";
  const seen = await ran(createVisionExtension({ eyes: fakeEyes({ answers: ["a test card"] }), ...rows.options }), cwd, `return await vision.see({ ask: "what?", paths: ["p1.png"], fragments: [${JSON.stringify(label)}] });`);
  assert.equal(seen.ok, true);
  assert.equal(seen.value.text, "a test card");
  const blind = host();
  await ran(createVisionExtension(blind.options), cwd, `try { await vision.see({ ask: "what?", paths: ["p1.png"], fragments: [${JSON.stringify(label)}] }); } catch (error) { return error.message; }`);
  assert.deepEqual(blind.filed.map((r) => [r.args.path, r.facts.fragment]), [[label, ""]]);
});

test("a miss before a medium is read names it as asked, of a kind not yet known, and with no hash rather than the hash of no bytes", async () => {
  const cwd = workspace({ "p1.png": pngBytes(40, 30) });
  const blind = host();
  await ran(createVisionExtension(blind.options), cwd, `try { await vision.see({ ask: "what?", paths: ["p1.png"], fragments: ["r.pdf#page=2"] }); } catch (error) { return error.message; }`);
  const gone = host();
  await ran(createVisionExtension({ eyes: fakeEyes(), ...gone.options }), cwd, `try { await vision.see({ ask: "what?", paths: ["gone.mp4"] }); } catch (error) { return error.message; }`);
  assert.deepEqual([blind.filed, gone.filed].map(([r]) => [r.args.path, r.facts.kind, r.facts.sha256, r.facts.fragment]), [["r.pdf#page=2", "unknown", "", "page=2"], ["gone.mp4", "unknown", "", ""]]);
  assert.ok([...blind.filed, ...gone.filed].every((r) => r.facts.sha256 !== EMPTY_SHA256));
});

test("the global is built per call, carries the contract's words, throws a SeeMiss to a caller outside the sandbox, and a host whose setup throws gives a look_failed miss", async () => {
  const cwd = workspace({ "p1.png": pngBytes(40, 30) });
  const call = { conversationId: "c1", callId: "1", model: undefined, signal: undefined };
  const rows = host();
  const global = createVisionExtension({ eyes: fakeEyes({ accepts: { image: false } }), ...rows.options }).see(nodeVisionEnv({ cwd }), call);
  assert.deepEqual([global.name, global.description, global.signature], [VISION_SEE.name, VISION_SEE.description, VISION_SEE.signature]);
  await assert.rejects(global.execute({ ask: "what?", paths: ["p1.png"] }), (error) => error instanceof SeeMiss && error.code === "no_vision_route" && /fake-eyes does not accept images/.test(error.message));
  const broken = host();
  const throwing = createVisionExtension({ ...broken.options, scope: () => { throw new Error("no scope for c1"); } }).see(nodeVisionEnv({ cwd }), call);
  await assert.rejects(throwing.execute({ ask: "what?", paths: ["p1.png"] }), (error) => error instanceof SeeMiss && error.code === "look_failed" && error.message === "look_failed: this host could not set the look up: no scope for c1");
  assert.deepEqual(broken.misses.map((m) => [m.tool, m.code]), [["vision.see", "look_failed"]]);
  const blocks = createVisionExtension({ eyes: twoAtATime(), ...host().options }).see(undefined, call);
  assert.equal((await blocks.execute({ ask: "what?", images: [png(20, 20)] })).text, "saw image 1", "with no environment, image blocks are still seen");
  await assert.rejects(blocks.execute({ ask: "what?", paths: ["p1.png"] }), /^SeeMiss: refused: p1\.png cannot be read/);
});

// The kill: see-child.mjs is one process of a run whose script asks about two files, one image a request.
const CHILD = path.join(import.meta.dirname, "durable", "see-child.mjs");
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
function child(paths, mode) {
  const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...paths, MODE: mode }, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk; });
  const exit = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, line: stdout.split("\n").find((l) => l.startsWith("RESULT ")) })));
  return { proc, exit, result: exit.then(({ line }) => (line === undefined ? undefined : JSON.parse(line.slice("RESULT ".length)))) };
}
async function run(cut) {
  const dir = tmp("vision-see-kill-");
  const paths = { DB: path.join(dir, "run.sqlite"), CWD: path.join(dir, "work"), OUT: path.join(dir, "out"), LEDGER: path.join(dir, "eyes.jsonl") };
  fs.mkdirSync(paths.CWD); fs.mkdirSync(paths.OUT);
  fs.writeFileSync(path.join(paths.CWD, "p1.png"), pngBytes(40, 30));
  fs.writeFileSync(path.join(paths.CWD, "p2.png"), pngBytes(50, 30));
  let atCut;
  if (cut) {
    const first = child(paths, "first");
    for (let waited = 0; !fs.existsSync(path.join(paths.CWD, ".cut")); waited += 20) {
      assert.ok(waited < 60_000, "the first process never reached the second request");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    atCut = { asks: lines(paths.LEDGER).length, told: lines(path.join(paths.OUT, "looks.jsonl")).length };
    first.proc.kill("SIGKILL");
    assert.deepEqual(await first.exit, { code: null, signal: "SIGKILL", line: undefined }, "the first process died by SIGKILL, answering nothing");
  }
  const second = await child(paths, "second").result;
  return { ...second, atCut, asks: lines(paths.LEDGER).length, told: lines(path.join(paths.OUT, "looks.jsonl")), filed: lines(path.join(paths.OUT, "filed.jsonl")) };
}

test("killed between two requests, the rerun asks only the second, tells the first as kept, and the script gets what an uncut run gets", async () => {
  const clean = await run(false);
  const keys = clean.told.map((look) => look.key);
  assert.equal(clean.settled, "done");
  assert.deepEqual([clean.asks, new Set(keys).size, clean.told.map((look) => look.kept)], [2, 2, [false, false]], "an uncut run is two paid looks");
  const cut = await run(true);
  assert.deepEqual(cut.atCut, { asks: 1, told: 1 }, "the cut fell once the host was told of the first look, before the second was asked");
  assert.equal(cut.settled, "done");
  assert.deepEqual(cut.results, clean.results, "the script returns the same text, price and receipts");
  assert.equal(cut.asks, 2, "the eyes were asked once per look in all");
  assert.deepEqual(cut.told.map((look) => [look.by, look.key, look.kept]), [["first", keys[0], false], ["second", keys[0], true], ["second", keys[1], false]], "the rerun tells the first look as kept and the second as paid");
  assert.equal(cut.told.filter((look) => !look.kept).reduce((sum, look) => sum + look.costUsd, 0), clean.told.reduce((sum, look) => sum + look.costUsd, 0), "a host that charges every look not kept charges each once");
  assert.deepEqual(cut.filed.map((r) => [r.key, r.kept]), [[keys[0], false], [keys[0], true], [keys[1], false]], "the first look's record filed again says it was read back");
});
