// The report skill's six pieces run as written: skills/report/SKILL.md is one script in six ```js blocks, run in order in
// pi-codemode's sandbox with a `bash` tool over a workspace the test builds (a 40 second film, a four page PDF and a photo)
// and the handle's `vision.see` on fake eyes. The host files each look as a receipt, the first as a text receipt with a
// `key:` header line and the next as a JSON record, the two shapes hosts write. The written page is then checked here, not by
// the skill's own check: script-free and self-contained, every file present, within budget and without metadata, cites in the
// file's own address resolving to a look the run made, boxes inside the picture, the answer first, the routine detail
// folded, each kept picture captioned, a window never a clip twice and its poster its opening frame. A page with each of
// those faults is refused by the skill's check. Needs ffmpeg and poppler: `npm run test:binaries` runs it, `npm test` does not.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { receiptFacts } from "@parcha/pi-vision";
import { createVisionExtension } from "@parcha/pi-vision/durable";
import { nodeVisionEnv } from "@parcha/pi-vision/node";
import { fakeEyes, fixtureDir, photoJpeg, textPdf } from "@parcha/pi-vision/testing";
import { ANSWERS, fakeJev } from "../support/jev.mjs";

const SKILL = fs.readFileSync(new URL("../../skills/report/SKILL.md", import.meta.url), "utf8");
const pieces = [...SKILL.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
const [helpers, assets, looking, data, ground, render, check, ...more] = pieces;

const dir = await fixtureDir("pi-vision-report-skill-");
after(() => dir.remove());
const cwd = dir.path;
// 40 seconds of a moving test card at 640x360, 5 frames a second, with a tone, so a cut clip has something to compress and
// each frame says which second it is.
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=5:duration=40", "-f", "lavfi", "-i", "sine=frequency=440:duration=40",
  "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", path.join(cwd, "talk.mp4")]);
// A film that is black for its first four seconds and then moves, and a photo that is black: what a dark frame is.
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x120:r=5:d=4", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=5:duration=4", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", "-pix_fmt", "yuv420p", "-c:v", "libx264", path.join(cwd, "opens-black.mp4")]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x120", "-frames:v", "1", path.join(cwd, "dark.jpg")]);
fs.writeFileSync(path.join(cwd, "contract.pdf"), textPdf(4));
// The photo carries a camera's metadata, as a real one does, so what a kept photo sheds can be told.
fs.writeFileSync(path.join(cwd, "photo.jpg"), await sharp(await photoJpeg(sharp)).withMetadata({ exif: { IFD0: { Copyright: "origin-marker-9f3a" } } }).jpeg().toBuffer());
assert.ok(fs.readFileSync(path.join(cwd, "photo.jpg")).includes("origin-marker-9f3a"), "the test photo carries its marker");

/** What the fake eyes add to every answer, what the fake speech-to-text hears, and the fake Jev port: its noul answer is
 *  yes when every name (a capitalised word that does not open a sentence) and every number of the text it is asked about
 *  occurs in the evidence, else no. The real judge is a model; this stands in for it so the step runs at $0. */
let eyesAlso = "";
let speech = { provider: "fake", model: "fake-stt", usdPerMinute: 0.008, async transcribe() { const words = "Steve Bales gave the go at nine minutes".split(" ").map((text, i) => ({ text, start: i, end: i + 1 })); return { words, text: words.map((w) => w.text).join(" ") }; } };
let jev = null;
let jevFails;
const tokens = (text) => [...String(text).matchAll(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]+|\d+/g)].map((m) => m[0].toLowerCase());
let noJudgeReceipt = false;   // a host that files no receipt for a judge look: vision.judge answers with receipts: []
let jevCap = Infinity, jevAsked = 0;   // the fake judge's request cap: past it every request fails, as a host's cap does
const asked = new WeakSet();
const ABSENT = /\b(absent|missing|removed|blank|no seal|no stamp)\b/i;
const groundedBy = (question, { state }) => {
  if (state.claims && !asked.has(state)) { asked.add(state); if (++jevAsked > jevCap) throw new Error("429 the request cap was reached"); }
  if (!state.claims) return question.type === "noul" ? { type: "noul", noul: 0.02 } : ANSWERS[question.type](question);   // a picture put to Jev (decide()): the thing is not there
  const text = state.claims[/claims\.(t\d+)/.exec(question.instructions)[1]];
  // An absence is stated by a no of Jev's, as words in the evidence; any other text by its names and numbers being in the evidence.
  if (ABSENT.test(text)) return { type: "noul", noul: state.evidence.some((e) => /^Jev, asked ".*": no \(/m.test(e)) ? 0.95 : 0.03 };
  const evidence = state.evidence.join(" ").toLowerCase();
  return { type: "noul", noul: tokens(text).every((token) => evidence.includes(token)) ? 0.95 : 0.03 };
};

/** A bash tool as a host's code mode gives one: the command's output, or a rejection that carries what it printed. */
let bashEnv = process.env;   // a test may give the shell a TMPDIR of its own
const bash = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd, env: bashEnv, maxBuffer: 1 << 26 }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)))) };

/** Runs the pieces as one script and gives what it returned and the keys of the looks the host filed. */
async function run(codes) {
  fs.rmSync(path.join(cwd, "report"), { recursive: true, force: true });
  fs.rmSync(path.join(cwd, "evidence"), { recursive: true, force: true });
  const keys = [], judged = [];
  let n = 0;
  const eyes = fakeEyes({ answers: [(request) => `The picture at ${request.parts.find((p) => p.type === "image")?.fragment} is shown.${eyesAlso}`] });
  jev = fakeJev({ answer: groundedBy, fail: jevFails });
  const vision = createVisionExtension({
    eyes,
    jev: { judge: jev.judge },
    transcriber: speech,
    scope: () => ({ label: "report", deriveDir: ".vision" }),
    evidence: { file: async (label, record) => {
      if (noJudgeReceipt && record.args?.via === "jev") return null;
      (record.args?.via === "jev" ? judged : keys).push(record.facts.key);
      n += 1;
      const file = `evidence/${label}/${n}-look.${n % 2 ? "md" : "json"}`;
      fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      // A text receipt: `key: value` header lines, then `---`, then the body. A JSON receipt: the record itself.
      const text = `tool: ${record.tool}\nargs: ${JSON.stringify(record.args)}\nstatus: ${record.status}\n${Object.entries(receiptFacts(record)).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${record.body}\n`;
      fs.writeFileSync(path.join(cwd, file), n % 2 ? text : JSON.stringify(record, null, 2));
      return { path: file };
    } },
  });
  const call = { conversationId: "report", callId: "1", model: undefined, signal: undefined };
  const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(nodeVisionEnv({ cwd }), call), vision.judge(nodeVisionEnv({ cwd }), call), vision.transcribe(nodeVisionEnv({ cwd }), call)] });
  try {
    const result = await sandbox.execute(codes.join("\n"));
    return { result, keys, judged };
  } finally { await sandbox.close(); }
}

/** The good build, once: a test that reads the written page or its files asks for it, and gets the disk as the pieces left it. */
let good = null;
let onDisk = null;
const built = async () => {
  if (onDisk !== "good") {
    const { result, keys } = await run(pieces);
    assert.ok(result.ok, result.ok ? "" : result.error.message);
    good = { value: result.value, keys };
    onDisk = "good";
  }
  return good;
};
const HTML = () => fs.readFileSync(path.join(cwd, "report", "index.html"), "utf8");
/** The values of an attribute everywhere in the page. */
const attrs = (html, name) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);
const unescapeHtml = (text) => text.replaceAll("&amp;", "&");
const sizeOf = (file) => fs.statSync(path.join(cwd, "report", file)).size;
const all = (dirPath) => fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dirPath, e.name)) : [path.join(dirPath, e.name)]));
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration:format_tags:stream_tags", "-of", "json", file], { encoding: "utf8" }));
/** How alike two pictures are, as ffmpeg's PSNR reads them: higher is closer. */
const psnr = (a, b) => {
  const found = /average:([\d.]+|inf)/.exec(spawnSync("ffmpeg", ["-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"], { encoding: "utf8" }).stderr)?.[1];
  return found === "inf" ? Infinity : Number(found ?? "NaN");
};

test("the skill holds the six pieces this test runs, and nothing more", () => {
  assert.deepEqual([helpers, assets, looking, data, ground, render, check].map((code) => typeof code), Array(7).fill("string"));
  assert.deepEqual(more, []);
  assert.ok(/^name: report$/m.test(SKILL) && /^description: .{40,}$/m.test(SKILL));
  const description = /^description: (.*)$/m.exec(SKILL)[1];
  assert.ok(description.length <= 1024, `${description.length} characters of description`);
  assert.ok(!description.includes(": ") && !description.includes(" #"), "a plain YAML scalar: no colon-space and no comment mark, or the skills loader refuses the front matter");
});

test("a file is written byte for byte, whatever it holds, with no chunk ending inside a character", async () => {
  const text = `<p>${"a".repeat(29_996)}\u{1F600}${"é".repeat(29_000)}\u{1F4A1}${"b".repeat(40_000)}'quoted' $HOME \\n %s \`tick\` ${"\u{1F600}".repeat(20_000)}</p>\n`;
  fs.writeFileSync(path.join(cwd, "text.json"), JSON.stringify(text));
  onDisk = "other";
  const { result } = await run([helpers, 'await write("out/text.html", JSON.parse(await sh("cat text.json"))); return await bytes("out/text.html");']);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(fs.readFileSync(path.join(cwd, "out", "text.html"), "utf8"), text);
  assert.equal(result.value, Buffer.byteLength(text));
});

test("the pieces make one page and its files, and the skill's own check finds nothing wrong", async () => {
  const { value, keys } = await built();
  assert.deepEqual({ ...value, bytes: undefined }, { report: "report/index.html", findings: 3, looks: 3, bytes: undefined });
  assert.equal(keys.length, 3, "one look a picture");
  assert.equal(new Set(keys).size, 3);
  assert.ok(value.bytes > 2000 && value.bytes < 60_000, `${value.bytes} bytes of page`);
  assert.ok(fs.existsSync(path.join(cwd, "report", "index.html")) && !fs.existsSync(path.join(cwd, "report", "report.html")), "the entry is index.html");
});

test("the page is script-free and self-contained: no code, no data: URL, no frame, no URL of any kind, no path of this machine", async () => {
  await built();
  const html = HTML();
  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /<script|<link|<iframe|<object|<embed|<form|<base|@import|http-equiv/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no event handler attributes");
  assert.doesNotMatch(html, /data:|https?:|(^|[^:])\/\/[a-z0-9]|url\(/i, "no data: URL, no absolute or protocol-relative URL, no CSS url()");
  assert.ok(!html.includes(cwd) && !html.includes(process.env.HOME ?? "/nonexistent-home"), "no machine path");
  assert.doesNotMatch(html, /\bsk-[A-Za-z0-9]{10,}|Bearer /);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, "readable at phone width");
  assert.match(html, /color-scheme:light dark/);
  assert.match(html, /@media \(prefers-color-scheme:dark\)/, "and in the dark");
  assert.match(html, /<html lang="en">/);
  assert.ok(!html.includes("../"), "no ../ anywhere in the page: a path that leaves report/ is dead");
});

test("every file the page shows is in report/, is not empty and is within budget; the folder holds nothing the page does not need", async () => {
  await built();
  const html = HTML();
  const refs = [...attrs(html, "src"), ...attrs(html, "poster")];
  assert.deepEqual([...new Set(refs)].sort(), ["clips/talk-chart.mp4", "frames/contract-p3.jpg", "frames/contract-rule.jpg", "frames/site-photo.jpg", "frames/talk-chart-poster.jpg", "frames/talk-chart.jpg", "frames/talk-later.jpg"]);
  for (const ref of refs) {
    assert.ok(!path.isAbsolute(ref) && !ref.split("/").includes(".."), `${ref} stays in the folder`);
    assert.ok(sizeOf(ref) > 0, `${ref} is not empty`);
  }
  for (const ref of refs.filter((r) => r.startsWith("frames/"))) assert.ok(sizeOf(ref) <= 700_000, `${ref}: ${sizeOf(ref)} bytes`);
  assert.ok(sizeOf("clips/talk-chart.mp4") <= 1_500_000, "a clip is at most 1.5 MB");
  assert.ok(all(path.join(cwd, "report")).reduce((n, f) => n + fs.statSync(f).size, 0) <= 8_000_000, "the folder is at most 8 MB");
  assert.deepEqual(all(path.join(cwd, "report")).map((f) => path.relative(path.join(cwd, "report"), f)).sort(), ["clips/talk-chart.mp4", "contract.pdf", "frames/contract-p3.jpg", "frames/contract-rule.jpg", "frames/site-photo.jpg", "frames/talk-chart-poster.jpg", "frames/talk-chart.jpg", "frames/talk-later.jpg", "index.html", "photo.jpg"]);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "report", "contract.pdf")), fs.readFileSync(path.join(cwd, "contract.pdf")), "a source document is copied as it is");
  assert.ok(!fs.existsSync(path.join(cwd, "report", "talk.mp4")), "a film named in outside is not copied");
  const photo = fs.readFileSync(path.join(cwd, "report", "photo.jpg"));
  assert.ok(!photo.includes("origin-marker-9f3a"), "a kept photo is re-encoded without its metadata");
  const upright = (await sharp(path.join(cwd, "photo.jpg")).rotate().toBuffer({ resolveWithObject: true })).info;   // what a viewer shows
  assert.deepEqual([(await sharp(photo).metadata()).width, (await sharp(photo).metadata()).height], [upright.width, upright.height], "at its own size, upright, so a look's percentages fit");
  // The files are what they say they are: a page at 1600 px with the letter page's proportions, a film frame at most 960 px,
  // a short silent H.264 clip of 8 seconds at most 480 px wide.
  const size = async (file) => { const m = await sharp(path.join(cwd, "report", file)).metadata(); return [m.width, m.height]; };
  assert.deepEqual(await size("frames/contract-p3.jpg"), [1600, 2071]);
  assert.ok((await size("frames/talk-chart.jpg"))[0] <= 960 && (await size("frames/site-photo.jpg"))[0] <= 960);
  const clip = probe(path.join(cwd, "report", "clips", "talk-chart.mp4"));
  assert.deepEqual(clip.streams.map((s) => [s.codec_type, s.codec_name]), [["video", "h264"]], "silent unless the sound is the point");
  assert.ok(clip.streams[0].width <= 480);
  assert.ok(Math.abs(Number(clip.format.duration) - 8) < 0.7, `${clip.format.duration} s`);
});

