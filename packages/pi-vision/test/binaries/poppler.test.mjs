// Poppler in the environment (`pdftotext -layout`, `pdftoppm`, `pdfinfo`), held to the same suite as the zero-install
// providers and to agreeing with them: text within whitespace, page sizes to the pixel, the same facts. Needs the
// programs: `npm run test:binaries` fails without them, `npm test` does not run this file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { pdfDocument, pdfPage } from "@parcha/pi-vision";
import { fixtureDir, registerProviderConformance } from "@parcha/pi-vision/testing";
import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
import { encryptedPdf, endlessPdf, hugePagePdf } from "../support/pdf-builders.mjs";
import { conformanceFixtures, documents, sourceOf as sourceIn } from "../support/pdf-sources.mjs";

const dir = await fixtureDir("pi-vision-poppler-");
after(() => dir.remove());
const env = new NodeExecutionEnv({ cwd: dir.path });
const sourceOf = (name, bytes) => sourceIn(dir, name, bytes);
const poppler = popplerProvider();
const unpdf = unpdfProvider();
const pdfium = pdfiumProvider();
const docs = await documents(dir);
const ok = (outcome) => { assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.miss.code}: ${outcome.miss.detail}`); return outcome.value; };
const collapse = (text) => text.replace(/\s+/g, " ").trim();

const found = await poppler.detect(env);
/** True when poppler is not here: the test is skipped with the reason, or fails when the binaries job requires it. */
const without = (t) => {
  if (found.available) return false;
  const why = `poppler is not installed (${found.reason})`;
  if (process.env.PI_VISION_REQUIRE_BINARIES === "1") throw new Error(why);
  t.skip(why);
  return true;
};

const fixtures = conformanceFixtures(docs);
registerProviderConformance({ provider: poppler, env: () => env, fixtures });
registerProviderConformance({ provider: poppler, twin: unpdf, env: () => env, fixtures });
registerProviderConformance({ provider: poppler, twin: pdfium, env: () => env, fixtures });

test("poppler names its own version", (t) => {
  if (without(t)) return;
  assert.match(found.version, /^\d+\.\d+/);
});

test("the facts poppler reads and the facts pdf.js reads are the same, and so is the text within whitespace", async (t) => {
  if (without(t)) return;
  for (const source of [docs.letter, docs.six, docs.odd]) {
    const [a, b] = [ok(await pdfDocument(source, { env, providers: [poppler] })), ok(await pdfDocument(source, { env, providers: [unpdf] }))];
    assert.deepEqual([a.madeBy.provider, b.madeBy.provider], ["poppler", "unpdf"]);
    assert.deepEqual([a.facts.pages, a.facts.textPages, a.facts.producer, a.facts.creator, a.facts.revisions, a.facts.signatures], [b.facts.pages, b.facts.textPages, b.facts.producer, b.facts.creator, b.facts.revisions, b.facts.signatures]);
    a.facts.pageSizes.forEach((size, i) => {
      assert.ok(Math.abs(size.width - b.facts.pageSizes[i].width) < 0.01 && Math.abs(size.height - b.facts.pageSizes[i].height) < 0.01, `page ${i + 1} size`);
    });
    assert.deepEqual(a.pages.map(collapse), b.pages.map(collapse));
  }
});

test("a PDF with a password is an unreadable miss from poppler, text and page alike", async (t) => {
  if (without(t)) return;
  const locked = await sourceOf("locked.pdf", encryptedPdf());
  for (const result of [await pdfDocument(locked, { env, providers: [poppler] }), await pdfPage(locked, { env, providers: [poppler] }, { page: 1, dpi: 150 })]) {
    assert.deepEqual([result.ok, result.miss.code], [false, "unreadable"]);
    assert.match(result.miss.detail, /password.*\(poppler\)$/i);
  }
  const both = await pdfDocument(locked, { env, providers: [poppler, unpdf] });
  assert.match(both.miss.detail, /password.*\(poppler\); the document is password-protected \(unpdf\)/i, "each engine's own words, named");
});

test("bytes that are not a PDF are an unreadable miss quoting poppler's first line, and a page past the end names it", async (t) => {
  if (without(t)) return;
  const junk = await sourceOf("junk.pdf", Buffer.from("this is not a PDF\nat all\n"));
  const result = await pdfDocument(junk, { env, providers: [poppler] });
  assert.deepEqual([result.ok, result.miss.code], [false, "unreadable"]);
  assert.match(result.miss.detail, /^[^\n]+ \(poppler\)$/);
  const past = await pdfPage(docs.odd, { env, providers: [poppler] }, { page: 9, dpi: 150 });
  assert.deepEqual([past.ok, past.miss.code], [false, "unreadable"]);
});

test("a render that never ends is cut at poppler's time cap, pdftoppm is gone, and the next render works", async (t) => {
  if (without(t)) return;
  const endless = await sourceOf("endless.pdf", endlessPdf());
  const started = Date.now();
  const result = await pdfPage(endless, { env, providers: [popplerProvider({ timeoutS: 2 })] }, { page: 1, dpi: 150 });
  assert.deepEqual([result.ok, result.miss.code, result.miss.detail], [false, "over_budget", "pdftoppm did not finish within 2 s (poppler)"]);
  assert.ok(Date.now() - started < 15_000);
  const listed = spawnSync("pgrep", ["-f", endless.path]);
  if (!listed.error) assert.equal(listed.status, 1, `no process still holds ${endless.path}`);
  assert.equal(ok(await pdfPage(docs.letter, { env, providers: [poppler] }, { page: 1, dpi: 72 })).image.width, 612);
});

test("when poppler cannot finish a document's text, the reader behind it answers and names itself", async (t) => {
  if (without(t)) return;
  const endless = await sourceOf("endless-text.pdf", endlessPdf());
  const doc = ok(await pdfDocument(endless, { env, providers: [popplerProvider({ timeoutS: 2 }), unpdf] }));
  assert.deepEqual([doc.madeBy.provider, doc.pages], ["unpdf", [""]]);
});

test("a page the size of a building is refused from its size before any pixel is drawn", async (t) => {
  if (without(t)) return;
  const huge = await sourceOf("huge.pdf", hugePagePdf(14400));
  const started = Date.now();
  const result = await pdfPage(huge, { env, providers: [poppler] }, { page: 1, dpi: 150 });
  assert.deepEqual([result.ok, result.miss.code], [false, "over_budget"]);
  assert.match(result.miss.detail, /page 1 at 150 dpi is 30000x30000 px, over the 25000000 pixel cap/);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual([ok(await pdfPage(huge, { env, providers: [poppler] }, { page: 1, dpi: 10 })).image.width], [2000]);
});
