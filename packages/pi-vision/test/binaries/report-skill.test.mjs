// The report skill's six pieces run as written: skills/report/SKILL.md is one script in six ```js blocks, run in order in
// pi-codemode's sandbox with a `bash` tool over a workspace the test builds (a 40 second film, a three page PDF and a
// photo) and the handle's `vision.see` on fake eyes. The host files each look as a receipt, the first as a text receipt
// with a `key:` header line and the next as a JSON record, the two shapes hosts write. The written page is then checked
// here, not by the skill's own check: self-contained, assets present and under budget, cites well formed and resolving to
// a look the run made, boxes inside the picture, the answer first. A page with each of those faults is refused by the
// skill's check. Needs ffmpeg and poppler: `npm run test:binaries` runs it, `npm test` does not.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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
// 40 seconds of a moving test card at 640x360, 5 frames a second, with a tone, so a cut clip has something to compress.
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=5:duration=40", "-f", "lavfi", "-i", "sine=frequency=440:duration=40",
  "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", path.join(cwd, "talk.mp4")]);
fs.writeFileSync(path.join(cwd, "contract.pdf"), textPdf(4));
fs.writeFileSync(path.join(cwd, "photo.jpg"), await photoJpeg(sharp));

/** A bash tool as a host's code mode gives one: the command's output, or a rejection that carries what it printed. */
const bash = { name: "bash", execute: ({ command }) => new Promise((resolve, reject) => execFile("bash", ["-c", command], { cwd, maxBuffer: 1 << 26 }, (error, stdout, stderr) => (error ? reject(new Error(`${stderr}${error.message}`)) : resolve(stdout)))) };

/** Runs the pieces as one script and gives what it returned, the keys of the looks the host filed, and its receipts. */
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
    return { result, keys, eyes };
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
const HTML = () => fs.readFileSync(path.join(cwd, "report", "report.html"), "utf8");
/** The values of an attribute everywhere in the page. */
const attrs = (html, name) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);
const sizeOf = (file) => fs.statSync(path.join(cwd, "report", file)).size;
const all = (dirPath) => fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dirPath, e.name)) : [path.join(dirPath, e.name)]));

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
  assert.deepEqual({ ...value, bytes: undefined }, { report: "report/report.html", findings: 3, looks: 3, bytes: undefined });
  assert.equal(keys.length, 3, "one look a picture");
  assert.equal(new Set(keys).size, 3);
  assert.ok(value.bytes > 2000 && value.bytes < 60_000, `${value.bytes} bytes of page`);
});

test("the page is self-contained: no script, no link, no frame, no URL of any kind, no path of this machine", async () => {
  await built();
  const html = HTML();
  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /<script|<link|<iframe|<form|<object|<embed|@import/i);
  assert.doesNotMatch(html, /https?:|(^|[^:])\/\/[a-z0-9]|url\(/i, "no absolute or protocol-relative URL, no CSS url()");
  assert.ok(!html.includes(cwd) && !html.includes(process.env.HOME ?? "/nonexistent-home"), "no machine path");
  assert.doesNotMatch(html, /\bsk-[A-Za-z0-9]{10,}|Bearer /);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, "readable at phone width");
  assert.match(html, /color-scheme:light dark/);
  assert.match(html, /@media \(prefers-color-scheme:dark\)/, "and in the dark");
  assert.match(html, /<html lang="en">/);
});

test("every file the page shows is in report/, is not empty, and the clip and the folder are within budget", async () => {
  await built();
  const html = HTML();
  const refs = [...attrs(html, "src"), ...attrs(html, "poster")];
  assert.deepEqual([...new Set(refs)].sort(), ["clips/talk-chart.mp4", "frames/contract-p3.jpg", "frames/site-photo.jpg", "frames/talk-chart.jpg"]);
  for (const ref of refs) {
    assert.ok(!path.isAbsolute(ref) && !ref.split("/").includes(".."), `${ref} stays in the folder`);
    assert.ok(sizeOf(ref) > 0, `${ref} is not empty`);
  }
  for (const ref of refs.filter((r) => r.startsWith("frames/"))) assert.ok(sizeOf(ref) <= 400_000, `${ref}: ${sizeOf(ref)} bytes`);
  assert.ok(sizeOf("clips/talk-chart.mp4") <= 2_000_000, "a clip is at most 2 MB");
  assert.ok(all(path.join(cwd, "report")).reduce((n, f) => n + fs.statSync(f).size, 0) <= 15_000_000, "the folder is at most 15 MB");
  // The files are what they say they are: a JPEG of at most 960 px, a short silent MP4 of 8 seconds.
  const head = fs.readFileSync(path.join(cwd, "report", "frames", "talk-chart.jpg")).subarray(0, 3);
  assert.deepEqual([...head], [0xff, 0xd8, 0xff]);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", path.join(cwd, "report", "clips", "talk-chart.mp4")], { encoding: "utf8" }));
  assert.deepEqual(probe.streams.map((s) => [s.codec_type, s.codec_name]), [["video", "h264"]], "silent unless the sound is the point");
  assert.ok(probe.streams[0].width <= 480);
  assert.ok(Math.abs(Number(probe.format.duration) - 8) < 0.7, `${probe.format.duration} s`);
});