test("pictures and clips carry no metadata, and no file of the folder names this machine", async () => {
  await built();
  const tagged = [];
  for (const file of all(path.join(cwd, "report")).filter((f) => /\.(jpg|mp4)$/.test(f))) {
    const found = probe(file);
    // What a container says of itself (its brand, a stream's language and handler) and the codec's own name stay; nothing else.
    const structural = new Set(["major_brand", "minor_version", "compatible_brands", "language", "handler_name", "vendor_id"]);
    const names = [...Object.keys(found.format.tags ?? {}), ...found.streams.flatMap((s) => Object.entries(s.tags ?? {}).filter(([t, v]) => !(t === "encoder" && /^Lavc [\w.-]+$/.test(v))).map(([t]) => t))].filter((t) => !structural.has(t));
    if (names.length) tagged.push(`${path.relative(cwd, file)}: ${names}`);
  }
  assert.deepEqual(tagged, [], "no encoder, creation time, title or comment tag");
  for (const needle of [cwd, process.env.HOME ?? "/nonexistent-home", path.basename(cwd)]) {
    const found = spawnSync("grep", ["-rlaF", needle, path.join(cwd, "report")], { encoding: "utf8" }).stdout.trim();
    assert.equal(found, "", `no file of the folder holds ${needle}`);
  }
});

test("a clip's poster is its window's opening frame", async () => {
  await built();
  const ref = (t) => { const out = path.join(cwd, `.ref-${t}.jpg`); execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", path.join(cwd, "talk.mp4"), "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "4", out]); return out; };
  const poster = path.join(cwd, "report", "frames", "talk-chart-poster.jpg");
  const [atOpening, later, muchLater] = [psnr(poster, ref(18)), psnr(poster, ref(19)), psnr(poster, ref(25))];
  assert.ok(atOpening > later && atOpening > muchLater, `the poster is closest to second 18: ${atOpening} against ${later} and ${muchLater}`);
  assert.match(HTML(), /<video controls muted playsinline preload="metadata" poster="frames\/talk-chart-poster\.jpg"><source src="clips\/talk-chart\.mp4" type="video\/mp4"><\/video>/);
});

test("a window is one clip: asking for it again stops the script and names the frame to show instead; another window is its own clip", async () => {
  onDisk = "other";
  const { result } = await run([helpers, assets, 'await clip("talk.mp4", 18, 26, "one"); await clip("talk.mp4", 18, 26, "two");']);
  assert.ok(!result.ok);
  assert.match(result.error.message, /talk\.mp4#t=18,26 is already the clip one: show a frame of this window, not the clip again/);
  const apart = await run([helpers, assets, 'const a = await clip("talk.mp4", 18, 26, "one"); const b = await clip("talk.mp4", 30, 36, "two"); return [a.src, b.src, a.poster, b.poster];']);
  assert.ok(apart.result.ok, apart.result.ok ? "" : apart.result.error.message);
  assert.deepEqual(apart.result.value, ["clips/one.mp4", "clips/two.mp4", "frames/one-poster.jpg", "frames/two-poster.jpg"]);
});

test("each cite is a link to the source file's own address, labelled with that number, and names a look the run made", async () => {
  const { keys } = await built();
  const html = HTML();
  const cites = [...html.matchAll(/<a class="cite" href="([^"]*)" data-look="([^"]*)">([^<]*)<\/a>/g)].map(([, href, look, label]) => ({ href: unescapeHtml(href), look, label }));
  assert.deepEqual(cites.map((c) => [c.href, c.label]), [
    ["talk.mp4#t=21.5&xywh=percent:61.2,40,12,9", "21.5 s"],
    ["talk.mp4#t=18,26", "18 to 26 s"],
    ["contract.pdf#page=3&xywh=percent:7,6,70,4", "p. 3"],
    ["contract.pdf#page=3", "open at p. 3"],
    ["photo.jpg", "file"],
  ]);
  assert.deepEqual(cites.map((c) => c.look), [keys[0], keys[0], keys[1], keys[1], keys[2]], "the talk's two cites rest on its look; the receipts were a text one and JSON ones");
  for (const cite of cites) {
    assert.match(cite.look, /^[0-9a-f]{64}$/, "a look key");
    assert.ok(!cite.href.startsWith("/") && !cite.href.includes(".."), `${cite.href} is relative to the folder`);
    const [file, fragment] = cite.href.split("#");
    assert.ok(fs.existsSync(path.join(cwd, file)), `${file} is a file of the run`);
    if (fragment) assert.match(fragment, /^(?:(?:page=[1-9]\d*|t=\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?)?)(?:&xywh=percent:\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?){3})?)$/);
  }
  assert.equal(attrs(html, "href").filter((h) => !h.startsWith("#")).length, cites.length, "every link out of the page is a cite");
  assert.ok(fs.existsSync(path.join(cwd, "report", "contract.pdf")), "the cited document resolves inside the folder");
});

test("a box is its look's percentages on the picture, inside it, links back to its finding and is linked from it", async () => {
  const { keys } = await built();
  const html = HTML();
  const boxes = [...html.matchAll(/<div class="mark( right)?" id="([^"]*)" data-xywh="percent:([^"]*)" data-look="([^"]*)" style="([^"]*)"><a class="tag" href="#([^"]*)">([^<]*)<\/a><\/div>/g)];
  assert.deepEqual(boxes.map((b) => [b[2], b[3], b[4], b[5], b[6], b[7], Boolean(b[1])]), [
    ["mark-peak", "61.2,40,12,9", keys[0], "left:61.2%;top:40%;width:12%;height:9%", "f-chart", "second quarter", true],
    ["crop-rule", "7,33.33,70,33.33", keys[1], "left:7%;top:33.33%;width:70%;height:33.33%", "f-contract", "the rule", false],
    ["mark-rule", "7,6,70,4", keys[1], "left:7%;top:6%;width:70%;height:4%", "f-contract", "the rule", false],
  ], "the percentages as written, with no arithmetic (the crop's box is computed by crop(), not by the model); a box on the right half has its label on its right edge");
  for (const [, , , xywh] of boxes) {
    const [x, y, w, h] = xywh.split(",").map(Number);
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 100 && y + h <= 100);
  }
  assert.match(html, /<div class="sheet"><img src="frames\/talk-chart\.jpg"[^>]*><div class="mark right" id="mark-peak"/, "over the picture of its finding");
  assert.match(html, /<div class="sheet"><img src="frames\/contract-p3\.jpg"[^>]*><div class="mark" id="mark-rule"/, "and over the document's page");
  const ids = new Set(attrs(html, "id"));
  assert.equal(ids.size, attrs(html, "id").length, "no id twice");
  for (const href of attrs(html, "href").filter((h) => h.startsWith("#"))) assert.ok(ids.has(href.slice(1)), `${href} names something on the page`);
  assert.match(html, /<a class="jump" href="#mark-peak">show on the picture<\/a>/);
  assert.match(html, /<a class="jump" href="#mark-rule">show on p\. 3<\/a>/);
});

