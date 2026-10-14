// Every kind the package reads, end to end through `read` with the package's own readers on files the fixture builders
// write: each gives the model content or a typed miss, never nothing; every image block leaves within the lead's limits;
// a document's text comes back with its page marks and its scans named; a scan is shown rendered; office documents and
// spreadsheets read with nothing installed. Then the guard on a lead that takes no images gives the eyes' words for each
// result that holds an image, one look per result.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import sharp from "sharp";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_LIMITS, MISS_CODES, guardResult, imageHeader, readMedia, resolveLimits } from "@parcha/pi-vision";
import { ffmpegProvider } from "@parcha/pi-vision/providers/ffmpeg";
import { officeJsProvider } from "@parcha/pi-vision/providers/office-js";
import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { sharpImages } from "@parcha/pi-vision/providers/sharp";
import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
import { SENTINEL_LINK_QUERY, SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN, docxBytes, fakeEyes, fixtureDir, letterPdf, mixedPdf, odtBytes, pdfBytes, photoJpeg, pptxBytes, scanPdf, tallPng, textPdf, widePng, xlsxBytes } from "@parcha/pi-vision/testing";

const images = sharpImages(sharp);
/** The providers a host passes: a program first where one serves the same job, the zero-install one after it. */
const providers = [popplerProvider(), unpdfProvider(), pdfiumProvider(), officeJsProvider(), ffmpegProvider()];
const text = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const blocks = (result) => result.content.filter((b) => b.type === "image");

async function rig() {
  const dir = await fixtureDir("pi-vision-kinds-");
  const env = new NodeExecutionEnv({ cwd: dir.path });
  const filed = [], misses = [];
  const setup = {
    limits: DEFAULT_LIMITS, eyes: undefined, images, providers, sources: {},
    scope: { label: "n", deriveDir: `${dir.path}/evidence/n/media` },
    evidence: { file: async (label, record) => { filed.push(record); return { path: `evidence/${label}/${filed.length}-look.md` }; } },
    onMiss: (miss) => misses.push(miss),
  };
  const call = { conversationId: "c1", callId: "t1", model: { id: "lead", input: ["text", "image"] }, signal: undefined };
  return { dir, env, setup, call, filed, misses, read: (args, over = {}) => readMedia(env, args, call, { ...setup, ...over }) };
}

const FILES = {
  "tall.png": () => tallPng(sharp),
  "dashboard.png": () => widePng(sharp),
  "photo.jpg": () => photoJpeg(sharp),
  "letter.pdf": () => letterPdf(),
  "scan.pdf": () => scanPdf(sharp),
  "mixed.pdf": () => mixedPdf(sharp, 5, 3),
  "filing.pdf": () => textPdf(60),
  "proof.docx": () => docxBytes(),
  "deck.pptx": () => pptxBytes(),
  "ledger.xlsx": () => xlsxBytes(),
  "notes.odt": () => odtBytes(),
};

test("every kind gives content or a typed miss, and no image block leaves over the lead's limits", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  const { maxWidth, maxHeight, maxBytes } = DEFAULT_LIMITS.image;
  for (const [name, build] of Object.entries(FILES)) {
    await r.dir.file(name, await build());
    const out = await r.read({ path: name });
    assert.ok(out, `${name} is read by the package, not handed to the host's text read`);
    const missed = out.details?.miss?.code;
    assert.ok(!missed || MISS_CODES.includes(missed), `${name}: ${text(out)}`);
    assert.ok(missed || text(out).length > 0 || blocks(out).length > 0, `${name} gave nothing`);
    for (const block of blocks(out)) {
      const size = imageHeader(Buffer.from(block.data, "base64"));
      assert.ok(size.width <= maxWidth && size.height <= maxHeight && block.data.length <= maxBytes, `${name}: ${size.width}x${size.height}, ${block.data.length} chars`);
    }
  }
  assert.deepEqual(r.misses, [], "nothing here is a miss with nothing installed but the package and sharp");
});

test("the readers use only what the host passed: no provider is a needs miss, no image processor is a needs miss", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  await r.dir.file("letter.pdf", letterPdf());
  await r.dir.file("photo.jpg", await photoJpeg(sharp));
  const pdf = await r.read({ path: "letter.pdf" }, { providers: [] });
  assert.equal(pdf.details.miss.code, "needs");
  const photo = await r.read({ path: "photo.jpg" }, { images: undefined });
  assert.equal(photo.details.miss.code, "needs");
  assert.match(text(photo), /an image processor \(Photon or sharp\) from the host/);
});