test("each cite is a link to the source file's own fragment, labelled with that number, and names a look the run made", async () => {
  const { keys } = await built();
  const html = HTML();
  const cites = [...html.matchAll(/<a class="cite" href="([^"]*)" data-look="([^"]*)">([^<]*)<\/a>/g)].map(([, href, look, label]) => ({ href, look, label }));
  assert.deepEqual(cites.map((c) => [c.href, c.label]), [
    ["../talk.mp4#t=21.5", "21.5 s"],
    ["../talk.mp4#t=18,26", "18 to 26 s"],
    ["../contract.pdf#page=3", "page 3"],
    ["../photo.jpg", "file"],
  ]);
  assert.equal(attrs(html, "href").length, cites.length, "every link on the page is a cite");
  for (const cite of cites) {
    assert.match(cite.look, /^[0-9a-f]{64}$/, "a look key");
    assert.ok(keys.includes(cite.look), `${cite.href} rests on a look the host filed`);
    const [file, fragment] = cite.href.split("#");
    assert.ok(fs.existsSync(path.join(cwd, file.slice(3))), `${file} is a file of the run, relative to the folder above the report`);
    if (fragment) assert.match(fragment, /^(page=[1-9]\d*|t=\d+(\.\d+)?(,\d+(\.\d+)?)?|xywh=percent:\d+(\.\d+)?(,\d+(\.\d+)?){3})$/);
  }
  assert.deepEqual(cites.map((c) => c.look), [keys[0], keys[0], keys[1], keys[2]], "the talk's two cites rest on its look; the receipts were a text one and JSON ones");
});

test("a box is its look's percentages on the picture, inside it, and cites its look", async () => {
  const { keys } = await built();
  const html = HTML();
  const boxes = [...html.matchAll(/<span class="box" data-xywh="percent:([^"]*)" data-look="([^"]*)" style="([^"]*)">/g)];
  assert.equal(boxes.length, 1);
  const [, xywh, look, style] = boxes[0];
  const [x, y, w, h] = xywh.split(",").map(Number);
  assert.deepEqual([x, y, w, h], [61.2, 40, 12, 9]);
  assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 100 && y + h <= 100);
  assert.equal(style, "left:61.2%;top:40%;width:12%;height:9%", "the percentages as they are, with no arithmetic");
  assert.equal(look, keys[0]);
  assert.match(html, /<div class="frame"><img src="frames\/talk-chart\.jpg"[^>]*>(<span class="box")/, "over the picture of its finding");
});

test("the answer comes first, then the evidence, one article for each finding with its words, picture and cites, then what was not checked", async () => {
  await built();
  const html = HTML();
  const order = ['<h1>', 'id="answer"', 'id="evidence"', 'class="finding" id="f1"', 'class="finding" id="f2"', 'class="finding" id="f3"', 'id="not-checked"'].map((marker) => html.indexOf(marker));
  assert.ok(order.every((at) => at >= 0), "every part is there");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order");
  assert.equal((html.match(/<article class="finding"/g) ?? []).length, 3);
  for (const article of html.split('<article class="finding"').slice(1)) {
    assert.match(article, /<h3>[^<]+<\/h3><p>[^<]+<\/p>/, "a claim and its words");
    assert.match(article, /<img src="[^"]+" alt="[^"]+"/, "a picture with its alternative text");
    assert.match(article, /<p class="cites">(<a class="cite" [^>]*>[^<]*<\/a>\s*)+<\/p>/, "its cites");
  }
  assert.match(html, /<video controls muted playsinline preload="metadata" poster="frames\/talk-chart\.jpg"><source src="clips\/talk-chart\.mp4" type="video\/mp4"><\/video>/);
  assert.match(html, /<dl>(<div><dt>[^<]+<\/dt><dd>[^<]+<\/dd><\/div>)+<\/dl>/, "the figures that matter, at the top");
});

test("text a look gives is escaped, not trusted as markup", async () => {
  const hostile = data.replace('words: lookTalk.text', 'words: `<script>alert(1)</script><img src=x onerror=alert(1)> "quoted" & more`');
  assert.notEqual(hostile, data);
  onDisk = "other";
  const { result } = await run([helpers, assets, looking, hostile, render, check]);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const html = HTML();
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &amp; more"));
  assert.doesNotMatch(html, /<script|<img src=x/);
});