test("the answer comes first with its key points, the key findings are open, the routine one is folded, the document is embedded, and what was not checked is last", async () => {
  await built();
  const html = HTML();
  const order = ["<h1>", 'id="answer"', 'id="evidence"', 'class="finding" id="f-chart"', 'class="finding" id="f-contract"', 'id="document"', 'class="docpage" id="contract-p3"', 'id="routine"', 'class="finding routine" id="f-site"', 'id="not-checked"'].map((marker) => html.indexOf(marker));
  assert.ok(order.every((at) => at >= 0), "every part is there");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order");
  assert.equal((html.match(/<article class="finding"/g) ?? []).length, 2);
  assert.match(html, /<details class="finding routine" id="f-site" data-ground="[^"]*"><summary>The site<\/summary>/, "the routine detail is folded");
  assert.doesNotMatch(html, /<details[^>]*id="f-(chart|contract)"/, "a key finding is open");
  const points = html.match(/<ul class="points">([\s\S]*?)<\/ul>/)[1];
  assert.deepEqual([...points.matchAll(/<a href="#([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]), [["f-chart", "second quarter"], ["f-contract", "page 3"]], "each key point links to its finding");
  for (const article of html.split('<article class="finding"').slice(1)) {
    assert.match(article, /<h3>[^<]+<\/h3><p>[^<]+<\/p>/, "a claim and its words");
    assert.match(article, /<p class="cites">(<a class="cite" [^>]*>[^<]*<\/a>\s*)+/, "its cites");
  }
  const figures = html.match(/<figure class="pic"[^>]*>[\s\S]*?<\/figure>/g);
  assert.equal(figures.length, 5, "the chart, the same chart later, the clip, the close crop of the rule and the photo");
  for (const figure of figures) assert.match(figure, /<figcaption>[^<]{12,}<\/figcaption>/, "a caption that says why the picture is kept");
  assert.match(html, /alt="A bar chart with the second bar tallest"/, "a picture has alternative text");
  assert.match(html, /<section id="document"><h2>The document, with their marks<\/h2><figure class="docpage" id="contract-p3"><header><span class="n">p\. 3<\/span><a class="cite" href="contract\.pdf#page=3"/);
  assert.match(html, /<section id="not-checked">[\s\S]*<\/section>\s*<\/main>/);
});

test("text a look gives is escaped, not trusted as markup", async () => {
  const hostile = data.replace(/why: "On screen[^"]*",/, 'why: `<script>alert(1)</script><img src=x onerror=alert(1)> "quoted" & more`,');
  assert.notEqual(hostile, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, hostile, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; more"));
  assert.doesNotMatch(html, /<script|<img src=x/);
});

test("a URL in a look's words is written without its scheme, so the page still reaches nowhere", async () => {
  const quoting = data.replace(/why: "On screen[^"]*",/, "why: `The slide says https://example.com/terms?a=1&b=2, and links //cdn.example/x.js, and mailto:a@example.com.`,");
  assert.notEqual(quoting, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, quoting, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  assert.ok(html.includes("The slide says example.com/terms?a=1&amp;b=2, and links cdn.example/x.js, and a@example.com."));
  assert.doesNotMatch(html, /https?:|\/\/[a-z0-9]/i);
});

/** The pieces with the page changed after it is built and before it is written, so the check meets it. */
async function doctored(change) {
  const code = render.replace('await write("report/index.html", page);', `${change}\nawait write("report/index.html", page);`).replace("const page = ", "let page = ");
  assert.notEqual(code, render);
  onDisk = "other";
  return run([helpers, assets, looking, data, ground, code, check]);
}
const refuses = async (change, pattern) => {
  const { result } = await doctored(change);
  assert.ok(!result.ok, `the check refuses the page after: ${change}`);
  assert.match(result.error.message, pattern);
};
/** `page.replace` of one exact piece of the written page. */
const swap = (from, to) => `page = page.replace(${JSON.stringify(from)}, ${JSON.stringify(to)});`;

test("the skill's check refuses a page that runs code or loads from outside the folder", async () => {
  await refuses(swap("</main>", '<script src="https://cdn.example/x.js"></script></main>'), /runs code or loads from outside report\//);
  await refuses(swap("</main>", "<script>alert(1)</script></main>"), /runs code or loads from outside report\//);
  await refuses(swap("<h1>", '<h1 onclick="x()">'), /runs code or loads from outside report\//);
  await refuses(swap("</main>", '<img src="//cdn.example/x.png"></main>'), /runs code or loads|not a file in report/);
  await refuses(swap("</main>", "<p>see http://example.com/terms</p></main>"), /runs code or loads from outside report\//);
  await refuses(swap("</main>", '<iframe src="frames/talk-chart.jpg"></iframe></main>'), /runs code or loads from outside report\//);
  await refuses(swap("</main>", '<form action="frames/x"></form></main>'), /runs code or loads from outside report\//);
  await refuses(swap("<title>", '<meta http-equiv="refresh" content="0"><title>'), /runs code or loads from outside report\//);
  await refuses(swap("</style>", "body{background:url(frames/talk-chart.jpg)}</style>"), /runs code or loads from outside report\//);
  await refuses(swap('src="frames/site-photo.jpg"', 'src="data:image/jpeg;base64,/9j/4AAQ"'), /data: URL/);
});

test("the skill's check refuses a missing file, a file outside the folder, an over-budget file and a clip shown twice or with no poster", async () => {
  await refuses(swap("frames/site-photo.jpg", "frames/not-there.jpg"), /frames\/not-there\.jpg is missing or empty/);
  await refuses(swap('src="frames/site-photo.jpg"', 'src="../talk.mp4"'), /\.\.\/talk\.mp4 is not a file in report\//);
  await refuses('await sh("head -c 800000 /dev/zero > report/frames/fat.jpg");' + swap("</main>", '<img src="frames/fat.jpg" alt="x"></main>'), /frames\/fat\.jpg is over 700000 bytes/);
  await refuses('await sh("head -c 2000000 /dev/zero > report/clips/big.mp4");' + swap("</main>", '<video poster="frames/talk-chart.jpg"><source src="clips/big.mp4"></video></main>'), /clips\/big\.mp4 is over 1500000 bytes/);
  await refuses('await sh("head -c 8500000 /dev/zero > report/clips/huge.bin");', /report\/ is over 8000000 bytes/);
  await refuses(swap("</main>", '<video poster="frames/talk-chart.jpg"><source src="clips/talk-chart.mp4"></video></main>'), /a clip is shown twice/);
  await refuses(swap(' poster="frames/talk-chart-poster.jpg"', ""), /a clip has no poster/);
  await refuses('await sh("pwd > report/note.txt");', /names a path of this machine/);
});

test("the skill's check refuses a cite that is not the file's own address, names no look, or points nowhere", async () => {
  await refuses(swap('href="contract.pdf#page=3&amp;xywh=percent:7,6,70,4"', 'href="contract.pdf#page=0"'), /has a fragment that is not page=, t= or xywh=/);
  await refuses(swap('href="talk.mp4#t=21.5&amp;xywh=percent:61.2,40,12,9"', 'href="talk.mp4#t=soon"'), /has a fragment that is not page=, t= or xywh=/);
  await refuses(swap('href="talk.mp4#t=18,26"', 'href="talk.mp4#t=18,26,30"'), /has a fragment that is not page=, t= or xywh=/);
  await refuses(swap('href="photo.jpg"', 'href="/photo.jpg"'), /is not a file of report\/ or a bare file name/);
  await refuses(swap('href="photo.jpg"', 'href="../photo.jpg"'), /is not a file of report\/ or a bare file name/);
  await refuses(swap('href="photo.jpg"', 'href="https://example.com/photo.jpg"'), /runs code or loads|is not a file of report/);
  await refuses(swap('href="photo.jpg"', 'href="other.pdf"'), /other\.pdf is neither in report\/ nor named in outside/);
  await refuses(swap('class="cite" href="photo.jpg" data-look=', 'class="cite" href="photo.jpg" data-x='), /a cite has no data-look/);
  await refuses(swap("#f-contract", "#f-nowhere"), /#f-nowhere names nothing on the page/);
  await refuses(swap('id="mark-rule"', 'id="mark-peak"'), /share an id/);
});

test("the skill's check refuses a look key no look made, a box outside the picture, a picture with no caption, the answer not first and too many key points", async () => {
  await refuses(`page = page.replace(/data-look="[0-9a-f]{64}"/, 'data-look="${"f".repeat(64)}"');`, /is no look this run made/);
  await refuses(swap('data-xywh="percent:61.2,40,12,9"', 'data-xywh="percent:90,40,12,9"'), /percent:90,40,12,9 is not inside 0 to 100/);
  await refuses(swap('data-xywh="percent:7,6,70,4"', 'data-xywh="percent:7,6,70,-4"'), /is not inside 0 to 100/);
  await refuses('page = page.replace(/<figcaption>[^<]*<\\/figcaption>/, "<figcaption></figcaption>");', /a picture has no caption/);
  await refuses(swap('id="answer"', 'id="summary"'), /the answer is not first/);
  const many = render.replace("const keyFindings", "report.points.push(...Array.from({ length: 4 }, (_, i) => ({ label: `x${i}`, value: `v${i}`, to: 'f-chart' })));\nconst keyFindings");
  assert.notEqual(many, render);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, data, ground, many, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /the answer has one to four key points/);
});

test("a clip that cannot fit its budget stops the script with the window to shorten; a name that is not a file name and a source in a folder are refused", async () => {
  const small = helpers.replace("clip: 1_500_000", "clip: 5_000");
  assert.notEqual(small, helpers);
  onDisk = "other";
  const { result } = await run([small, assets, looking, data, ground, render, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /talk-chart: 8 s do not fit 5000 bytes; cut a shorter window/);
  const named = data.replace('21.5, "talk-chart")', '21.5, "Talk Chart")');
  assert.notEqual(named, data);
  const refused = await run([helpers, assets, looking, named, ground, render, check]);
  assert.ok(!refused.result.ok);
  assert.match(refused.result.error.message, /Talk Chart: a file name here is lowercase letters, digits and dashes/);
  fs.writeFileSync(path.join(cwd, "big.pdf"), Buffer.alloc(3_200_000, 0x20));
  const big = await run([helpers, assets, 'await keep("big.pdf");']);
  assert.ok(!big.result.ok);
  assert.match(big.result.error.message, /big\.pdf is over 3000000 bytes: name it in outside and cite it by its name/);
});

test("keep copies a document from wherever it is into report/ and gives the name to cite, so a page never needs ../", async () => {
  fs.mkdirSync(path.join(cwd, "sub", "deeper"), { recursive: true });
  fs.copyFileSync(path.join(cwd, "contract.pdf"), path.join(cwd, "sub", "deeper", "my contract.pdf"));
  onDisk = "other";
  const { result } = await run([helpers, assets, 'return [await keep("sub/deeper/my contract.pdf"), await keep("sub/../photo.jpg")];']);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.deepEqual(result.value, ["my contract.pdf", "photo.jpg"]);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "report", "my contract.pdf")), fs.readFileSync(path.join(cwd, "contract.pdf")));
  assert.ok(!fs.readFileSync(path.join(cwd, "report", "photo.jpg")).includes("origin-marker-9f3a"), "a photo is kept without its metadata");
});

test("the skill's check refuses any ../ in a src, a poster or an href, and an outside that names a path: copy the file in or name a film", async () => {
  await refuses(swap('href="contract.pdf#page=3"', 'href="../contract.pdf#page=3"'), /never write \.\.\//);
  await refuses(swap('href="photo.jpg"', 'href="sub/../photo.jpg"'), /never write \.\.\//);
  await refuses(swap('src="frames/site-photo.jpg"', 'src="../frames/site-photo.jpg"'), /never write \.\.\//);
  await refuses(swap('poster="frames/talk-chart-poster.jpg"', 'poster="../talk-chart-poster.jpg"'), /never write \.\.\//);
  await refuses(swap('href="talk.mp4#t=18,26"', 'href="../talk.mp4#t=18,26"'), /never write \.\.\//);
  const outside = data.replace('outside: ["talk.mp4"]', 'outside: ["../talk.mp4"]');
  assert.notEqual(outside, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, outside, ground, render, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /outside names bare file names, never a path/);
});

test("a relative link names a file of report/ or a film left in outside, and nothing else", async () => {
  await refuses(swap('href="talk.mp4#t=18,26"', 'href="film.mp4#t=18,26"'), /film\.mp4#t=18,26: film\.mp4 is neither in report\/ nor named in outside/);
  await refuses(swap('href="photo.jpg"', 'href="other/photo.jpg"'), /is not a file of report\/ or a bare file name/);
});

test("when the question names a shape, the answer section is that shape: one cited row for each unit, before any finding", async () => {
  const shaped = data.replace("  notChecked:", `  rows: [
    { id: "m1", label: "Seconds 0 to 20", text: "The chart is on the screen.", thumb: await thumb("talk.mp4", "m1-thumb", { t: 10 }), cites: [{ file: "talk.mp4", t: [0, 20], look: lookTalk.key }] },
    { id: "m2", label: "Page 3", text: "The speaker names the rule.", thumb: await thumb("talk.mp4", "m2-thumb", { t: 30 }), cites: [{ file: "contract.pdf", page: 3, look: lookPage.key }] },
  ],
  notChecked:`);
  assert.notEqual(shaped, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, shaped, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  const answer = html.slice(html.indexOf('id="answer"'), html.indexOf('id="evidence"'));
  assert.equal((answer.match(/<li class="row" id="r-m\d" data-ground="[^"]*">/g) ?? []).length, 2, "the rows are in the answer");
  assert.equal((answer.match(/class="cite" href="[^"]*" data-look="[0-9a-f]{64}"/g) ?? []).length, 2, "each row is cited, with its look");
  assert.match(answer, /<span class="when">Seconds 0 to 20<\/span><span class="what">The chart is on the screen\.<\/span>/);
  const nocite = shaped.replace('cites: [{ file: "contract.pdf", page: 3, look: lookPage.key }] },\n  ]', "cites: [] },\n  ]");
  assert.notEqual(nocite, shaped);
  const refused = await run([helpers, assets, looking, nocite, ground, render, check]);
  assert.ok(!refused.result.ok);
  assert.match(refused.result.error.message, /a row or a finding has no cite/);
});

test("a finding with no cite is refused: a claim with no look behind it is left out or put under what was not checked", async () => {
  const bare = data.replace('cites: [{ file: await keep("photo.jpg"), look: lookSite.key }] }', "cites: [] }");
  assert.notEqual(bare, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, bare, ground, render, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /a row or a finding has no cite/);
});

test("a receipt a host files relative to the folder above the workspace is still read for its key", async () => {
  const work = path.join(cwd, "work");
  fs.mkdirSync(work, { recursive: true });
  fs.copyFileSync(path.join(cwd, "photo.jpg"), path.join(work, "photo.jpg"));
  const keys = [];
  const vision = createVisionExtension({
    eyes: fakeEyes({ answers: ["A photo of a site."] }),
    scope: () => ({ label: "report", deriveDir: ".vision" }),
    evidence: { file: async (label, record) => {
      keys.push(record.facts.key);
      const file = `evidence/${label}/look-1.json`;
      fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      fs.writeFileSync(path.join(cwd, file), JSON.stringify(record));
      return { path: file };   // relative to cwd, one level above the workspace the shell runs in
    } },
  });
  const inWork = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd: work, maxBuffer: 1 << 26 }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)))) };
  const call = { conversationId: "report", callId: "1", model: undefined, signal: undefined };
  const sandbox = new CodemodeSandbox({ tools: [inWork], globals: [vision.see(nodeVisionEnv({ cwd: work }), call)] });
  try {
    const result = await sandbox.execute([helpers, looking, 'return (await look("photo.jpg", "photo.jpg", "What is in the photo?")).key;'].join("\n"));
    assert.ok(result.ok, result.ok ? "" : result.error.message);
    assert.equal(result.value, keys[0]);
  } finally { await sandbox.close(); }
});

test("a host that files no receipt gives no look to cite, and the script says so", async () => {
  const eyes = fakeEyes();
  const vision = createVisionExtension({ eyes, scope: () => ({ label: "report", deriveDir: ".vision" }), evidence: { file: async () => null } });
  const call = { conversationId: "report", callId: "1", model: undefined, signal: undefined };
  const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(nodeVisionEnv({ cwd }), call)] });
  onDisk = "other";
  try {
    const result = await sandbox.execute([helpers, assets, looking, data, ground, render, check].join("\n"));
    assert.ok(!result.ok);
    assert.match(result.error.message, /no receipt: this host files none, so there is no look to cite/);
  } finally { await sandbox.close(); }
});

test("a report whose findings are all routine passes: the answer is first and there is no evidence section to open", async () => {
  const calm = data.replace('{ id: "chart", title:', '{ id: "chart", routine: true, title:').replace('{ id: "contract", title:', '{ id: "contract", routine: true, title:');
  assert.notEqual(calm, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, calm, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  assert.ok(!html.includes('id="evidence"') && html.includes('<details class="finding routine" id="f-chart" data-ground="'));
  assert.ok(html.indexOf('id="answer"') < html.indexOf("finding routine"));
});

test("two different sources with one name are refused, not silently replaced; the same source kept twice is one copy", async () => {
  fs.mkdirSync(path.join(cwd, "before"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "after"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "before", "memo.pdf"), textPdf(1));
  fs.writeFileSync(path.join(cwd, "after", "memo.pdf"), textPdf(2));
  fs.copyFileSync(path.join(cwd, "photo.jpg"), path.join(cwd, "before", "site.jpg"));
  await sharp(path.join(cwd, "photo.jpg")).resize(300).jpeg().toFile(path.join(cwd, "after", "site.jpg"));
  onDisk = "other";
  const twice = await run([helpers, assets, 'return [await keep("before/memo.pdf"), await keep("before/memo.pdf"), await keep("before/site.jpg"), await keep("before/site.jpg")];']);
  assert.ok(twice.result.ok, twice.result.ok ? "" : twice.result.error.message);
  assert.deepEqual(twice.result.value, ["memo.pdf", "memo.pdf", "site.jpg", "site.jpg"]);
  const clash = await run([helpers, assets, 'await keep("before/memo.pdf"); await keep("after/memo.pdf");']);
  assert.ok(!clash.result.ok);
  assert.match(clash.result.error.message, /after\/memo\.pdf: report\/ already holds a different file named memo\.pdf; rename one source before keeping both/);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "report", "memo.pdf")), fs.readFileSync(path.join(cwd, "before", "memo.pdf")), "the first is still there");
  const photos = await run([helpers, assets, 'await keep("before/site.jpg"); await keep("after/site.jpg");']);
  assert.ok(!photos.result.ok);
  assert.match(photos.result.error.message, /already holds a different file named site\.jpg/);
  assert.deepEqual(fs.readdirSync(path.join(cwd, "report")).filter((f) => f.startsWith(".")), [], "no half-copied file is left");
});

test("a look that failed is no evidence: its receipt is refused, JSON or text", async () => {
  fs.mkdirSync(path.join(cwd, "earlier"), { recursive: true });   // a run clears evidence/, so these are an earlier run's receipts
  const key = "a".repeat(64);
  fs.writeFileSync(path.join(cwd, "earlier", "failed.json"), JSON.stringify({ status: "failed", facts: { key }, body: "not seen" }));
  fs.writeFileSync(path.join(cwd, "earlier", "failed.md"), `tool: see\nstatus: failed\nkey: ${key}\n---\nnot seen\n`);
  fs.writeFileSync(path.join(cwd, "earlier", "ok.md"), `tool: see\nstatus: ok\nkey: ${key}\n---\nseen\n`);
  onDisk = "other";
  for (const receipt of ["earlier/failed.json", "earlier/failed.md"]) {
    const { result } = await run([helpers, looking, `await keyOf(${JSON.stringify(receipt)});`]);
    assert.ok(!result.ok, receipt);
    assert.match(result.error.message, /is a look that failed: it is no evidence for a finding/);
  }
  const fine = await run([helpers, looking, 'return await keyOf("earlier/ok.md");']);
  assert.ok(fine.result.ok, fine.result.ok ? "" : fine.result.error.message);
  assert.equal(fine.result.value, key);
});

test("a source named with # or ? is a file name in its link, and a document page has alt text of its own", async () => {
  fs.copyFileSync(path.join(cwd, "contract.pdf"), path.join(cwd, "contract#2?draft.pdf"));
  const odd = data.replaceAll('file: "contract.pdf"', 'file: "contract#2?draft.pdf"').replace('keep("contract.pdf")', 'keep("contract#2?draft.pdf")');
  assert.notEqual(odd, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, odd, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  assert.ok(html.includes('href="contract%232%3Fdraft.pdf#page=3"'), "the name is one path component");
  assert.ok(fs.existsSync(path.join(cwd, "report", "contract#2?draft.pdf")));
  assert.ok(!html.includes("undefined"), "nothing on the page is a missing value");
  assert.match(html, /<img src="frames\/contract-p3\.jpg" alt="Page 3 of contract#2\?draft\.pdf"/);
});

test("a cite to a region alone says which region, so several on one picture are told apart", async () => {
  const regions = data.replace('cites: [{ file: await keep("photo.jpg"), look: lookSite.key }]', 'cites: [{ file: await keep("photo.jpg"), xywh: "percent:10,20,30,15", look: lookSite.key }, { file: "photo.jpg", xywh: "pixel:5,6,70,80", look: lookSite.key }]');
  assert.notEqual(regions, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, regions, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  assert.match(html, /href="photo\.jpg#xywh=percent:10,20,30,15" data-look="[0-9a-f]{64}">box 10,20,30,15<\/a>/);
  assert.match(html, /href="photo\.jpg#xywh=pixel:5,6,70,80" data-look="[0-9a-f]{64}">box px 5,6,70,80<\/a>/);
});

test("a document page takes its look from a row's cite as well as a finding's, or from its own data", async () => {
  const byRow = data
    .replace(/  notChecked: \[[^\n]*\n/, "  notChecked: [],\n")
    .replace('cites: [{ file: "contract.pdf", page: 3, xywh: "percent:7,6,70,4", look: lookPage.key }] }', 'cites: [{ file: "contract.pdf", look: lookPage.key }] }')
    .replace("  notChecked:", '  rows: [{ id: "p3", label: "Page 3", text: "The rule is set here.", thumb: await thumb("frames/contract-p3.jpg", "p3-thumb"), cites: [{ file: "contract.pdf", page: 3, look: lookPage.key }] }],\n  notChecked:');
  assert.notEqual(byRow, data);
  onDisk = "other";
  const { result, keys } = await run([helpers, assets, looking, byRow, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.match(HTML(), new RegExp(`<a class="cite" href="contract\\.pdf#page=3" data-look="${keys[1]}">open at p\\. 3</a>`));
  const own = byRow.replace('{ n: 3, src: page3,', `{ n: 3, look: lookPage.key, src: page3,`).replace('cites: [{ file: "contract.pdf", page: 3, look: lookPage.key }] }],', 'cites: [{ file: "contract.pdf", look: lookPage.key }] }],');
  assert.notEqual(own, byRow);
  const alone = await run([helpers, assets, looking, own, ground, render, check]);
  assert.ok(alone.result.ok, alone.result.ok ? "" : alone.result.error.message);
});

test("two documents are two entries of documents: each embedded page takes the look cited for its own document's page, with its file named", async () => {
  fs.copyFileSync(path.join(cwd, "contract.pdf"), path.join(cwd, "other.pdf"));
  const two = data
    .replace("\nconst report = {", '\nconst otherPage = await pdfPage("other.pdf", 3, "other-p3");\nconst lookOther = await look(`report/${otherPage}`, "other.pdf#page=3", "What else is on this page?");\nconst report = {')
    .replace(/(  documents: \[\{[^\n]*)\}\],\n/, '$1}, { id: "other", file: await keep("other.pdf"), pages: [{ n: 3, src: otherPage }] }],\n')
    .replace("  notChecked:", '  rows: [{ id: "o3", label: "Other, page 3", text: "Another document.", thumb: await thumb("talk.mp4", "o3-thumb", { t: 3 }), cites: [{ file: "other.pdf", page: 3, look: lookOther.key }] }, { id: "p3", label: "Page 3", text: "The rule is set here.", thumb: await thumb("frames/contract-p3.jpg", "p3-thumb"), cites: [{ file: "contract.pdf", page: 3, look: lookPage.key }] }],\n  notChecked:');
  assert.notEqual(two, data);
  assert.ok(two.includes('id: "other"') && two.includes("rows:"), "both edits applied");
  onDisk = "other";
  const { result, keys } = await run([helpers, assets, looking, two, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(keys.length, 4);
  const html = HTML();
  assert.match(html, new RegExp(`<figure class="docpage" id="contract-p3"><header><span class="n">contract\\.pdf, p\\. 3</span><a class="cite" href="contract\\.pdf#page=3" data-look="${keys[1]}">open at p\\. 3</a>`), "the contract's page carries the contract's look");
  assert.match(html, new RegExp(`<figure class="docpage" id="other-p3"><header><span class="n">other\\.pdf, p\\. 3</span><a class="cite" href="other\\.pdf#page=3" data-look="${keys[3]}">open at p\\. 3</a>`), "and the other's page its own");
  assert.match(html, /<h2>The documents, with their marks<\/h2>/);
});

test("a cite of a page of a document needs that page embedded: crops alone are refused, and so is a second document that is not embedded", async () => {
  const cropsOnly = data.replace(/  documents: \[\{[^\n]*\n/, "");
  assert.notEqual(cropsOnly, data);
  onDisk = "other";
  const gap = await run([helpers, assets, looking, cropsOnly, ground, render, check]);
  assert.ok(!gap.result.ok);
  assert.match(gap.result.error.message, /contract\.pdf page 3 is cited but no embedded page shows it: add it to documents with its marks, and a crop of each mark in its finding/);
  const second = data.replace("  notChecked:", '  rows: [{ id: "o3", label: "Other", text: "Another document.", thumb: await thumb("talk.mp4", "o3-thumb", { t: 3 }), cites: [{ file: "other.pdf", page: 3, look: lookTalk.key }] }],\n  notChecked:').replace('outside: ["talk.mp4"]', 'outside: ["talk.mp4", "other.pdf"]');
  assert.notEqual(second, data);
  const open = await run([helpers, assets, looking, second, ground, render, check]);
  assert.ok(!open.result.ok);
  assert.match(open.result.error.message, /other\.pdf page 3 is cited but no embedded page shows it/);
  const embedded = await run([helpers, assets, looking, data, ground, render, check]);
  assert.ok(embedded.result.ok, embedded.result.ok ? "" : embedded.result.error.message);
});

test("rich by default: every finding shows a picture or a clip, a document mark has a close crop whose box is the mark, and no picture is shown twice", async () => {
  await built();
  const html = HTML();
  const findings = [...html.matchAll(/<(article|details) class="finding[^"]*" id="f-([a-z-]+)"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => ({ id: m[2], block: m[3] }));
  assert.deepEqual(findings.map((f) => f.id).sort(), ["chart", "contract", "site"], "the routine finding too");
  for (const f of findings) assert.match(f.block, /<img src="frames\/|<video /, `finding ${f.id} shows its evidence`);
  assert.match(findings.find((f) => f.id === "chart").block, /<video controls[\s\S]*<img src="frames\/talk-chart\.jpg"|<img src="frames\/talk-chart\.jpg"[\s\S]*<video controls/, "a film: the frame and the clip");
  assert.match(html, /<details class="finding routine" id="f-site"[^>]*>[\s\S]*<img src="frames\/site-photo\.jpg"[\s\S]*<figcaption>[^<]{12,}<\/figcaption>/, "a photo with its caption, inside the fold");
  const shown = attrs(html, "src").filter((ref) => ref.startsWith("frames/"));
  assert.equal(new Set(shown).size, shown.length, "no picture twice");
  // The document mark: its finding holds a crop, tied to the mark by data-mark, with the mark's box in the crop.
  const crop = /<figure class="pic" data-mark="mark-rule"><div class="sheet"><img src="(frames\/contract-rule\.jpg)"[^>]*><div class="mark[^"]*" id="crop-rule" data-xywh="percent:([\d.,]+)"/.exec(html);
  assert.ok(crop, "the crop of the rule, with its box");
  assert.ok(html.includes('id="mark-rule"'), "and the mark itself on the embedded page");
  const [bx, by, bw, bh] = crop[2].split(",").map(Number);
  assert.ok(bx >= 0 && by >= 0 && bw > 0 && bh > 0 && bx + bw <= 100 && by + bh <= 100, "the box is inside the crop");
  // Pixel proof: the region the box marks in the crop is the region the mark marks on the page (7,6,70,4 percent of it).
  const page = sharp(path.join(cwd, "report", "frames", "contract-p3.jpg")), cropped = sharp(path.join(cwd, "report", crop[1]));
  const [pm, cm] = [await page.metadata(), await cropped.metadata()];
  const region = (meta, image, [x, y, w, h]) => image.clone().extract({ left: Math.round(meta.width * x / 100), top: Math.round(meta.height * y / 100), width: Math.max(1, Math.round(meta.width * w / 100)), height: Math.max(1, Math.round(meta.height * h / 100)) }).greyscale().resize(560, 40, { fit: "fill" }).raw().toBuffer();
  const [fromPage, fromCrop] = [await region(pm, page, [7, 6, 70, 4]), await region(cm, cropped, [bx, by, bw, bh])];
  const diff = fromPage.reduce((n, v, i) => n + Math.abs(v - fromCrop[i]), 0) / fromPage.length;
  assert.ok(diff < 14, `the crop's box shows what the page's mark shows (mean difference ${diff.toFixed(1)})`);
  assert.ok(cm.width <= 900 && cm.width >= 480, `a crop of ${cm.width} px`);
  assert.ok(sizeOf(crop[1]) <= 700_000);
  assert.ok(all(path.join(cwd, "report")).reduce((n, f) => n + fs.statSync(f).size, 0) < 2_000_000, "the rich sketch is far inside the folder budget");
});

test("crop() frames a mark with room around it, clamped to the picture, and the box in the crop is the mark", async () => {
  onDisk = "other";
  const marks = ["7,6,70,4", "0,0,100,100", "95,95,5,5", "0,0,3,3", "40,50,20,1", "50,0,10,100", "12.5,33.3,7.7,2.2"];
  const { result } = await run([helpers, assets, `return ${JSON.stringify(marks)}.map((at) => [at, around(at)]);`]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  for (const [at, { from: [cx, cy, cw, ch], box }] of result.value) {
    const [x, y, w, h] = at.split(",").map(Number), [bx, by, bw, bh] = box.split(",").map(Number);
    assert.ok(cx >= 0 && cy >= 0 && cw > 0 && ch > 0 && cx + cw <= 100.0001 && cy + ch <= 100.0001, `${at}: the crop is inside the picture`);
    assert.ok(bx >= 0 && by >= 0 && bw > 0 && bh > 0 && bx + bw <= 100 && by + bh <= 100, `${at}: the box ${box} is inside the crop`);
    for (const [name, got, want] of [["x", cx + (bx * cw) / 100, x], ["y", cy + (by * ch) / 100, y], ["w", (bw * cw) / 100, w], ["h", (bh * ch) / 100, h]]) assert.ok(Math.abs(got - want) < 0.05, `${at}: the box maps back to the mark's ${name} (${got} against ${want})`);
    assert.ok(cx <= x && cy <= y && cx + cw >= x + w - 0.0001 && cy + ch >= y + h - 0.0001, `${at}: the crop holds the mark`);
  }
});

test("a thumbnail is a small picture of a row's evidence, from a moment of a film or from a picture of the folder", async () => {
  onDisk = "other";
  const { result } = await run([helpers, assets, 'await pdfPage("contract.pdf", 3, "p3"); return [await thumb("talk.mp4", "t-film", { t: 12 }), await thumb("frames/p3.jpg", "t-page")];']);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.deepEqual(result.value, ["frames/t-film.jpg", "frames/t-page.jpg"]);
  for (const file of result.value) {
    const meta = await sharp(path.join(cwd, "report", file)).metadata();
    assert.equal(meta.width, 240, file);
    assert.ok(sizeOf(file) < 40_000, `${file}: ${sizeOf(file)} bytes`);
  }
  const at12 = path.join(cwd, ".thumb-ref.jpg");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "12", "-i", path.join(cwd, "talk.mp4"), "-frames:v", "1", "-vf", "scale=240:-2", "-q:v", "8", at12]);
  assert.ok(psnr(path.join(cwd, "report", "frames", "t-film.jpg"), at12) > 30, "the thumbnail is the film's moment");
});

test("the skill's check refuses a finding with no picture or clip, a row with no thumbnail, a document mark with no crop and a picture shown twice", async () => {
  const bare = data.replace(/      pics: \[\{ src: site,[^\n]*\n/, "");
  assert.notEqual(bare, data);
  onDisk = "other";
  const none = await run([helpers, assets, looking, bare, ground, render, check]);
  assert.ok(!none.result.ok);
  assert.match(none.result.error.message, /finding site shows no picture or clip: show its evidence/);
  const rows = data.replace("  notChecked:", '  rows: [{ id: "m1", label: "Seconds 0 to 20", text: "The chart is on the screen.", cites: [{ file: "talk.mp4", t: [0, 20], look: lookTalk.key }] }],\n  notChecked:');
  assert.notEqual(rows, data);
  const nothumb = await run([helpers, assets, looking, rows, ground, render, check]);
  assert.ok(!nothumb.result.ok);
  assert.match(nothumb.result.error.message, /row m1 has no thumbnail/);
  const uncropped = data.replace(' mark: "mark-rule",', "");
  assert.notEqual(uncropped, data);
  const nocrop = await run([helpers, assets, looking, uncropped, ground, render, check]);
  assert.ok(!nocrop.result.ok);
  assert.match(nocrop.result.error.message, /the mark mark-rule has no close crop in its finding/);
  await refuses(swap("</main>", '<figure class="pic"><img src="frames/site-photo.jpg" alt="again"><figcaption>The same photo twice.</figcaption></figure></main>'), /a picture is shown twice: drop the duplicate/);
});

test("when the folder is over budget the check names the largest files", async () => {
  await refuses('await sh("head -c 8500000 /dev/zero > report/clips/huge.bin");', /report\/ is over 8000000 bytes; the largest files:\n8500000 report\/clips\/huge\.bin/);
});

test("the skill's check refuses markdown in any visible text of the page, names the element, and lets code and pre hold it", async () => {
  await refuses(swap("</main>", "<p>**official seal** is present</p></main>"), /<p> carries markdown \("\*\*"\): write your own plain sentence/);
  await refuses(swap("The tallest bar", "**The tallest bar**"), /<figcaption> carries markdown \("\*\*"\)/);
  await refuses(swap("</main>", "<p>### Description of the seal</p></main>"), /<p> carries markdown \("##"\)/);
  await refuses(swap("</main>", "<p>Shown:\n* **Text:** a seal</p></main>"), /<p> carries markdown/);
  await refuses(swap("</main>", "<p>the `seal` is round</p></main>"), /<p> carries markdown \("`"\)/);
  await refuses(swap("</main>", "<p>Seen:\n# Heading</p></main>"), /<p> carries markdown/);
  await refuses(swap("<h3>The chart shows", "<h3>**The chart** shows"), /<h3> carries markdown \("\*\*"\)/);
  const evidence = data.replace(/why: "Page 3 sets[^"]*",/, 'why: "**seal** of the state and\\n* **outer text:** none",');
  assert.notEqual(evidence, data);
  onDisk = "other";
  const pasted = await run([helpers, assets, looking, evidence, ground, render, check]);
  assert.ok(!pasted.result.ok);
  assert.match(pasted.result.error.message, /<p> carries markdown \("\*\*"\)/, "an evidence paragraph pasted from an answer is refused");
  // Code and pre are exempt, a lone * or # inside a sentence is not markdown, and CSS (which holds * selectors) is not text.
  const fine = await doctored(swap("</main>", "<pre>**bold** and `tick`</pre><p>Use <code>## heading</code> in markdown; 5 * 3 is 15 and item #2 is next.</p></main>"));
  assert.ok(!fine.result.ok && !/carries markdown/.test(fine.result.error.message), "markdown in code and pre, and a lone * or #, is not flagged; the only problem is the page not being what the data renders");
});

test("what was not checked lists only what no look covered, each item a file, its pages or seconds and a reason; the section is left out when nothing is", async () => {
  await built();
  const html = HTML();
  assert.match(html, /<section id="not-checked"><h2>Not checked<\/h2><ul class="limits"><li>talk\.mp4, 30 to 40 s: not looked at<\/li><li>contract\.pdf, pages 1, 2, 4: not looked at<\/li><\/ul><\/section>\s*<\/main>/);
  const none = data.replace(/  notChecked: \[[^\n]*\n/, "  notChecked: [],\n");
  assert.notEqual(none, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, none, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.ok(!HTML().includes("not-checked"), "no list, no section");
});

test("the check refuses an item of not-checked that a look of the run covers: a page it looked at, a window its look falls in, a file it looked at", async () => {
  const listed = async (items, extra = "") => {
    const variant = data.replace(/  notChecked: \[[^\n]*\n/, `  notChecked: ${JSON.stringify(items)},\n`).replace("\nconst report = {", `\n${extra}\nconst report = {`);
    assert.notEqual(variant, data);
    onDisk = "other";
    return run([helpers, assets, looking, variant, ground, render, check]);
  };
  const refused = async (items, pattern, extra) => { const { result } = await listed(items, extra); assert.ok(!result.ok, JSON.stringify(items)); assert.match(result.error.message, pattern); };
  const accepted = async (items, extra) => { const { result } = await listed(items, extra); assert.ok(result.ok, result.ok ? "" : result.error.message); };
  await refused([{ file: "contract.pdf", pages: [2, 3], why: "not looked at" }], /contract\.pdf, pages 2, 3: listed as not checked, but a look of this run covers it: take it out of the list/);
  await refused([{ file: "talk.mp4", t: [20, 30], why: "not looked at" }], /talk\.mp4, 20 to 30 s: listed as not checked, but a look of this run covers it/);
  await refused([{ file: "photo.jpg", why: "not looked at" }], /photo\.jpg, the whole file: listed as not checked, but a look of this run covers it/);
  await refused([{ file: "contract.pdf", pages: [2], why: "not looked at" }], /contract\.pdf, page 2: listed as not checked, but a look of this run covers it/, 'cover("contract.pdf#page=2");   // a look the run made earlier');
  await accepted([{ file: "talk.mp4", t: [26, 40], why: "out of budget" }, { file: "contract.pdf", pages: [1, 2, 4], why: "could not be read" }, { file: "other.pdf", why: "not looked at" }]);
  await accepted([{ file: "talk.mp4", t: [0, 18], why: "not looked at" }, { file: "talk.mp4", t: [30, 40], why: "not looked at" }], "");
});

test("an item of not-checked that states a finding or an absence, or is not an item, is refused: the reason is one of a short list", async () => {
  const listed = async (items) => {
    const variant = data.replace(/  notChecked: \[[^\n]*\n/, `  notChecked: ${JSON.stringify(items)},\n`);
    onDisk = "other";
    return run([helpers, assets, looking, variant, ground, render, check]);
  };
  for (const [item, shown] of [
    [{ file: "contract.pdf", pages: [2], why: "page 2 has no seal" }, 'page 2 has no seal'],
    ["Pages 2 and 4 do not contain the primary marks.", "Pages 2 and 4"],
    [{ file: "contract.pdf", pages: [2], t: [0, 5], why: "not looked at" }, "contract.pdf"],
    [{ pages: [2], why: "not looked at" }, "pages"],
    [{ file: "talk.mp4", t: [30, 20], why: "not looked at" }, "talk.mp4"],
    [{ file: "contract.pdf", pages: [], why: "not looked at" }, "contract.pdf"],
    [{ file: 123, why: "not looked at" }, "123"],
    [{ file: "", why: "not looked at" }, "file"],
    [{ file: "contract.pdf", pages: [0], why: "not looked at" }, "contract.pdf"],
    [{ file: "contract.pdf", pages: [1.5], why: "not looked at" }, "contract.pdf"],
    [{ file: "talk.mp4", t: [-5, -1], why: "not looked at" }, "talk.mp4"],
    [{ file: "talk.mp4", t: [1, Infinity], why: "not looked at" }, "talk.mp4"],
    [{ file: "talk.mp4", t: ["1", "9"], why: "not looked at" }, "talk.mp4"],
  ]) {
    const { result } = await listed([item]);
    assert.ok(!result.ok, JSON.stringify(item));
    assert.match(result.error.message, /is not an item of notChecked: \{ file, pages or t: \[from, to\], why \}, with why one of not looked at, out of budget, could not be read; a finding or an absence is not listed here/);
    assert.ok(result.error.message.includes(shown.slice(0, 20)) || ["pages", "file"].includes(shown), `names ${shown}`);
  }
});

test("cover() reads a page range and a file name with a # in it, so a page of a range, or of such a file, is covered and cannot be listed as not checked", async () => {
  fs.copyFileSync(path.join(cwd, "contract.pdf"), path.join(cwd, "contract#2?draft.pdf"));
  const listed = async (items, extra) => {
    const variant = data.replace(/  notChecked: \[[^\n]*\n/, `  notChecked: ${JSON.stringify(items)},\n`).replace("\nconst report = {", `\n${extra}\nconst report = {`);
    onDisk = "other";
    return run([helpers, assets, looking, variant, ground, render, check]);
  };
  const range = await listed([{ file: "other.pdf", pages: [3], why: "not looked at" }], 'cover("other.pdf#page=1-4");');
  assert.ok(!range.result.ok);
  assert.match(range.result.error.message, /other\.pdf, page 3: listed as not checked, but a look of this run covers it/, "page 3 is in 1-4");
  const outside = await listed([{ file: "other.pdf", pages: [5, 6], why: "not looked at" }], 'cover("other.pdf#page=1-4");');
  assert.ok(outside.result.ok, outside.result.ok ? "" : outside.result.error.message);
  const hash = await listed([{ file: "contract#2?draft.pdf", pages: [2], why: "not looked at" }], 'cover("contract#2?draft.pdf#page=2");');
  assert.ok(!hash.result.ok);
  assert.match(hash.result.error.message, /contract#2\?draft\.pdf, page 2: listed as not checked, but a look of this run covers it/, "the file name keeps its #");
  const sibling = await listed([{ file: "contract", pages: [2], why: "not looked at" }], 'cover("contract#2?draft.pdf#page=2");');
  assert.ok(sibling.result.ok, "a file called contract is another file, and was not looked at");
  const seconds = await listed([{ file: "talk.mp4", t: [5, 8], why: "not looked at" }], 'cover("talk.mp4#t=4,9&xywh=percent:1,2,3,4");');
  assert.ok(!seconds.result.ok);
  assert.match(seconds.result.error.message, /talk\.mp4, 5 to 8 s: listed as not checked/);
});

test("the grounding step asks Jev one text judgment for each finding, row and the answer: no image, the texts as claims, what the cited looks read as evidence", async () => {
  onDisk = "other";
  const { result, judged } = await run(pieces);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(jev.requests.length, 4, "three findings and the answer");
  assert.equal(judged.length, 4, "each filed as a look");
  for (const { params } of jev.requests) {
    assert.deepEqual(Object.keys(params.state).sort(), ["claims", "evidence"], "the texts and the evidence, no images");
    assert.deepEqual(params.assets, {}, "no image goes with it");
    assert.deepEqual(Object.keys(params.questions), Object.keys(params.state.claims), "one question for each text");
    assert.ok(Object.values(params.questions).every((q) => q.type === "noul" && /^Does `evidence` state every name, time and number in `claims\.t\d+`\?/.test(q.instructions)));
  }
  const [chart, contract, site, answer] = jev.requests.map((r) => r.params.state);
  assert.deepEqual(Object.values(chart.claims), ["The chart shows the second quarter highest", "On screen, the chart's second bar is the tallest, so the second quarter is the peak.", "The tallest bar is the second quarter's, the figure the answer rests on.", "A bar chart with the second bar tallest", "second quarter", "A moment later the chart has not changed, so the reading holds.", "The same chart a moment later", "The eight seconds around the chart."], "the title, the words, each caption and alt text, each box label and the clip's caption of the finding");
  assert.deepEqual(chart.evidence, ["The picture at talk.mp4#t=21.5 is shown.", "Cited: talk.mp4, seconds 21.5, region percent:61.2,40,12,9", "Cited: talk.mp4, seconds 18 to 26"], "what its look read, then where each cite points");
  assert.deepEqual(contract.evidence, ["The picture at contract.pdf#page=3 is shown.", "Cited: contract.pdf, page 3, region percent:7,6,70,4"]);
  assert.ok(Object.values(contract.claims).includes("the rule") && Object.values(contract.claims).includes("The rule, cropped from page 3"), "a mark's label and a picture's alt text are claims of its finding");
  assert.deepEqual(site.evidence, ["The picture at photo.jpg is shown.", "Cited: photo.jpg"]);
  assert.equal(answer.evidence.filter((e) => !e.startsWith("Cited: ")).length, 3, "the answer is judged against every look the report cites");
  assert.deepEqual(Object.values(answer.claims), ["The talk, the contract and the site", "Does the chart agree with the contract, and what does the site look like?", "Yes. The chart shows the second quarter highest, and page 3 of the contract sets the record-keeping rule the talk gave.", "Chart peak: second quarter", "Contract rule: page 3"], "the title, the question, the answer and its key points");
});

test("a row naming someone the cited looks never read is refused and the page is not written; the same row passes once a look it cites gives the name", async () => {
  const withRow = (text) => data.replace("  notChecked:", `  rows: [{ id: "m1", label: "Seconds 0 to 20", text: ${JSON.stringify(text)}, thumb: await thumb("talk.mp4", "m1-thumb", { t: 10 }), cites: [{ file: "talk.mp4", t: [0, 20], look: lookTalk.key }] }],\n  notChecked:`);
  onDisk = "other";
  const unread = await run([helpers, assets, looking, withRow("Steve Bales gave the go."), ground, render, check]);
  assert.ok(!unread.result.ok);
  assert.equal(unread.result.error.message.split("\n")[0], 'row m1: "Steve Bales gave the go." is not stated by what its cited looks read (0.03)');
  assert.match(unread.result.error.message, /Rewrite each from what the looks read, cite the look that states it, or drop it; then run the pieces again\.$/);
  assert.equal(unread.result.error.message.split("\n").length, 2, "only that row is named");
  assert.ok(!fs.existsSync(path.join(cwd, "report", "index.html")), "no page was written");
  eyesAlso = " The speaker is named Steve Bales.";
  try {
    const read = await run([helpers, assets, looking, withRow("Steve Bales gave the go."), ground, render, check]);
    assert.ok(read.result.ok, read.result.ok ? "" : read.result.error.message);
    assert.ok(fs.existsSync(path.join(cwd, "report", "index.html")));
  } finally { eyesAlso = ""; }
});

test("an unread name in a caption or the answer is refused too: every text the page shows is judged, not only the findings' words", async () => {
  onDisk = "other";
  const caption = data.replace("The tallest bar is the second quarter's, the figure the answer rests on.", "The tallest bar is at the Westinghouse Pavilion.");
  assert.notEqual(caption, data);
  const c = await run([helpers, assets, looking, caption, ground, render, check]);
  assert.ok(!c.result.ok);
  assert.match(c.result.error.message, /^finding chart: "The tallest bar is at the Westinghouse Pavilion\." is not stated by what its cited looks read \(0\.03\)/);
  const answer = data.replace("Yes. The chart shows", "Yes, per Margaret Hamilton. The chart shows");
  assert.notEqual(answer, data);
  const a = await run([helpers, assets, looking, answer, ground, render, check]);
  assert.ok(!a.result.ok);
  assert.match(a.result.error.message, /^the answer: "Yes, per Margaret Hamilton\. The chart shows/);
});

test("what was heard is evidence only in the transcribe look: a said name passes when its row cites that look, and fails when it cites only a picture", async () => {
  const heard = (look) => data.replace(/  notChecked: \[[^\n]*\n/, "  notChecked: [],\n").replace("\nconst report = {", '\nconst said1 = await hear("talk.mp4");   // the whole recording was heard, so none of it is left unchecked\nconst report = {').replace("  notChecked:", `  rows: [{ id: "h1", label: "Seconds 0 to 9", text: "Steve Bales gave the go.", thumb: await thumb("talk.mp4", "h1-thumb", { t: 3 }), cites: [{ file: "talk.mp4", t: [0, 9], look: ${look} }] }],\n  notChecked:`);
  onDisk = "other";
  const cited = await run([helpers, assets, looking, heard("said1.key"), ground, render, check]);
  assert.ok(cited.result.ok, cited.result.ok ? "" : cited.result.error.message);
  const judgedHeard = jev.requests.map((r) => r.params.state).find((s) => Object.values(s.claims).includes("Steve Bales gave the go."));
  assert.deepEqual(judgedHeard.evidence, ["Steve Bales gave the go at nine minutes", "Cited: talk.mp4, seconds 0 to 9"], "the transcript is its evidence, and the address its cite names");
  const picture = await run([helpers, assets, looking, heard("lookTalk.key"), ground, render, check]);
  assert.ok(!picture.result.ok);
  assert.match(picture.result.error.message, /^row h1: "Steve Bales gave the go\." is not stated by what its cited looks read/);
});

test("a text edited after its judgment is refused by the check", async () => {
  onDisk = "other";
  await refuses('report.findings[0].why = "Edited after the judgment.";', /finding chart: "Edited after the judgment\." was not judged as written against what its looks read: run the grounding step again/);
  await refuses('report.answer = "The answer, changed.";', /the answer: "The answer, changed\." was not judged as written/);
});

test("a text whose cited looks read nothing has no evidence and is refused", async () => {
  onDisk = "other";
  const silent = data.replace("const rule = await crop(", "said.delete(lookSite.key);   // a look whose answer the run does not hold\nconst rule = await crop(");
  assert.notEqual(silent, data);
  const { result } = await run([helpers, assets, looking, silent, ground, render, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /^finding site: "The site" is not stated by what its cited looks read \(0\.00\)/);
});

test("a recording the run heard is covered: it cannot be listed as not checked, and a heard window covers its seconds", async () => {
  const withHear = (extra, items) => data.replace(/  notChecked: \[[^\n]*\n/, `  notChecked: ${JSON.stringify(items)},\n`).replace("\nconst report = {", `\n${extra}\nconst report = {`);
  onDisk = "other";
  const whole = await run([helpers, assets, looking, withHear('await hear("talk.mp4");', [{ file: "talk.mp4", t: [30, 40], why: "not looked at" }]), ground, render, check]);
  assert.ok(!whole.result.ok);
  assert.match(whole.result.error.message, /talk\.mp4, 30 to 40 s: listed as not checked, but a look of this run covers it/);
  const window = await run([helpers, assets, looking, withHear('await hear("talk.mp4", "talk.mp4#t=30,36");', [{ file: "talk.mp4", t: [33, 35], why: "not looked at" }]), ground, render, check]);
  assert.ok(!window.result.ok);
  assert.match(window.result.error.message, /talk\.mp4, 33 to 35 s: listed as not checked/);
  const beyond = await run([helpers, assets, looking, withHear('await hear("talk.mp4", "talk.mp4#t=30,36");', [{ file: "talk.mp4", t: [37, 40], why: "not looked at" }]), ground, render, check]);
  assert.ok(beyond.result.ok, beyond.result.ok ? "" : beyond.result.error.message);
});

test("hear() takes the source address of audio already cut as its fragment and preserves its file name, and refuses a bare window: cut first", async () => {
  onDisk = "other";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "30", "-i", path.join(cwd, "talk.mp4"), "-t", "6", path.join(cwd, "chunk.wav")]);
  const cut = await run([helpers, assets, looking, 'await hear("chunk.wav", "talk.mp4#t=30,36"); return covered;']);
  assert.ok(cut.result.ok, cut.result.ok ? "" : cut.result.error.message);
  assert.deepEqual(cut.result.value, [{ file: "talk.mp4", t: [30, 36] }], "what was heard is talk.mp4's 30 to 36 s, not chunk.wav");
  const bare = await run([helpers, assets, looking, 'await hear("talk.mp4", "t=30,36");']);
  assert.ok(!bare.result.ok);
  assert.match(bare.result.error.message, /t=30,36 is not the source address of talk\.mp4: cut the audio first, then pass its source as file#t=from,to/);
});

test("every text the page shows is judged, not only the findings' words: a name in the title, the question, a row's label or a picture's alt text is refused", async () => {
  onDisk = "other";
  const named = (change) => run([helpers, assets, looking, change, ground, render, check]);
  const row = data.replace("  notChecked:", '  rows: [{ id: "m1", label: "Steve Bales", text: "The chart is on the screen.", thumb: await thumb("talk.mp4", "m1-thumb", { t: 10 }), cites: [{ file: "talk.mp4", t: [0, 20], look: lookTalk.key }] }],\n  notChecked:');
  const label = await named(row);
  assert.ok(!label.result.ok);
  assert.match(label.result.error.message, /^row m1: "Steve Bales" is not stated by what its cited looks read/, "the label is judged though the row's text is grounded");
  for (const [from, to, unit, shown] of [
    ['title: "The talk, the contract and the site"', 'title: "The talk of Margaret Hamilton"', "the answer", "The talk of Margaret Hamilton"],
    ['question: "Does the chart agree', 'question: "Did Margaret Hamilton agree', "the answer", "Did Margaret Hamilton agree"],
    ['alt: "A bar chart with the second bar tallest"', 'alt: "A bar chart at the Westinghouse Pavilion"', "finding chart", "A bar chart at the Westinghouse Pavilion"],
  ]) {
    const variant = data.replace(from, to);
    assert.notEqual(variant, data, from);
    const { result } = await named(variant);
    assert.ok(!result.ok, from);
    assert.ok(result.error.message.includes(`${unit}: "${shown}`), result.error.message.split("\n")[0]);
  }
});

test("the page is what the data renders: a text added to the page or the file by hand after the judgment is refused, whatever it says", async () => {
  await refuses(swap("The tallest bar", "The tallest bar at the Westinghouse Pavilion"), /report\/index\.html is not what the data renders: change the data \(the texts are judged\) and write the page again, never the page/);
  onDisk = "other";
  const byHand = await run([helpers, assets, looking, data, ground, render, 'await sh("printf %s \\"<p>Steve Bales was there.</p>\\" >> report/index.html");', check]);
  assert.ok(!byHand.result.ok);
  assert.match(byHand.result.error.message, /report\/index\.html is not what the data renders/);
  const same = await run([helpers, assets, looking, data, ground, render, check]);
  assert.ok(same.result.ok, same.result.ok ? "" : same.result.error.message);
});

test("a cite changed after the judgment is judged again: its address is part of the evidence, so the old verdict does not carry over", async () => {
  await refuses('report.findings[1].cites[0].page = 2;', /finding contract: "The contract sets the rule on page 3" was not judged as written against what its looks read: run the grounding step again/);
  await refuses('report.findings[0].cites[1].t = [19, 26];', /finding chart: "The chart shows the second quarter highest" was not judged as written/);
});

test("the check renders the page again in a directory of its own and removes only that: a .check directory the workspace already holds is left alone", async () => {
  fs.mkdirSync(path.join(cwd, ".check"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".check", "index.html"), "the workspace's own file");
  const own = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "render-parent-"));   // the shell's TMPDIR: only what this run makes is looked at
  bashEnv = { ...process.env, TMPDIR: own };
  onDisk = "other";
  try {
    const { result } = await run(pieces);
    assert.ok(result.ok, result.ok ? "" : result.error.message);
    assert.equal(fs.readFileSync(path.join(cwd, ".check", "index.html"), "utf8"), "the workspace's own file");
    assert.deepEqual(fs.readdirSync(own), [], "no render directory is left behind");
  } finally { bashEnv = process.env; fs.rmSync(own, { recursive: true, force: true }); fs.rmSync(path.join(cwd, ".check"), { recursive: true, force: true }); }
});

test("Jev's typed answers in a cited look reach the evidence as words: a noul as yes or no with its probability, a choice, a score and a box, each with its question and the picture it was asked about", async () => {
  onDisk = "other";
  const asked = `const looked = await decide("report/" + page3, "contract.pdf#page=3", {
    seal: { type: "noul", instructions: "Is there a seal on images[0].image?" },
    kind: { type: "choice", instructions: "What is images[0].image?", criteria: { rules: "Rules.", other: "Anything else." } },
    legible: { type: "score", instructions: "How legible is images[0].image?", criteria: ["unreadable", "readable"] },
    where: { type: "box", instructions: "the title of images[0].image" } });
  return [said.get(looked.key), looked.answers.seal.noul];`;
  const { result } = await run([helpers, assets, looking, `const page3 = await pdfPage("contract.pdf", 3, "contract-p3");\n${asked}`]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const [words, noul] = result.value;
  assert.equal(noul, 0.02);
  assert.deepEqual(words.split("\n"), [
    'Jev, asked "Is there a seal on contract.pdf#page=3?": no (0.02)',
    'Jev, asked "What is contract.pdf#page=3?": rules (0.9)',
    'Jev, asked "How legible is contract.pdf#page=3?": score 1 (readable)',
    'Jev, asked "the title of contract.pdf#page=3": located at contract.pdf#page=3&xywh=percent:50,25,50,50 (confidence 0.9)',
  ], "a no, a choice, a score and a place, as words with the source in place of images[0].image");
});

test("an absence claim is grounded by a cited Jev no-answer and refused when no such look is cited: the test copy's marks removed is stated, not dropped", async () => {
  const absence = (cite) => data
    .replace("\nconst report = {", '\nconst sealLook = await decide("report/" + page3, "contract.pdf#page=3", { seal: { type: "noul", instructions: "Is there a seal on `images[0].image`?" } });\nconst report = {')
    .replace("  notChecked:", `  rows: [{ id: "gone", label: "Page 3", text: "The seal is absent on page 3.", thumb: await thumb("frames/contract-p3.jpg", "gone-thumb"), cites: [{ file: "contract.pdf", page: 3, look: ${cite} }] }],\n  notChecked:`);
  onDisk = "other";
  const stated = await run([helpers, assets, looking, absence("sealLook.key"), ground, render, check]);
  assert.ok(stated.result.ok, stated.result.ok ? "" : stated.result.error.message);
  const judgedAbsence = jev.requests.map((r) => r.params.state).find((st) => st.claims && Object.values(st.claims).includes("The seal is absent on page 3."));
  assert.ok(judgedAbsence.evidence.includes('Jev, asked "Is there a seal on contract.pdf#page=3?": no (0.02)'), "Jev's no reaches the judge as words");
  const unsupported = await run([helpers, assets, looking, absence("lookPage.key"), ground, render, check]);
  assert.ok(!unsupported.result.ok);
  assert.match(unsupported.result.error.message, /^row gone: "The seal is absent on page 3\." is not stated by what its cited looks read \(0\.03\)/, "cited only to a look that read the page, nothing states the absence");
});

test("a frame, a poster or a thumbnail of a film that is almost black is refused, with its mean brightness; the same film a second or two on passes", async () => {
  const withFrame = (at) => data.replace(/\n      pics: \[\n        \{ src: talk,/, `\n      pics: [\n        { src: dark, alt: "A moment of the film", caption: "The film's opening moment, as it begins." },\n        { src: talk,`).replace("\nconst report = {", `\nconst dark = await frame("opens-black.mp4", ${at}, "opening");\nconst report = {`);
  onDisk = "other";
  const black = await run([helpers, assets, looking, withFrame(1), ground, render, check]);
  assert.ok(!black.result.ok);
  assert.match(black.result.error.message, /frames\/opening\.jpg is almost black \(mean brightness 0 of 255, under 16\): cut another moment of the film, a second or two on/);
  const moving = await run([helpers, assets, looking, withFrame(6), ground, render, check]);
  assert.ok(moving.result.ok, moving.result.ok ? "" : moving.result.error.message);
});

test("a poster and a thumbnail are measured too: a clip that opens on black has a black poster, and a row's thumbnail of a black moment is refused", async () => {
  onDisk = "other";
  const poster = await refuses('await sh("ffmpeg -v error -y -f lavfi -i color=c=black:s=160x120 -frames:v 1 report/frames/talk-chart-poster.jpg");', /frames\/talk-chart-poster\.jpg is almost black/);
  const rows = data.replace("  notChecked:", '  rows: [{ id: "m1", label: "Seconds 0 to 20", text: "The film opens.", thumb: await thumb("opens-black.mp4", "m1-thumb", { t: 2 }), cites: [{ file: "talk.mp4", t: [0, 20], look: lookTalk.key }] }],\n  notChecked:');
  assert.notEqual(rows, data);
  const { result } = await run([helpers, assets, looking, rows, ground, render, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /frames\/m1-thumb\.jpg is almost black/);
  const clipped = data.replace('clip("talk.mp4", 18, 26, "talk-chart")', 'clip("opens-black.mp4", 0, 3, "talk-chart")');
  assert.notEqual(clipped, data);
  const opening = await run([helpers, assets, looking, clipped, ground, render, check]);
  assert.ok(!opening.result.ok);
  assert.match(opening.result.error.message, /frames\/talk-chart-poster\.jpg is almost black/, "the poster is the window's opening frame, and the film opens on black");
});

test("a page, a crop and a photo are the document's or the photo's own: a dark one is not refused", async () => {
  onDisk = "other";
  const darkPhoto = data.replace('const site = await photo("photo.jpg", "site-photo");', 'const site = await photo("dark.jpg", "site-photo");');
  assert.notEqual(darkPhoto, data);
  const { result } = await run([helpers, assets, looking, darkPhoto, ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const darkThumb = data.replace("  notChecked:", '  rows: [{ id: "m1", label: "Seconds 0 to 20", text: "The photo is dark.", thumb: await thumb(await photo("dark.jpg", "dark-photo"), "m1-thumb"), cites: [{ file: "talk.mp4", t: [0, 20], look: lookTalk.key }] }],\n  notChecked:');
  const thumbed = await run([helpers, assets, looking, darkThumb, ground, render, check]);
  assert.ok(thumbed.result.ok, thumbed.result.ok ? "" : thumbed.result.error.message);
});

test("the page is made of the allowlist the recording format uses: an svg, a button, a math, a prefixed element, an on* handler, a srcdoc, a formaction, an xmlns attribute or a meta of another kind is refused, and the message names it", async () => {
  const cases = [
    ["<svg><circle r='1'/></svg>", /<svg> is not an element the page may use/],
    ["<button>go</button>", /<button> is not an element the page may use/],
    ["<math><mi>x</mi></math>", /<math> is not an element the page may use/],
    ["<x:script>1</x:script>", /<x:script> is not an element the page may use/],
    ['<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', /<noscript> is not an element the page may use/],
    ["<form action='x'></form>", /<form> is not an element the page may use/],
    ['<p onclick="x()">hi</p>', /onclick on <p> is not an attribute the page may use/],
    ["<p ONMOUSEOVER='x()'>hi</p>", /onmouseover on <p> is not an attribute the page may use/],
    ['<p srcdoc="x">hi</p>', /srcdoc on <p> is not an attribute the page may use/],
    ['<a formaction="x" href="photo.jpg">hi</a>', /formaction on <a> is not an attribute the page may use/],
    ['<p xmlns:x="y">hi</p>', /xmlns:x on <p> is not an attribute the page may use/],
    ['<meta name="description" content="x">', /<meta> only as charset or name="viewport"/],
    ['<meta http-equiv="refresh" content="0">', /<meta> only as charset or name="viewport"/],
    ['<meta charset="utf-8" content="x">', /<meta> only as charset or name="viewport"/],
  ];
  for (const [html, pattern] of cases) await refuses(swap("</main>", `${html}</main>`), pattern);
  await refuses(swap("</main>", '<!-- <script>x()</script> --></main>'), /the page holds a comment or a < that starts no element/);
  await refuses(swap("</main>", '<p title="a>b">hi</p></main>'), /a > stands outside any tag/);
});

test("a style attribute is read as CSS under the style element's rules, after its comments and escapes: url(), @import, data:, javascript:, expression(, behavior and -moz-binding are refused", async () => {
  for (const css of ["background:url(frames/talk-chart.jpg)", "background:u\\72l(frames/talk-chart.jpg)", "background:url/**/(frames/talk-chart.jpg)", "width:expression(alert(1))", "behavior:url(x.htc)", "-moz-binding:url(x)", "background:javascript:x()", "background:data:image/png;base64,AAAA", "@import 'x'"]) {
    await refuses(swap("</main>", `<div style="${css}">x</div></main>`), /the style attribute on <div> holds CSS the page may not use/);
  }
  // A browser reads a character reference before the CSS: u&#114;l( is url(.
  for (const css of ["background:u&#114;l(frames/talk-chart.jpg)", "background:&#x75;rl(frames/talk-chart.jpg)", "background:url&lpar;frames/talk-chart.jpg&rpar;", "background:url&#40;x&#41;", "width:1&percnt;"]) {
    await refuses(swap("</main>", `<div style="${css}">x</div></main>`), /the style attribute on <div> holds CSS the page may not use: no character reference/);
  }
  await refuses(swap("</style>", "@import 'x.css';</style>"), /the style element holds CSS the page may not use|runs code or loads/);
  await refuses(swap("</style>", "a{behavior:url(x.htc)}</style>"), /the style element holds CSS the page may not use/);
});

test("what the allowlist lets through is not refused: aria-*, data-*, loading, a mark's percentage style, the viewport meta and every element the skill's own page uses", async () => {
  // The page is not the render once edited, so the only refusal is that; none of the allowlist's messages is among them.
  const fine = await doctored(swap("</main>", '<p aria-hidden="true" data-note="x" lang="en" title="t">fine</p><div class="mark" data-xywh="percent:1,2,3,4" style="left:1%;top:2%;width:3%;height:4%"></div><details open><summary>s</summary><table><tr><td colspan="2">c</td></tr></table></details></main>'));
  assert.ok(!fine.result.ok);
  assert.ok(!/is not an element|is not an attribute|style attribute|style element|<meta>|stands outside/.test(fine.result.error.message), fine.result.error.message);
  const { result } = await run(pieces);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  for (const needle of ['aria-label="Answer"', 'loading="lazy"', 'data-xywh="percent:', 'style="left:', '<meta name="viewport"', '<meta charset="utf-8">']) assert.ok(html.includes(needle), `the template page has ${needle}`);
});

/** The sketch with one row, its thumbnail taken at the second of the look it is boxed on. */
const boxedRow = (boxes) => data.replace("  notChecked:", `  rows: [{ id: "m1", label: "Seconds 18 to 26", text: "The second bar is the tallest.", thumb: await thumb("talk.mp4", "m1-thumb", { t: 21.5 }), ${boxes === undefined ? "" : `boxes: ${boxes}, `}cites: [{ file: "talk.mp4", t: [18, 26], xywh: "percent:61.2,40,12,9", look: lookTalk.key }] }],\n  notChecked:`);

test("a row's boxes are drawn on its thumbnail, as marks with no label, and the page passes the check, the allowlist included", async () => {
  onDisk = "other";
  const { result, keys } = await run([helpers, assets, looking, boxedRow('[{ id: "m1-box", at: "61.2,40,12,9", look: lookTalk.key }, { id: "m1-box2", at: "10,20,30,15", look: lookTalk.key }]'), ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  const row = /<li class="row boxed" id="r-m1"[^>]*>([\s\S]*?)<\/li>/.exec(html)[1];
  assert.match(row, new RegExp(`^<div class="sheet thumb"><img src="frames/m1-thumb\\.jpg" alt="The second bar is the tallest\\." loading="lazy"><div class="mark right" id="m1-box" data-xywh="percent:61\\.2,40,12,9" data-look="${keys[0]}" style="left:61\\.2%;top:40%;width:12%;height:9%"></div><div class="mark" id="m1-box2" data-xywh="percent:10,20,30,15" data-look="${keys[0]}" style="left:10%;top:20%;width:30%;height:15%"></div></div>`), "the thumbnail is a small sheet carrying both marks");
  assert.ok(!/class="tag"/.test(row), "a mark on a thumbnail has no label link");
  assert.ok(!/<img class="thumb"/.test(row), "the image is inside the sheet");
  // The thumbnail is the film's frame at the boxed look's second.
  const same = path.join(cwd, ".thumb-ref.jpg");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "21.5", "-i", path.join(cwd, "talk.mp4"), "-frames:v", "1", "-vf", "scale=240:-2", "-q:v", "8", same]);
  assert.ok(psnr(path.join(cwd, "report", "frames", "m1-thumb.jpg"), same) > 30, "taken at the second of the boxed look");
  assert.match(html, /\.sheet\.thumb\{margin-top:0\}/, "the thumbnail's sheet is as small as the thumbnail");
});

test("a row without boxes renders as it did: an image with its class, no sheet, no mark", async () => {
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, boxedRow(undefined), ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const row = /<li class="row" id="r-m1"[^>]*>([\s\S]*?)<\/li>/.exec(HTML())[1];
  assert.match(row, /^<img class="thumb" src="frames\/m1-thumb\.jpg" alt="The second bar is the tallest\." loading="lazy"><span class="when">Seconds 18 to 26<\/span>/);
  assert.ok(!/sheet|mark/.test(row));
  const empty = await run([helpers, assets, looking, boxedRow("[]"), ground, render, check]);
  assert.ok(empty.result.ok);
  assert.match(/<li class="row" id="r-m1"[^>]*>([\s\S]*?)<\/li>/.exec(HTML())[1], /^<img class="thumb"/, "an empty list of boxes is no boxes");
});

test("a row's box is checked like any other: inside its picture, a look the run made, a unique id", async () => {
  onDisk = "other";
  const outside = await run([helpers, assets, looking, boxedRow('[{ id: "m1-box", at: "90,40,12,9", look: lookTalk.key }]'), ground, render, check]);
  assert.ok(!outside.result.ok);
  assert.match(outside.result.error.message, /percent:90,40,12,9 is not inside 0 to 100/);
  const stranger = await run([helpers, assets, looking, boxedRow(`[{ id: "m1-box", at: "10,40,12,9", look: "${"f".repeat(64)}" }]`), ground, render, check]);
  assert.ok(!stranger.result.ok);
  assert.match(stranger.result.error.message, /is no look this run made/);
  const twice = await run([helpers, assets, looking, boxedRow('[{ id: "mark-peak", at: "10,40,12,9", look: lookTalk.key }]'), ground, render, check]);
  assert.ok(!twice.result.ok);
  assert.match(twice.result.error.message, /two things on the page share an id/);
});

test("the skill teaches a boxed row (the thumbnail at the boxed look's second), a count as what was logged, and a row's text beyond its label", () => {
  for (const words of ["A row may carry `boxes`", "Take the thumbnail at the second of the boxed look", "the box and the frame must be the same moment", "with no label on them", 'boxes: [{ id: "m1-box"', "A count over rows is stated as what was logged", "never as the film's true total, unless every moment was looked at and the page says so", "says what the look saw beyond its label, not the label again"]) assert.ok(SKILL.replace(/\s+/g, " ").includes(words), `the skill says ${words}`);
});

/** What `data-ground` holds for each finding, row and the answer of the page: its texts' judge look and claim ids. */
const groundOf = (html) => Object.fromEntries([...html.matchAll(/<(?:article|details|li|section) [^>]*?\bid="([^"]*)"[^>]*?data-ground="([^"]*)"/g)].map((m) => [m[1], m[2]]));

test("every finding, row and the answer names the judge look that judged its texts: data-ground holds <look key>:tN for each text, and the look is one the judge filed", async () => {
  onDisk = "other";
  const { result, judged } = await run([helpers, assets, looking, boxedRow('[{ id: "m1-box", at: "61.2,40,12,9", look: lookTalk.key }]'), ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const grounds = groundOf(HTML());
  assert.deepEqual(Object.keys(grounds).sort(), ["answer", "f-chart", "f-contract", "f-site", "r-m1"]);
  for (const [id, value] of Object.entries(grounds)) {
    const entries = value.split(" ");
    assert.ok(entries.length >= 1 && entries.every((entry) => /^[0-9a-f]{64}:t\d+$/.test(entry) && Number(entry.split(":t")[1]) < entries.length), `${id}: ${value}`);   // a text said twice in a unit is one judgment, so one claim id may repeat
    assert.equal(new Set(entries.map((entry) => entry.split(":")[0])).size, 1, "one look judged a unit's texts");
    assert.ok(judged.includes(entries[0].split(":")[0]), `${id}'s look is a judge look the host filed`);
  }
  assert.equal(grounds["r-m1"].split(" ").length, 2, "a row's label and its text");
  assert.equal(grounds["f-chart"].split(" ").length, 8, "a finding's title, words, captions, alt texts, labels");
});

test("a verdict without a look key counts as not judged: a Map filled by the script, with bare numbers or no key, is refused", async () => {
  onDisk = "other";
  const made = (value) => `for (const unit of claimsOf(report)) for (const text of unit.texts) verdicts.set(verdictKey(unit, text), ${value});`;
  for (const value of ["0.95", "{ yes: 0.95 }", '{ yes: 0.95, look: "", claim: "t0" }', '{ yes: 0.95, look: "not-a-key", claim: "t0" }', `{ yes: 0.95, look: "${"a".repeat(63)}", claim: "t0" }`]) {
    const { result } = await run([helpers, assets, looking, data, ground.replace("await ground();", made(value)), render, check]);
    assert.ok(!result.ok, value);
    assert.match(result.error.message, /finding chart: "The chart shows the second quarter highest" was not judged as written against what its looks read: run the grounding step again/, value);
    assert.match(result.error.message, /the answer: .* was not judged as written/, "every unit, the answer too");
  }
  const keyed = await run([helpers, assets, looking, data, ground.replace("await ground();", made(`{ yes: 0.95, look: "${"a".repeat(64)}", claim: "t0" }`)), render, check]);
  assert.ok(keyed.result.ok, "a verdict with a look key is a judgment as far as the check can see; the take checker reads data-ground against the recording");
});

test("when Jev cannot be asked, the unit gets no verdict and is declared under Not checked, by count and id; it is never given one", async () => {
  onDisk = "other";
  jevFails = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
  try {
    const { result } = await run([helpers, assets, looking, data, ground, render, check]);
    assert.ok(result.ok, result.ok ? "" : result.error.message);
  } finally { jevFails = undefined; }
  const html = HTML();
  assert.match(html, /<section id="not-checked"><h2>Not checked<\/h2><ul class="limits">[\s\S]*<li>4 units: finding chart, finding contract, finding site, the answer: not judged: look_failed: Jev failed: 503 Service Unavailable<\/li>/);
  assert.deepEqual(Object.values(groundOf(html)), ["", "", "", ""], "no unit names a judge look");
  // The list must be exactly the units: a unit left out of it, or a judged unit put in it, is refused.
  jevFails = Object.assign(new Error("503 Service Unavailable"), { status: 503 });
  try {
    const left = await run([helpers, assets, looking, data, ground, 'report.notChecked = report.notChecked.map((n) => (n.units ? { ...n, units: n.units.filter((u) => u !== "finding site") } : n));', render, check]);
    assert.ok(!left.result.ok);
    assert.match(left.result.error.message, /finding site: "The site" was not judged as written/);
  } finally { jevFails = undefined; }
  const extra = await run([helpers, assets, looking, data, ground, 'report.notChecked.push({ units: ["finding chart"], why: "not judged: nothing" });', render, check]);
  assert.ok(!extra.result.ok);
  assert.match(extra.result.error.message, /finding chart is listed as not judged but was judged: take it out of the list/);
});

test("a request cap reached part way declares exactly the units after it: rows r2 to r12 and the answer, with the units before it judged", async () => {
  const many = data.replace("\nconst report = {", '\nconst manyRows = [];\nfor (let i = 1; i <= 12; i++) manyRows.push({ id: "r" + i, label: "Seconds 0 to 20", text: "The chart is on the screen.", thumb: await thumb("talk.mp4", "t" + i, { t: i }), cites: [{ file: "talk.mp4", t: [0, 20], look: lookTalk.key }] });\nconst report = {').replace("  notChecked:", "  rows: manyRows,\n  notChecked:");
  assert.notEqual(many, data);
  onDisk = "other";
  jevCap = 4; jevAsked = 0;   // the three findings and the first row
  try {
    const { result } = await run([helpers, assets, looking, many, ground, render, check]);
    assert.ok(result.ok, result.ok ? "" : result.error.message);
  } finally { jevCap = Infinity; }
  const html = HTML();
  assert.match(html, /<li>12 units: rows r2 to r12 \(11 rows\), the answer: not judged: look_failed: Jev failed: 429 the request cap was reached<\/li>/);
  const grounds = groundOf(html);
  assert.ok(grounds["f-chart"] && grounds["f-contract"] && grounds["f-site"] && grounds["r-r1"], "the units before the cap are judged and name their look");
  assert.deepEqual([grounds["r-r2"], grounds["r-r12"], grounds.answer], ["", "", ""], "the units after it name none");
  jevCap = 4; jevAsked = 0;
  try {
    const short = await run([helpers, assets, looking, many, ground, 'report.notChecked = report.notChecked.map((n) => (n.units ? { ...n, units: n.units.slice(1) } : n));', render, check]);
    assert.ok(!short.result.ok);
    assert.match(short.result.error.message, /row r2: "Seconds 0 to 20" was not judged as written/, "a unit left out of the list is refused");
  } finally { jevCap = Infinity; }
});

test("boxed thumbnails are about 10rem wide with the row's second and text aligned to the top beside them: the row says boxed, a row without boxes does not", async () => {
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, boxedRow('[{ id: "m1-box", at: "61.2,40,12,9", look: lookTalk.key }]'), ground, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  assert.match(html, /<li class="row boxed" id="r-m1" data-ground="[^"]*"><div class="sheet thumb">/);
  assert.match(html, /\.row\.boxed\{align-items:flex-start\}\.row\.boxed \.thumb\{width:10rem\}/);
  assert.match(html, /\.thumb\{width:6rem;/, "a row's plain thumbnail is as small as before");
  const plain = await run([helpers, assets, looking, boxedRow(undefined), ground, render, check]);
  assert.ok(plain.result.ok);
  assert.match(HTML(), /<li class="row" id="r-m1" data-ground="[^"]*"><img class="thumb"/, "a row without boxes keeps its class");
});

test("the skill says only vision.judge sets a verdict, what it could not judge goes under Not checked by count and id, text stays text, and a detail nobody asked for is read twice", () => {
  const flat = SKILL.replace(/\s+/g, " ");
  for (const words of ["A verdict comes only from `vision.judge`'s answer, and the script never sets one itself", "`data-ground`", "If Jev cannot be asked (a cap, an error)", "exactly which units, by count and id", "never in one sentence that understates it", "Text stays text", "never a picture of words", "the page's text is selectable", "A detail nobody asked for is read twice", "only when a crop of it was read and agrees with the first reading"]) assert.ok(flat.includes(words), `the skill says ${words}`);
});

test("a judge look with no receipt declares its unit: the answers are valid, there is no look key to name, and the script goes on", async () => {
  onDisk = "other";
  noJudgeReceipt = true;
  try {
    const { result } = await run([helpers, assets, looking, data, ground, render, check]);
    assert.ok(result.ok, result.ok ? "" : result.error.message);
  } finally { noJudgeReceipt = false; }
  const html = HTML();
  assert.match(html, /<li>4 units: finding chart, finding contract, finding site, the answer: not judged: /);
  assert.deepEqual(Object.values(groundOf(html)), ["", "", "", ""], "no look key to name");
});

test("a second grounding pass starts afresh: a unit declared before, or a verdict made before, does not outlive it", async () => {
  onDisk = "other";
  const stale = ground.replace("await ground();", 'await ground(); unjudged.set("finding chart", "stale"); report.notChecked.push({ units: ["finding chart"], why: "not judged: stale" }); verdicts.set("x", { yes: 1, look: "a".repeat(64), claim: "t0" }); await ground();');
  assert.notEqual(stale, ground);
  const { result } = await run([helpers, assets, looking, data, stale, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.ok(!HTML().includes("not judged"), "the stale declaration is gone, and so is the stale verdict");
});

test("data-ground follows each current text's own claim id: reversing the points or dropping one after the judgment changes the entries with the texts, never their ids", async () => {
  onDisk = "other";
  const { result, judged } = await run([helpers, assets, looking, data, ground, "report.points.reverse();", render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const key = judged.at(-1);
  assert.equal(groundOf(HTML()).answer, [0, 1, 2, 4, 3].map((n) => `${key}:t${n}`).join(" "), "the points swapped, each keeping the claim id it was judged under");
  const dropped = await run([helpers, assets, looking, data, ground, "report.points.pop();", render, check]);
  assert.ok(dropped.result.ok, dropped.result.ok ? "" : dropped.result.error.message);
  assert.equal(groundOf(HTML()).answer.split(" ").length, 4, "a point dropped leaves no entry for it");
});
