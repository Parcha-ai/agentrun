// PDF through the zero-install providers (pdf.js in `unpdf`, PDFium), on files built here: facts, text by page, pages at a
// dpi, what is kept, and the files that must end in a typed miss inside their caps (a password, a form that draws itself
// a hundred times over four levels, a word shown a hundred million times, a page the size of a building). Every file is
// invented; the binaries' suite (test/binaries) holds poppler to the same.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { after, test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import sharp from "sharp";
import { SOURCE_BYTES_IN_PROCESS, pdfDocument, pdfMarkedText, pdfPage, pdfText } from "@parcha/pi-vision";
import { fakeProvider, fixtureDir, registerProviderConformance } from "@parcha/pi-vision/testing";
import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
import { appendRevision, documentPdf, encryptedPdf, endlessPdf, hugePagePdf, linearizedPdf, mixedPdf, signatureObject, textPdf, xrefStreamPdf } from "./support/pdf-builders.mjs";
import { A4, conformanceFixtures, documents, sourceOf as sourceIn } from "./support/pdf-sources.mjs";

const dir = await fixtureDir("pi-vision-pdf-");
after(() => dir.remove());
const env = new NodeExecutionEnv({ cwd: dir.path });
const sourceOf = (name, bytes) => sourceIn(dir, name, bytes);
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 0.01, `${what}: ${actual}, expected ${expected}`);
const unpdf = unpdfProvider();
const pdfium = pdfiumProvider();
const ok = (outcome) => { assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.miss.code}: ${outcome.miss.detail}`); return outcome.value; };

const docs = await documents(dir);
const { odd } = docs;

test("the facts of a document: pages, their sizes as shown, which have text, producer and creator", async () => {
  const facts = ok(await pdfDocument(odd, { env, providers: [unpdf] })).facts;
  assert.equal(facts.pages, 4);
  assert.deepEqual(facts.textPages, [1, 3, 4]);
  assert.deepEqual([facts.producer, facts.creator], ["Invented Writer 2.1", "Fixture Maker"]);
  const sizes = [[612, 792], [500, 300], A4, [300, 300]];
  facts.pageSizes.forEach((size, i) => { near(size.width, sizes[i][0], `page ${i + 1} width`); near(size.height, sizes[i][1], `page ${i + 1} height`); });
});

test("saved revisions and signatures are read from the file's structure", async () => {
  const facts = async (name, bytes) => ok(await pdfDocument(await sourceOf(name, bytes), { env, providers: [unpdf] })).facts;
  const once = textPdf(["One save."]);
  const update = [[3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]];
  const plain = await facts("once.pdf", once);
  assert.deepEqual([plain.revisions, plain.signatures], [1, 0]);
  assert.equal((await facts("edited.pdf", appendRevision(appendRevision(once, update, 7), update, 7))).revisions, 3);
  const signed = documentPdf([{ lines: ["Signed."] }], { extra: [signatureObject(), signatureObject()] });
  assert.deepEqual([(await facts("signed.pdf", signed)).signatures, (await facts("signed.pdf", signed)).revisions], [2, 1]);
  // A cross-reference stream is a section as a table is, and a table may follow it.
  const indexed = xrefStreamPdf(["Indexed by a stream."]);
  assert.equal((await facts("stream.pdf", indexed)).revisions, 1);
  assert.equal((await facts("stream-edited.pdf", appendRevision(indexed, update, 7))).revisions, 2);
  // A linearized file's first-page section is not a save; a save after it is.
  const linear = linearizedPdf(["Streamed."]);
  assert.deepEqual(ok(await pdfDocument(await sourceOf("linear.pdf", linear), { env, providers: [unpdf] })).pages, ["Streamed."]);
  assert.equal((await facts("linear.pdf", linear)).revisions, 1);
  assert.equal((await facts("linear-edited.pdf", appendRevision(linear, update, 8))).revisions, 2);
});

test("words a document shows or holds are not its structure", async () => {
  const words = ["/ByteRange [0 100 200 300]", "startxref 12 %%EOF", "xref trailer << /Prev 9 >> stream endstream"];
  const spoof = documentPdf([{ lines: words }, { content: "% /ByteRange [0 1 2 3]\nBT /F1 12 Tf 72 700 Td (/ByteRange [0 1 2 3]) Tj ET" }], { info: { Title: "/ByteRange [0 1 2 3] startxref 7 %%EOF", Subject: "(nested (/ByteRange [0 1 2 3]) parentheses)" } });
  const facts = ok(await pdfDocument(await sourceOf("spoof.pdf", spoof), { env, providers: [unpdf] })).facts;
  assert.deepEqual([facts.revisions, facts.signatures], [1, 0]);
  const damaged = Buffer.from(textPdf(["No chain."]).toString("latin1").replace(/startxref\n\d+/, "startxref\n99999999"), "latin1");
  assert.equal(ok(await pdfDocument(await sourceOf("damaged.pdf", damaged), { env, providers: [unpdf] })).facts.revisions, null, "a chain that leads nowhere is not counted");
});

test("a file over the in-process cap is not scanned, and a reader that holds the file refuses it", async () => {
  const big = { ...(await sourceOf("big.pdf", textPdf(["Large."]))), bytes: SOURCE_BYTES_IN_PROCESS + 1 };
  const refused = await pdfDocument(big, { env, providers: [unpdf] });
  assert.equal(refused.ok, false);
  assert.equal(refused.miss.code, "over_budget");
  assert.match(refused.miss.detail, /64 MiB.*poppler-utils/);
  // A provider that works on the file where it is reads it; the facts it cannot scan are null, and a provider with no sizes gives none.
  const document = Buffer.from(JSON.stringify({ pages: [{ text: "Large.", width: 612, height: 792 }] }));
  const named = { path: await dir.file("big.json", document), kind: "pdf", bytes: SOURCE_BYTES_IN_PROCESS + 1, sha256: createHash("sha256").update(document).digest("hex") };
  const facts = ok(await pdfDocument(named, { env, providers: [fakeProvider()] })).facts;
  assert.deepEqual([facts.revisions, facts.signatures, facts.pages, facts.pageSizes], [null, null, 1, []]);
});

test("text by page, with a mark on each page and the pages with no text layer listed", async () => {
  const mixed = await sourceOf("mixed.pdf", mixedPdf(6, 4));
  const doc = ok(await pdfDocument(mixed, { env, providers: [unpdf] }));
  assert.deepEqual(doc.facts.textPages, [1, 2, 3, 5, 6]);
  assert.deepEqual(doc.pages.map((text) => text.split("\n")[0]), ["Section 1", "Section 2", "Section 3", "", "Section 5", "Section 6"]);
  const marked = pdfMarkedText(doc.pages);
  assert.match(marked, /^--- page 1 ---\nSection 1\nLedger entry 1 reads ZK-5000/);
  assert.match(marked, /--- page 4 \(no text layer: read with page=4 to look at it\) ---\n\n--- page 5 ---/);
  assert.deepEqual([doc.madeBy.provider, typeof doc.madeBy.version], ["unpdf", "string"]);
});

test("a render is the page's points times dpi over 72, rounded up, in the colours it has", async () => {
  const sizes = [[1, 150, 1275, 1650], [2, 150, 1042, 625], [3, 150, 1241, 1754], [4, 150, 625, 625], [1, 72, 612, 792]];
  for (const [page, dpi, width, height] of sizes) {
    const image = ok(await pdfPage(odd, { env, providers: [pdfium] }, { page, dpi })).image;
    assert.deepEqual([image.mimeType, image.width, image.height], ["image/png", width, height], `page ${page} at ${dpi} dpi`);
    const meta = await sharp(image.data).metadata();
    assert.deepEqual([meta.width, meta.height], [width, height], "the PNG says what the result says");
  }
  const halves = await sourceOf("halves.pdf", documentPdf([{ content: "1 0 0 rg 0 0 306 792 re f 0 0 1 rg 306 0 306 792 re f" }]));
  const { data, info } = await sharp(ok(await pdfPage(halves, { env, providers: [pdfium] }, { page: 1, dpi: 72 })).image.data).raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.deepEqual([at(100, 100), at(500, 100)], [[255, 0, 0], [0, 0, 255]], "red on the left, blue on the right");
});

test("a page that does not exist is an unreadable miss naming it", async () => {
  const missed = await pdfPage(odd, { env, providers: [pdfium] }, { page: 9, dpi: 150 });
  assert.equal(missed.ok, false);
  assert.equal(missed.miss.code, "unreadable");
  assert.match(missed.miss.detail, /page 9 is past the end of the document \(4 pages\)/);
  await assert.rejects(pdfPage(odd, { env, providers: [pdfium] }, { page: 0, dpi: 150 }), RangeError);
});

test("a derivation is made once, named by the source's hash, the provider and its parameters, and no temp name stays", async () => {
  const deriveDir = `${dir.path}/derived`;
  let reads = 0;
  const counted = { ...unpdf, document: async (...args) => { reads++; return unpdf.document(...args); } };
  const mixed = await sourceOf("kept.pdf", mixedPdf(3, 2));
  const first = ok(await pdfDocument(mixed, { env, providers: [counted], deriveDir }));
  const second = ok(await pdfDocument(mixed, { env, providers: [counted], deriveDir }));
  assert.deepEqual(second, first);
  assert.equal(reads, 1, "the second read came from the derive directory");
  const page = ok(await pdfPage(mixed, { env, providers: [pdfium], deriveDir }, { page: 2, dpi: 100 }));
  assert.equal(ok(await pdfPage(mixed, { env, providers: [pdfium], deriveDir }, { page: 2, dpi: 100 })).path, page.path);
  const names = (await readdir(deriveDir)).sort();
  const prefix = mixed.sha256.slice(0, 16);
  assert.deepEqual(names, [`${prefix}-p2-100dpi.pdfium-${page.madeBy.version}.png`, `${prefix}.unpdf-${first.madeBy.version}.pdf.json`]);
});

test("providers are tried in order, the first that reads the file answers and names itself, and none that runs here is a `needs` miss", async () => {
  const broken = { name: "broken", capabilities: ["text"], kinds: ["pdf"], detect: async () => ({ available: true, version: "0" }), text: async () => { throw new Error("cannot parse the xref\nsecond line"); } };
  const absent = { name: "absent", capabilities: ["text"], kinds: ["pdf"], detect: async () => ({ available: false, needs: "a thing", reason: "not installed" }) };
  const one = await sourceOf("one.pdf", textPdf(["Read by the second."]));
  assert.equal(ok(await pdfDocument(one, { env, providers: [absent, broken, unpdf] })).madeBy.provider, "unpdf");
  const none = await pdfDocument(one, { env, providers: [absent] });
  assert.deepEqual([none.ok, none.miss.code], [false, "needs"]);
  assert.match(none.miss.detail, /a thing \(not installed\)/);
  const failed = await pdfDocument(one, { env, providers: [absent, broken] });
  assert.deepEqual([failed.miss.code, failed.miss.detail], ["unreadable", "cannot parse the xref (broken)"]);
});

test("poppler that is not in the environment is a `needs` miss, and the zero-install reader behind it answers", async () => {
  const bare = new Proxy(env, { get: (target, key) => (key === "exec" ? async () => ({ ok: true, value: { exitCode: 127 } }) : Reflect.get(target, key)?.bind?.(target) ?? Reflect.get(target, key)) });
  const one = await sourceOf("bare.pdf", textPdf(["No poppler here."]));
  const only = await pdfDocument(one, { env: bare, providers: [popplerProvider()] });
  assert.deepEqual([only.ok, only.miss.code], [false, "needs"]);
  assert.match(only.miss.detail, /poppler-utils \(pdftotext, pdftoppm, pdfinfo\)/);
  assert.equal(ok(await pdfDocument(one, { env: bare, providers: [popplerProvider(), unpdf] })).madeBy.provider, "unpdf");
});

test("a password-protected PDF is an unreadable miss for its text and for its pages, in the engine's own words", async () => {
  const locked = await sourceOf("locked.pdf", encryptedPdf());
  const text = await pdfDocument(locked, { env, providers: [unpdf] });
  assert.deepEqual([text.ok, text.miss.code, text.miss.detail], [false, "unreadable", "the document is password-protected (unpdf)"]);
  const page = await pdfPage(locked, { env, providers: [pdfium] }, { page: 1, dpi: 150 });
  assert.deepEqual([page.ok, page.miss.code], [false, "unreadable"]);
  assert.match(page.miss.detail, /password.*\(pdfium\)$/i);
});

/** A worker that is still running burns a core: once its call has settled, the process is idle. */
const quiet = async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const used = process.cpuUsage(before);
  assert.ok((used.user + used.system) / 1000 < 300, `the process used ${Math.round((used.user + used.system) / 1000)} ms of CPU in 600 ms after the call settled`);
};

test("a render cut at its time cap is an over_budget miss, and the next render is unaffected", async () => {
  const result = await pdfPage(docs.letter, { env, providers: [pdfiumProvider({ timeoutMs: 20 })] }, { page: 1, dpi: 150 });
  assert.deepEqual([result.ok, result.miss.code, result.miss.detail], [false, "over_budget", "the PDF engine did not finish within 0.02 s (pdfium)"]);
  assert.equal(ok(await pdfPage(docs.letter, { env, providers: [pdfium] }, { page: 1, dpi: 72 })).image.width, 612);
});

test("a form that draws itself a hundred times over four levels ends in an over_budget miss at the time cap, and its engine stops running", async () => {
  const endless = await sourceOf("endless.pdf", endlessPdf());
  const started = Date.now();
  const result = await pdfPage(endless, { env, providers: [pdfiumProvider({ timeoutMs: 400, memoryMb: 1900 })] }, { page: 1, dpi: 150 });
  assert.deepEqual([result.ok, result.miss.code], [false, "over_budget"]);
  assert.match(result.miss.detail, /^the PDF engine (did not finish within 0\.4 s|needed more than 1900 MB) \(pdfium\)$/);
  assert.ok(Date.now() - started < 10_000, "inside the cap and its overhead");
  await quiet();
  assert.equal(ok(await pdfPage(docs.letter, { env, providers: [pdfium] }, { page: 1, dpi: 72 })).image.width, 612, "the next render is unaffected");
});

test("PDFium's own memory is capped, which the worker's heap limit does not do: past it the render is an over_budget miss naming the cap", async () => {
  const endless = await sourceOf("endless-memory.pdf", endlessPdf());
  const result = await pdfPage(endless, { env, providers: [pdfiumProvider({ timeoutMs: 60_000, memoryMb: 256 })] }, { page: 1, dpi: 150 });
  assert.deepEqual([result.ok, result.miss.code, result.miss.detail], [false, "over_budget", "the PDF engine needed more than 256 MB (pdfium)"]);
  assert.equal(ok(await pdfPage(docs.letter, { env, providers: [pdfiumProvider({ memoryMb: 256 })] }, { page: 1, dpi: 150 })).image.width, 1275, "an ordinary page fits in it");
});

test("a render that is cancelled stops its engine and rejects with the caller's reason", async () => {
  const endless = await sourceOf("endless-cancel.pdf", endlessPdf());
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("the run was cancelled")), 300);
  await assert.rejects(pdfPage(endless, { env, providers: [pdfiumProvider({ memoryMb: 1900 })], signal: stop.signal }, { page: 1, dpi: 150 }), /the run was cancelled/);
  await quiet();
});

test("a process that renders a file that never ends exits on its own once the miss is returned", () => {
  const script = `
    import { writeFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
    import { pdfPage } from "@parcha/pi-vision";
    import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
    import { endlessPdf } from ${JSON.stringify(new URL("./support/pdf-builders.mjs", import.meta.url).href)};
    const bytes = endlessPdf();
    writeFileSync(${JSON.stringify(`${dir.path}/exits.pdf`)}, bytes);
    const source = { path: ${JSON.stringify(`${dir.path}/exits.pdf`)}, kind: "pdf", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const result = await pdfPage(source, { env: new NodeExecutionEnv({ cwd: ${JSON.stringify(dir.path)} }), providers: [pdfiumProvider({ timeoutMs: 1000 })] }, { page: 1, dpi: 150 });
    console.log(JSON.stringify(result));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000 });
  assert.equal(JSON.parse(out).ok, false, out);
});

