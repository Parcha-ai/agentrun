// PDF through the zero-install providers (pdf.js in `unpdf`, PDFium), on files built here: facts, text by page, pages at a
// dpi, what is kept, and the files that must end in a typed miss inside their caps (a password, a form that draws itself
// a hundred times over four levels, a word shown a hundred million times, a page the size of a building). Every file is
// invented; the binaries' suite (test/binaries) holds poppler to the same.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { after, test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import sharp from "sharp";
import { SOURCE_BYTES_IN_PROCESS, pdfDocument, pdfMarkedText, pdfPage, pdfText } from "@parcha/pi-vision";
import { fakeProvider, fixtureDir, registerProviderConformance } from "@parcha/pi-vision/testing";
import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
import { appendRevision, documentPdf, encryptedPdf, endlessPdf, hugePagePdf, mixedPdf, signatureObject, textPdf } from "./support/pdf-builders.mjs";
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

test("saved revisions and signatures are counted in the file's bytes", async () => {
  const once = textPdf(["One save."]);
  const facts = async (name, bytes) => ok(await pdfDocument(await sourceOf(name, bytes), { env, providers: [unpdf] })).facts;
  const plain = await facts("once.pdf", once);
  assert.deepEqual([plain.revisions, plain.signatures], [1, 0]);
  const edited = appendRevision(appendRevision(once, [[3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]], 7), [[3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"]], 7);
  assert.equal((await facts("edited.pdf", edited)).revisions, 3);
  const signed = documentPdf([{ lines: ["Signed."] }], { extra: [signatureObject(), signatureObject()] });
  assert.equal((await facts("signed.pdf", signed)).signatures, 2);
  // A linearized file ends its first-page section with a save marker too; that one is not a revision.
  const linear = appendRevision(textPdf(["Streamed."], { header: "%PDF-1.7\n% << /Linearized 1 >>\n" }), [[3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]], 7);
  assert.equal((await facts("linear.pdf", linear)).revisions, 1);
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

const threads = () => Number(/^Threads:\s+(\d+)/m.exec(execFileSync("cat", ["/proc/self/status"], { encoding: "utf8" }))?.[1]);

test("a form that draws itself a hundred times over four levels ends in an over_budget miss at the render cap, and the engine is gone", { skip: process.platform !== "linux" && "reads /proc" }, async () => {
  const endless = await sourceOf("endless.pdf", endlessPdf());
  const before = threads();
  const started = Date.now();
  const result = await pdfPage(endless, { env, providers: [unpdf, pdfiumProvider({ timeoutMs: 1500 })] }, { page: 1, dpi: 150 });
  assert.deepEqual([result.ok, result.miss.code, result.miss.detail], [false, "over_budget", "the PDF engine did not finish within 2 s (pdfium)"]);
  assert.ok(Date.now() - started < 10_000, "inside the cap and its overhead");
  for (let waited = 0; threads() > before && waited < 50; waited++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(threads() <= before, "the worker thread has exited");
  assert.equal(ok(await pdfPage(odd, { env, providers: [pdfium] }, { page: 1, dpi: 72 })).image.width, 612, "the next render is unaffected");
});

test("a render that is cancelled stops its engine and rejects with the caller's reason", async () => {
  const endless = await sourceOf("endless-cancel.pdf", endlessPdf());
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("the run was cancelled")), 300);
  await assert.rejects(pdfPage(endless, { env, providers: [pdfium], signal: stop.signal }, { page: 1, dpi: 150 }), /the run was cancelled/);
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
  assert.equal(JSON.parse(out).miss.code, "over_budget", out);
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

const fixtures = conformanceFixtures(docs);
registerProviderConformance({ provider: unpdf, env: () => env, fixtures });
registerProviderConformance({ provider: pdfium, env: () => env, fixtures });