test("a URL in a look's words is written without its scheme, so the page still reaches nowhere", async () => {
  const quoting = data.replace('words: lookTalk.text', 'words: `The slide says https://example.com/terms?a=1&b=2, and links //cdn.example/x.js, and mailto:a@example.com.`');
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
  const code = render.replace('await write("report/report.html", page);', `${change}\nawait write("report/report.html", page);`).replace("const page = ", "let page = ");
  assert.notEqual(code, render);
  onDisk = "other";
  return run([helpers, assets, looking, data, code, check]);
}
const refuses = async (change, pattern) => {
  const { result } = await doctored(change);
  assert.ok(!result.ok, `the check refuses the page after: ${change}`);
  assert.match(result.error.message, pattern);
};

test("the skill's check refuses a page that reaches out, is missing a file, has a box outside the picture, or cites what no look made", async () => {
  await refuses('page = page.replace("</main>", \'<script src="https://cdn.example/x.js"></script></main>\');', /reaches outside its folder or runs code/);
  await refuses('page = page.replace("</main>", \'<img src="//cdn.example/x.png"></main>\');', /reaches outside its folder or runs code|not a file in report/);
  await refuses('page = page.replace("</main>", \'<p>see http://example.com/terms</p></main>\');', /reaches outside its folder or runs code/);
  await refuses('page = page.replace("frames/site-photo.jpg", "frames/not-there.jpg");', /frames\/not-there\.jpg is missing or empty/);
  await refuses('page = page.replace("frames/site-photo.jpg", "../talk.mp4");', /\.\.\/talk\.mp4 is not a file in report\//);
  await refuses('page = page.replace("percent:61.2,40,12,9", "percent:90,40,12,9");', /percent:90,40,12,9 is not inside 0 to 100/);
  await refuses('page = page.replace(`data-look="${lookSite.key}"`, `data-look="' + "f".repeat(64) + '"`);', /is no look this run made/);
  await refuses('page = page.replace("href=\\"../contract.pdf#page=3\\"", "href=\\"../contract.pdf#page=0\\"");', /has a fragment that is not page=, t= or xywh=/);
  await refuses('page = page.replace("href=\\"../talk.mp4#t=21.5\\"", "href=\\"../talk.mp4#t=soon\\"");', /has a fragment that is not page=, t= or xywh=/);
  await refuses('page = page.replace(\'href="../photo.jpg"\', \'href="/home/someone/photo.jpg"\');', /is not a relative cite/);
  await refuses('page = page.replace(\'class="cite" href="../photo.jpg" data-look=\', \'class="cite" href="../photo.jpg" data-x=\');', /a cite has no data-look/);
  await refuses('page = page.replace(\'id="answer"\', \'id="summary"\');', /the answer is not first/);
});

test("the check refuses a clip over 2 MB and a folder over 15 MB", async () => {
  await refuses('await sh("head -c 2500000 /dev/zero > report/clips/big.mp4"); page = page.replace("</main>", \'<video><source src="clips/big.mp4"></video></main>\');', /clips\/big\.mp4 is over 2 MB/);
  await refuses('await sh("head -c 15500000 /dev/zero > report/clips/huge.bin");', /report\/ is over 15 MB/);
});

test("a clip that cannot fit its budget stops the script with the window to shorten; a name that is not a file name is refused", async () => {
  const tight = assets.replace("maxBytes = 2_000_000", "maxBytes = 5_000");
  assert.notEqual(tight, assets);
  const { result } = await run([helpers, tight, looking, data, render, check]);
  assert.ok(!result.ok);
  assert.match(result.error.message, /talk-chart: 8 s do not fit 5000 bytes; cut a shorter window/);
  const named = data.replace('"talk-chart"),\n  contract', '"Talk Chart"),\n  contract');
  assert.notEqual(named, data);
  const refused = await run([helpers, assets, looking, named, render, check]);
  assert.ok(!refused.result.ok);
  assert.match(refused.result.error.message, /Talk Chart: a file name here is lowercase letters, digits and dashes/);
});

test("a host that files no receipt gives no look to cite, and the script says so", async () => {
  const eyes = fakeEyes();
  const vision = createVisionExtension({ eyes, scope: () => ({ label: "report", deriveDir: ".vision" }), evidence: { file: async () => null } });
  const call = { conversationId: "report", callId: "1", model: undefined, signal: undefined };
  const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(nodeVisionEnv({ cwd }), call)] });
  try {
    const result = await sandbox.execute([helpers, assets, looking, data, render, check].join("\n"));
    assert.ok(!result.ok);
    assert.match(result.error.message, /no receipt: this host files none, so there is no look to cite/);
  } finally { await sandbox.close(); }
});
