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

const SKILL = fs.readFileSync(new URL("../../skills/report/SKILL.md", import.meta.url), "utf8");
const pieces = [...SKILL.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
const [helpers, assets, looking, data, render, check, ...more] = pieces;

const dir = await fixtureDir("pi-vision-report-skill-");
after(() => dir.remove());
const cwd = dir.path;
// 40 seconds of a moving test card at 640x360, 5 frames a second, with a tone, so a cut clip has something to compress and
// each frame says which second it is.
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=5:duration=40", "-f", "lavfi", "-i", "sine=frequency=440:duration=40",
  "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", path.join(cwd, "talk.mp4")]);
fs.writeFileSync(path.join(cwd, "contract.pdf"), textPdf(4));
fs.writeFileSync(path.join(cwd, "photo.jpg"), await photoJpeg(sharp));

/** A bash tool as a host's code mode gives one: the command's output, or a rejection that carries what it printed. */
const bash = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd, maxBuffer: 1 << 26 }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)))) };

/** Runs the pieces as one script and gives what it returned and the keys of the looks the host filed. */
async function run(codes) {
  fs.rmSync(path.join(cwd, "report"), { recursive: true, force: true });
  fs.rmSync(path.join(cwd, "evidence"), { recursive: true, force: true });
  const keys = [];
  const eyes = fakeEyes({ answers: [(request) => `The picture at ${request.parts.find((p) => p.type === "image")?.fragment} is shown.`] });
  const vision = createVisionExtension({
    eyes,
    scope: () => ({ label: "report", deriveDir: ".vision" }),
    evidence: { file: async (label, record) => {
      keys.push(record.facts.key);
      const file = `evidence/${label}/${keys.length}-look.${keys.length % 2 ? "md" : "json"}`;
      fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      // A text receipt: `key: value` header lines, then `---`, then the body. A JSON receipt: the record itself.
      const text = `tool: ${record.tool}\nargs: ${JSON.stringify(record.args)}\nstatus: ${record.status}\n${Object.entries(receiptFacts(record)).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${record.body}\n`;
      fs.writeFileSync(path.join(cwd, file), keys.length % 2 ? text : JSON.stringify(record, null, 2));
      return { path: file };
    } },
  });
  const call = { conversationId: "report", callId: "1", model: undefined, signal: undefined };
  const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(nodeVisionEnv({ cwd }), call)] });
  try {
    const result = await sandbox.execute(codes.join("\n"));
    return { result, keys };
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
  assert.deepEqual([helpers, assets, looking, data, render, check].map((code) => typeof code), Array(6).fill("string"));
  assert.deepEqual(more, []);
  assert.ok(/^name: report$/m.test(SKILL) && /^description: .{40,}$/m.test(SKILL));
  const description = /^description: (.*)$/m.exec(SKILL)[1];
  assert.ok(description.length <= 1024, `${description.length} characters of description`);
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
});