test("images: a tall screenshot comes as tiles in reading order, a photo turned upright and resized, each with the line that maps it back", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  await r.dir.file("tall.png", await tallPng(sharp));
  await r.dir.file("photo.jpg", await photoJpeg(sharp));
  const tall = await r.read({ path: "tall.png" });
  assert.ok(blocks(tall).length >= 2);
  assert.deepEqual(tall.details.media.units, blocks(tall).map(() => 0), "the tiles are one unit");
  assert.match(text(tall), /^Image file tall\.png \(image\/png, \d+ bytes, 1288x8319\)\. The tall image 1288x8319 is shown as \d+ tiles/);
  const photo = await r.read({ path: "photo.jpg", ask: "What is shown?" });
  const [shown] = blocks(photo).map((b) => imageHeader(Buffer.from(b.data, "base64")));
  assert.ok(shown.width > shown.height, "turned upright: the stored portrait 3024x4032 with orientation 6 is shown landscape");
  assert.match(text(photo), /turned upright by its EXIF orientation.*Asked: What is shown\?$/);
  assert.equal(photo.details.media.original, "3024x4032", "the receipt's `original` is the header's stored size");
});

test("PDF: text with page marks and its scans named, a scan rendered with its text layer beside it, a page past the end refused", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  await r.dir.file("mixed.pdf", await mixedPdf(sharp, 5, 3));
  await r.dir.file("scan.pdf", await scanPdf(sharp));
  await r.dir.file("filing.pdf", textPdf(60));
  const mixed = await r.read({ path: "mixed.pdf" });
  assert.match(text(mixed), /^Text of mixed\.pdf \(5 pages\), extracted with [\w.-]+; the text is saved at evidence\/n\/media\/mixed\.pdf-[0-9a-f]{16}\.txt\. Page 3 has no text layer: read with page=N to look\./);
  assert.match(text(mixed), /--- page 2 ---\nSection 2\./);
  assert.match(text(mixed), /--- page 3 \(no text layer: read with page=3 to look at it\) ---/);
  const page3 = await r.read({ path: "mixed.pdf", page: 3 });
  assert.equal(blocks(page3).length, 1);
  assert.match(text(page3), /^mixed\.pdf: page 3 has no text layer \(a scan\), so it is shown rendered\.\nPDF mixed\.pdf, page 3 of 5, rendered at \d+ dpi/);
  const scan = await r.read({ path: "scan.pdf" });
  assert.equal(blocks(scan).length, 1);
  assert.match(text(scan), /^scan\.pdf has no text layer \(a scan\): its 1 page shown rendered/);
  const asked = await r.read({ path: "mixed.pdf", page: 2, ask: "What is the record number?" });
  assert.match(text(asked), /Asked: What is the record number\?[\s\S]*Text layer of this page:\nSection 2\./);
  assert.deepEqual(await r.read({ path: "mixed.pdf", page: 9 }), { content: [{ type: "text", text: "Cannot read mixed.pdf: page 9 is past the end of the document (5 pages)." }], isError: true });
  const long = await r.read({ path: "filing.pdf" });
  assert.match(text(long), /\n\n\[Showing line 1 character 0 to line \d+ character \d+ of filing\.pdf \(\d+ lines\)\. Use offset=\d+ char_offset=\d+ to continue\.\]$/, "a long text is paged like a file");
});

test("office documents and spreadsheets read with nothing installed: text in order, cells with their formulas, and what is not shown said", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  await r.dir.file("proof.docx", docxBytes());
  await r.dir.file("deck.pptx", pptxBytes());
  await r.dir.file("ledger.xlsx", xlsxBytes());
  const doc = await r.read({ path: "proof.docx" });
  assert.match(text(doc), /^Text of proof\.docx \(1 page\), read with office-js; the text is saved at evidence\/n\/media\/proof\.docx-[0-9a-f]{16}\.txt\. Text only:/);
  assert.match(text(doc), /EXAMPLE WIDGETS LLC/);
  const deck = await r.read({ path: "deck.pptx" });
  assert.match(text(deck), /--- page 1 ---[\s\S]*--- page 2 ---/);
  const sheet = await r.read({ path: "ledger.xlsx" });
  assert.match(text(sheet), /^Cells of ledger\.xlsx \(\d+ sheets?\), read with office-js; the text is saved at evidence\/n\/media\/ledger\.xlsx-[0-9a-f]{16}\.txt\. Cells only:/);
  assert.match(text(sheet), /\{=[^}]+\}/, "a formula is in its cell");
  assert.match(text(sheet), /<no stored value>/, "a formula with no stored value says so");
});