test("an engine's worker sees none of the host's environment and writes nothing to the host's output", () => {
  const script = `
    import { runPdfWorker } from "@parcha/pi-vision";
    const worker = 'const { parentPort } = process.getBuiltinModule("node:worker_threads"); console.error("noise"); console.log("noise"); parentPort.postMessage({ value: Object.keys(process.env) });';
    console.log(JSON.stringify(await runPdfWorker(worker, {}, { timeoutMs: 10000, memoryMb: 64 })));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000, env: { ...process.env, PI_VISION_TEST_KEY: "sentinel-value" } });
  assert.deepEqual([run.status, run.stdout.trim(), run.stderr], [0, "[]", ""]);
});

test("a word shown a hundred million times runs the text reader out of heap inside its worker: a miss, and the host lives", async () => {
  const bomb = await sourceOf("text-bomb.pdf", endlessPdf({ text: true }));
  const started = Date.now();
  const result = await pdfDocument(bomb, { env, providers: [unpdfProvider({ memoryMb: 96, timeoutMs: 60_000 })] });
  assert.deepEqual([result.ok, result.miss.code, result.miss.detail], [false, "over_budget", "the PDF engine needed more than 96 MB (unpdf)"]);
  assert.ok(Date.now() - started < 30_000);
  assert.equal(ok(await pdfDocument(odd, { env, providers: [unpdf] })).facts.pages, 4, "the next read is unaffected");
});

test("a form that draws no text costs the text reader nothing", async () => {
  const quiet = await sourceOf("endless-quiet.pdf", endlessPdf());
  assert.deepEqual(ok(await pdfDocument(quiet, { env, providers: [unpdf] })).pages, [""]);
});

test("a page the size of a building is refused at a dpi that would make gigapixels and drawn at the dpi the planner picks", async () => {
  const huge = await sourceOf("huge.pdf", hugePagePdf(14400));
  const refused = await pdfPage(huge, { env, providers: [pdfium] }, { page: 1, dpi: 150 });
  assert.deepEqual([refused.ok, refused.miss.code], [false, "over_budget"]);
  assert.match(refused.miss.detail, /page 1 at 150 dpi is 30000x30000 px, over the 25000000 pixel cap; render it at a lower dpi/);
  assert.equal(ok(await pdfDocument(huge, { env, providers: [unpdf] })).facts.pageSizes[0].width, 14400, "its facts are free");
  const drawn = ok(await pdfPage(huge, { env, providers: [pdfium] }, { page: 1, dpi: 10 })).image;
  assert.deepEqual([drawn.width, drawn.height], [2000, 2000]);
  const largest = ok(await pdfPage(huge, { env, providers: [pdfium] }, { page: 1, dpi: 25 })).image;
  assert.deepEqual([largest.width, largest.height], [5000, 5000], "the largest render the pixel cap allows fits in the default memory cap");
});

test("the text of a fetched PDF, page by page, and nothing for a scan, a password or bytes that are not a PDF", async () => {
  const providers = [unpdf];
  assert.match(await pdfText(textPdf(["Fixture line one"]), { env, providers }), /^\[page 1\]\nFixture line one$/);
  assert.equal(await pdfText(new Uint8Array(0), { env, providers }), null);
  assert.equal(await pdfText(documentPdf([{ scan: true }]), { env, providers }), null);
  assert.equal(await pdfText(encryptedPdf(), { env, providers }), null);
  assert.equal(await pdfText(Buffer.from("<html>not a pdf</html>"), { env, providers }), null);
  assert.equal(await pdfText(textPdf(["Never read."]), { env, providers: [] }), null);
  assert.deepEqual((await readdir(dir.path)).filter((name) => name.startsWith("pi-vision-pdf")), [], "no scratch directory is left");
});

test("a caller that stopped waiting gets no text and starts no reader", async () => {
  const stopped = new AbortController();
  stopped.abort(new Error("deadline"));
  let started = false;
  const watching = { ...unpdf, document: async (...args) => { started = true; return unpdf.document(...args); } };
  assert.equal(await pdfText(textPdf(["Fixture line one"]), { env, providers: [watching], signal: stopped.signal }), null);
  assert.equal(started, false);
});

test("a damaged kept render is made again, not trusted", async () => {
  const deriveDir = `${dir.path}/derived-damaged`;
  const ctx = { env, providers: [pdfium], deriveDir };
  const made = ok(await pdfPage(docs.letter, ctx, { page: 1, dpi: 50 }));
  for (const damaged of [made.image.data.subarray(0, 40), made.image.data.subarray(0, made.image.data.length - 5), Buffer.from("not a png")]) {
    await writeFile(made.path, damaged);
    const again = ok(await pdfPage(docs.letter, ctx, { page: 1, dpi: 50 }));
    assert.deepEqual([again.image.width, again.image.height, again.image.data.length], [made.image.width, made.image.height, made.image.data.length]);
    assert.equal((await readFile(made.path)).length, made.image.data.length, "the kept file is whole again");
  }
});

const fixtures = conformanceFixtures(docs);
registerProviderConformance({ provider: unpdf, env: () => env, fixtures });
registerProviderConformance({ provider: pdfium, env: () => env, fixtures });