test("every file the page shows is in report/, is not empty and is within budget; the folder holds nothing the page does not need", async () => {
  await built();
  const html = HTML();
  const refs = [...attrs(html, "src"), ...attrs(html, "poster")];
  assert.deepEqual([...new Set(refs)].sort(), ["clips/talk-chart.mp4", "frames/contract-p3.jpg", "frames/site-photo.jpg", "frames/talk-chart-poster.jpg", "frames/talk-chart.jpg", "frames/talk-later.jpg"]);
  for (const ref of refs) {
    assert.ok(!path.isAbsolute(ref) && !ref.split("/").includes(".."), `${ref} stays in the folder`);
    assert.ok(sizeOf(ref) > 0, `${ref} is not empty`);
  }
  for (const ref of refs.filter((r) => r.startsWith("frames/"))) assert.ok(sizeOf(ref) <= 700_000, `${ref}: ${sizeOf(ref)} bytes`);
  assert.ok(sizeOf("clips/talk-chart.mp4") <= 1_500_000, "a clip is at most 1.5 MB");
  assert.ok(all(path.join(cwd, "report")).reduce((n, f) => n + fs.statSync(f).size, 0) <= 8_000_000, "the folder is at most 8 MB");
  assert.deepEqual(all(path.join(cwd, "report")).map((f) => path.relative(path.join(cwd, "report"), f)).sort(), ["clips/talk-chart.mp4", "contract.pdf", "frames/contract-p3.jpg", "frames/site-photo.jpg", "frames/talk-chart-poster.jpg", "frames/talk-chart.jpg", "frames/talk-later.jpg", "index.html"]);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "report", "contract.pdf")), fs.readFileSync(path.join(cwd, "contract.pdf")), "a source document is copied as it is");
  assert.ok(!fs.existsSync(path.join(cwd, "report", "talk.mp4")) && !fs.existsSync(path.join(cwd, "report", "photo.jpg")), "a film and a source named in outside are not copied");
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
    ["mark-rule", "7,6,70,4", keys[1], "left:7%;top:6%;width:70%;height:4%", "f-contract", "the rule", false],
  ], "the percentages as written, with no arithmetic; a box on the right half has its label on its right edge");
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
  const order = ["<h1>", 'id="answer"', 'id="evidence"', 'class="finding" id="f-chart"', 'class="finding" id="f-contract"', 'id="document"', 'class="docpage" id="page-3"', 'id="routine"', 'class="finding routine" id="f-site"', 'id="not-checked"'].map((marker) => html.indexOf(marker));
  assert.ok(order.every((at) => at >= 0), "every part is there");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order");
  assert.equal((html.match(/<article class="finding"/g) ?? []).length, 2);
  assert.match(html, /<details class="finding routine" id="f-site"><summary>The site<\/summary>/, "the routine detail is folded");
  assert.doesNotMatch(html, /<details[^>]*id="f-(chart|contract)"/, "a key finding is open");
  const points = html.match(/<ul class="points">([\s\S]*?)<\/ul>/)[1];
  assert.deepEqual([...points.matchAll(/<a href="#([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]), [["f-chart", "second quarter"], ["f-contract", "page 3"]], "each key point links to its finding");
  for (const article of html.split('<article class="finding"').slice(1)) {
    assert.match(article, /<h3>[^<]+<\/h3><p>[^<]+<\/p>/, "a claim and its words");
    assert.match(article, /<p class="cites">(<a class="cite" [^>]*>[^<]*<\/a>\s*)+/, "its cites");
  }
  const figures = html.match(/<figure class="pic">[\s\S]*?<\/figure>/g);
  assert.equal(figures.length, 4, "the chart, the same chart later, the clip and the photo");
  for (const figure of figures) assert.match(figure, /<figcaption>[^<]{12,}<\/figcaption>/, "a caption that says why the picture is kept");
  assert.match(html, /alt="A bar chart with the second bar tallest"/, "a picture has alternative text");
  assert.match(html, /<section id="document"><h2>The document, with its marks<\/h2><figure class="docpage" id="page-3"><header><span class="n">p\. 3<\/span><a class="cite" href="contract\.pdf#page=3"/);
  assert.match(html, /<section id="not-checked">[\s\S]*<\/section>\s*<\/main>/);
});

test("text a look gives is escaped, not trusted as markup", async () => {
  const hostile = data.replace("why: lookTalk.text,", 'why: `<script>alert(1)</script><img src=x onerror=alert(1)> "quoted" & more`,');
  assert.notEqual(hostile, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, hostile, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; more"));
  assert.doesNotMatch(html, /<script|<img src=x/);
});

test("a URL in a look's words is written without its scheme, so the page still reaches nowhere", async () => {
  const quoting = data.replace("why: lookTalk.text,", "why: `The slide says https://example.com/terms?a=1&b=2, and links //cdn.example/x.js, and mailto:a@example.com.`,");
  assert.notEqual(quoting, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, quoting, render, check]);
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
  return run([helpers, assets, looking, data, code, check]);
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
  const { result } = await run([helpers, assets, looking, data, many, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /the answer has one to four key points/);
});

test("a clip that cannot fit its budget stops the script with the window to shorten; a name that is not a file name and a source in a folder are refused", async () => {
  const small = helpers.replace("clip: 1_500_000", "clip: 5_000");
  assert.notEqual(small, helpers);
  onDisk = "other";
  const { result } = await run([small, assets, looking, data, render, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /talk-chart: 8 s do not fit 5000 bytes; cut a shorter window/);
  const named = data.replace('21.5, "talk-chart")', '21.5, "Talk Chart")');
  assert.notEqual(named, data);
  const refused = await run([helpers, assets, looking, named, render, check]);
  assert.ok(!refused.result.ok);
  assert.match(refused.result.error.message, /Talk Chart: a file name here is lowercase letters, digits and dashes/);
  const nested = await run([helpers, assets, 'await keep("sub/contract.pdf");']);
  assert.ok(!nested.result.ok);
  assert.match(nested.result.error.message, /sub\/contract\.pdf: keep a file of this folder under 3000000 bytes, and name a larger one in outside/);
});

test("a host that files no receipt gives no look to cite, and the script says so", async () => {
  const eyes = fakeEyes();
  const vision = createVisionExtension({ eyes, scope: () => ({ label: "report", deriveDir: ".vision" }), evidence: { file: async () => null } });
  const call = { conversationId: "report", callId: "1", model: undefined, signal: undefined };
  const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(nodeVisionEnv({ cwd }), call)] });
  onDisk = "other";
  try {
    const result = await sandbox.execute([helpers, assets, looking, data, render, check].join("\n"));
    assert.ok(!result.ok);
    assert.match(result.error.message, /no receipt: this host files none, so there is no look to cite/);
  } finally { await sandbox.close(); }
});