test("a lead that takes no images: each result that holds an image is one look by the eyes, and only their words reach the lead", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  const textOnly = { conversationId: "c1", callId: "t1", model: { id: "lead", input: ["text"] }, signal: undefined };
  for (const [name, build] of [["tall.png", () => tallPng(sharp)], ["scan.pdf", () => scanPdf(sharp)], ["photo.jpg", () => photoJpeg(sharp)]]) {
    await r.dir.file(name, await build());
    const eyes = fakeEyes({ answers: ["words"] });
    const setup = { ...r.setup, eyes, limits: resolveLimits(textOnly.model) };
    const read = await readMedia(r.env, { path: name }, textOnly, setup);
    const out = await guardResult(read, textOnly, setup);
    assert.equal(eyes.ledger.length, 1, `${name}: one look`);
    assert.equal(blocks(out).length, 0, `${name}: no image reaches the lead`);
    assert.match(text(out), /seen for you by fake-eyes/);
  }
});

test("a video where no program runs: a lead that takes no video gets a typed miss, one that takes video still gets a file that fits", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  // An environment that runs no program, as a sandbox without ffmpeg: the provider's detection finds none.
  const bare = Object.assign(Object.create(Object.getPrototypeOf(r.env)), r.env, { id: "no-programs", exec: async () => ({ ok: false, error: Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }) }) });
  await r.dir.file("clip.mp4", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12), Buffer.alloc(2000, 7)]));
  const read = (limits) => readMedia(bare, { path: "clip.mp4" }, r.call, { ...r.setup, limits });
  const frames = await read(DEFAULT_LIMITS);
  assert.equal(frames.details.miss.code, "video_unseeable");
  assert.match(text(frames), /^clip\.mp4 could not be read: this route takes no video and ffmpeg is not in the environment to take frames of it\./);
  const native = await read(resolveLimits(undefined, { video: { native: true } }));
  assert.deepEqual(blocks(native).map((b) => b.mimeType), ["video/mp4"]);
});

test("a lead that takes video gets a file within the inline budget as it is, with no provider detected and no program run", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  let detected = 0;
  const refuse = async () => { throw new Error("no program may run for this read"); };
  const watched = { name: "watched-video", capabilities: ["frames", "clip"], kinds: ["video"], detect: async () => { detected += 1; throw new Error("detect ran"); }, probe: refuse, frames: refuse, clip: refuse };
  await r.dir.file("small.mp4", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12), Buffer.alloc(2000, 7)]));
  const out = await r.read({ path: "small.mp4" }, { providers: [watched], limits: resolveLimits(undefined, { video: { native: true } }) });
  assert.deepEqual(blocks(out).map((b) => b.mimeType), ["video/mp4"]);
  assert.match(text(out), /^Video file small\.mp4 \(\d+ bytes\), sent as it is/);
  assert.equal(detected, 0);
});

test("a PDF replaced while it is read: the text, the hash and the kept derivation are all of the bytes first read, and a later read of those bytes is not answered with the other's", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const A = pdfBytes([{ lines: ["Invented notice for a test", "Reference number 4471"] }]);
  const B = pdfBytes([{ lines: ["A second invented notice", "Reference number 9026"] }]);
  const path = await r.dir.file("notice.pdf", A);
  // The file becomes B once the read has taken the source and before any provider runs.
  let swapped = false;
  const racing = Object.assign(Object.create(Object.getPrototypeOf(r.env)), r.env, { createTempDir: async (...args) => { if (!swapped) { swapped = true; writeFileSync(path, B); } return r.env.createTempDir(...args); } });
  const first = await readMedia(racing, { path: "notice.pdf" }, r.call, r.setup);
  assert.deepEqual(readFileSync(path), Buffer.from(B), "the file was replaced during the read");
  assert.equal(first.details.media.sha256, sha(A));
  assert.ok(text(first).includes("4471") && !text(first).includes("9026"), "the text is of the bytes the hash names");
  const kept = readdirSync(r.setup.scope.deriveDir);
  assert.ok(kept.length > 0 && kept.every((name) => name.includes(sha(A).slice(0, 16))), kept.join(", "));
  assert.ok(kept.every((name) => !readFileSync(`${r.setup.scope.deriveDir}/${name}`, "utf8").includes("9026")), "nothing kept under the first hash holds the other's text");
  writeFileSync(path, A);
  const again = await r.read({ path: "notice.pdf" });
  assert.ok(text(again).includes("4471") && !text(again).includes("9026"));
});

test("a read cancelled while a derivation or a document's text is put in place leaves no temporary file where derivations are kept", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  await r.dir.file("letter.pdf", letterPdf());
  // A derivation is written as `.tmp` and a document's kept text as `.part`, each renamed into place; the call is
  // cancelled at that rename.
  for (const suffix of [".tmp", ".part"]) {
    const cut = new AbortController();
    const cutting = new Proxy(r.env, {
      get: (target, key) => (key === "renameFile"
        ? async (from, to, context) => { if (!from.endsWith(suffix)) return target.renameFile(from, to, context); cut.abort(); return { ok: false, error: Object.assign(new Error("cancelled"), { code: "aborted" }) }; }
        : typeof target[key] === "function" ? target[key].bind(target) : target[key]),
    });
    await readMedia(cutting, { path: "letter.pdf" }, { ...r.call, signal: cut.signal }, { ...r.setup, providers: [unpdfProvider()] });
    assert.ok(cut.signal.aborted, `the call was cancelled at the rename of a ${suffix} file`);
    assert.deepEqual(readdirSync(r.setup.scope.deriveDir).filter((name) => name.endsWith(suffix)), [], `no ${suffix} file is left`);
  }
});

test("a document read as text keeps that text in a file the agent can search, says where, and names it in details.document", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  const pdf = mixedPdf(sharp, 3, 2);
  await r.dir.file("sub dir/mixed (v2).pdf", await pdf);
  await r.dir.file("proof.docx", docxBytes());
  const sha16 = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const whole = await r.read({ path: "sub dir/mixed (v2).pdf" });
  const saved = `evidence/n/media/mixed_v2_.pdf-${sha16(await pdf)}.txt`;
  assert.deepEqual(whole.details.document, { text: saved, extractor: whole.details.document.extractor, pages: 3 });
  assert.ok(text(whole).includes(`; the text is saved at ${saved}.`));
  const kept = readFileSync(`${r.dir.path}/${saved}`, "utf8");
  assert.match(kept, /^--- page 1 ---\nSection 1\./);
  assert.match(kept, /--- page 2 \(no text layer: read with page=2 to look at it\) ---/);
  assert.ok(text(whole).includes(kept.slice(0, 200)), "the file holds the text the read shows");
  const one = await r.read({ path: "sub dir/mixed (v2).pdf", page: 3 });
  const savedPage = saved.replace(/\.txt$/, "-p3.txt");
  assert.deepEqual(one.details.document, { text: savedPage, extractor: one.details.document.extractor, page: 3, pages: 3 });
  assert.match(readFileSync(`${r.dir.path}/${savedPage}`, "utf8"), /^Section 3\./);
  const doc = await r.read({ path: "proof.docx" });
  assert.deepEqual(doc.details.document, { text: `evidence/n/media/proof.docx-${sha16(docxBytes())}.txt`, extractor: "office-js", pages: 1 });
  assert.match(readFileSync(`${r.dir.path}/${doc.details.document.text}`, "utf8"), /EXAMPLE WIDGETS LLC/);
  // A second read of the same bytes leaves the file as it is; a file holding other text of them (another extractor's)
  // is replaced, so the file always holds what the read shows.
  const before = statSync(`${r.dir.path}/${saved}`);
  await r.read({ path: "sub dir/mixed (v2).pdf" });
  assert.deepEqual([statSync(`${r.dir.path}/${saved}`).ino, statSync(`${r.dir.path}/${saved}`).mtimeMs], [before.ino, before.mtimeMs], "not written again");
  writeFileSync(`${r.dir.path}/${saved}`, "another extractor's text of the same bytes");
  await r.read({ path: "sub dir/mixed (v2).pdf" });
  assert.equal(readFileSync(`${r.dir.path}/${saved}`, "utf8"), kept);
  assert.deepEqual(readdirSync(`${r.dir.path}/evidence/n/media`).filter((name) => name.endsWith(".part")), [], "no part file is left");
});

test("a rendered page says where its render is saved, and the look's receipt lists it", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  await r.dir.file("scan.pdf", await scanPdf(sharp));
  const out = await r.read({ path: "scan.pdf" });
  const said = /rendered at \d+ dpi \(\d+x\d+\) and saved at (evidence\/n\/media\/\S+\.png)\./.exec(text(out));
  assert.ok(said, text(out));
  assert.ok(readFileSync(`${r.dir.path}/${said[1]}`).length > 1000, "the render is a file there");
  assert.deepEqual(out.details.media.derived, [said[1]]);
  const looked = await guardResult(out, r.call, r.setup);
  assert.deepEqual(r.filed.at(-1).facts.derived, [said[1]]);
  assert.equal(blocks(looked).length, 1);
});

test("a file named after a signed link keeps its text under a name with none of the link's query in it", async (t) => {
  const r = await rig();
  t.after(() => r.dir.remove());
  const name = `statement.pdf?${SENTINEL_LINK_QUERY}`;
  await r.dir.file(name, letterPdf());
  const out = await r.read({ path: name });
  assert.match(out.details.document.text, /^evidence\/n\/media\/statement\.pdf-[0-9a-f]{16}\.txt$/);
  for (const kept of readdirSync(`${r.dir.path}/evidence/n/media`)) assert.ok(![SENTINEL_LINK_SIGNATURE, SENTINEL_LINK_TOKEN].some((secret) => kept.includes(secret)), kept);
});
