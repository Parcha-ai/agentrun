// Hostile office files, built here: each is a typed miss inside bounded work and memory, never a hang, a crash or a
// huge string handed to the model. The sizes are real (a 40 MiB bomb is built and deflated in the test), so the caps
// are exercised as the defaults are set; the few tests that lower a limit say so. The bound is held in work, counted
// by `countWork` (bytes inflated, cells built, the longest string joined), never in milliseconds: a loaded machine
// would flake a time bound, and a reader whose cap was removed fails these tests by the work it does.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { OFFICE_LIMITS, OfficeMissError, zipDirectory } from "@parcha/pi-vision";
import { officeJsProvider } from "@parcha/pi-vision/providers/office-js";
import { strToU8, zipSync } from "fflate";
import { WORD, c, docx, item, odf, para, pptx, sheetXml, shape, workspace, wordPart, xlsx } from "./office-fixtures.mjs";
import { countWork } from "./office-work.mjs";

const provider = officeJsProvider();
const MiB = 1024 * 1024;
const misses = (code, message) => (error) => error instanceof OfficeMissError && error.code === code && message.test(error.message);
const textOf = async (t, bytes, request = {}, p = provider) => {
  const w = await workspace(t);
  return (await p.text(await w.source("hostile.bin", bytes), request, w.call())).pages;
};
const cellsOf = async (t, bytes) => {
  const w = await workspace(t);
  return (await provider.cells(await w.source("hostile.bin", bytes, "sheet"), {}, w.call())).sheets;
};
const centralEntries = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = [];
  for (let i = 0; i + 4 < bytes.length; i++) if (view.getUint32(i, true) === 0x02014b50) at.push(i);
  return { view, at };
};
const bomb = (mib) => zipSync({ "word/document.xml": new Uint8Array(mib * MiB) }, { level: 1 });
/** The most one push of the inflater writes: 8 KiB of compressed bytes at deflate's ceiling of 1,032 to 1. */
const MOST_ONE_PUSH = 8192 * 1032;
/** The longest string a read may build: twice the text budget, which is the part cap. */
const MOST_ONE_STRING = 2 * OFFICE_LIMITS.maxPartBytes;

test("the counters see the inflater: reading a word document inflates its parts, and only those", async (t) => {
  const work = countWork(t);
  assert.equal((await textOf(t, docx(para("x"))))[0].text, "x");
  assert.ok(work.pushes >= 2 && work.bytesOut > 0, `inflated ${work.bytesOut} bytes in ${work.pushes} pushes`);
  assert.ok(work.bytesOut < 20_000, "the parts of a one paragraph document are a few kilobytes");
});

test("a zip bomb that declares its size is refused by its ratio before anything is inflated", async (t) => {
  const bytes = bomb(120);
  assert.ok(bytes.length < 400 * 1024, `120 MiB of zeros deflates to ${bytes.length} bytes`);
  const work = countWork(t);
  await assert.rejects(textOf(t, bytes), misses("over_budget", /declares 120\.0 MiB from 0\.[0-9] MiB, over 100 to 1/));
  assert.equal(work.pushes, 0, "not one byte of it was inflated");
});

test("a zip bomb that lies about its size is stopped by the size it declares while it inflates, in one push of the inflater", async (t) => {
  const bytes = bomb(40);
  const { view, at } = centralEntries(bytes);
  view.setUint32(at[0] + 24, 1000, true);
  assert.equal(zipDirectory(bytes)[0].originalSize, 1000, "the directory now declares 1000 bytes, which passes every declared check");
  const w = await workspace(t);
  const work = countWork(t);
  const error = await w.source("lie.docx", bytes).then((source) => provider.text(source, {}, w.call())).then(() => assert.fail("read a bomb"), (e) => e);
  assert.ok(error instanceof OfficeMissError && error.code === "unreadable" && error.message === "word/document.xml inflates past the size its directory declares", error.message);
  assert.equal(work.pushes, 1, "it was stopped by the first push of the inflater");
  assert.ok(work.bytesOut > 1000 && work.bytesOut <= MOST_ONE_PUSH, `${work.bytesOut} of its 40 MiB were inflated, at most one push's worth`);
});

test("an archive of too many entries is refused by the count", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`f${i}.txt`, new Uint8Array(1)]));
  const work = countWork(t);
  await assert.rejects(textOf(t, zipSync(files)), misses("over_budget", /holds 12000 entries, over the 10000 the reader takes/));
  assert.equal(work.pushes, 0, "no entry was inflated");
});

test("an archive that declares more than the total allowed is refused, and the limits are set per provider", async (t) => {
  const bytes = zipSync({ "word/document.xml": strToU8(para("x")), "word/media/a.bin": randomBytes(300_000), "word/media/b.bin": randomBytes(300_000) });
  assert.equal(zipDirectory(bytes).length, 3);
  assert.throws(() => zipDirectory(bytes, { ...OFFICE_LIMITS, maxUncompressedBytes: 500_000 }), misses("over_budget", /declares 0\.6 MiB uncompressed, over the 0\.5 MiB the reader takes/));
  await assert.rejects(textOf(t, bytes, {}, officeJsProvider({ limits: { maxUncompressedBytes: 500_000 } })), misses("over_budget", /declares 0\.6 MiB uncompressed/));
});

test("a part over the cap is refused by its size without being parsed, however it compresses", async (t) => {
  const filler = randomBytes(Math.floor(3.9 * MiB)).toString("base64");
  const bytes = zipSync({ "word/document.xml": strToU8(`<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${filler}</w:t></w:r></w:p></w:body></w:document>`) });
  assert.ok(bytes.length < 5.3 * MiB && bytes.length > 3.5 * MiB, "incompressible, so the ratio guard does not fire");
  const work = countWork(t);
  await assert.rejects(textOf(t, bytes), misses("over_budget", /word\/document\.xml is 5\.\d MiB, over the 4\.0 MiB the reader takes of one part; read it with bash/));
  assert.equal(work.pushes, 0, "it was refused by its declared size, before a byte of it was inflated");
});

test("a huge sheet is a typed miss naming the sheet's part", async (t) => {
  const rows = [];
  for (let n = 1; rows.length < 35_000; n++) rows.push([n, c(`A${n}`, `<v>${Math.random()}</v>`), c(`B${n}`, `<v>${Math.random()}</v>`), c(`C${n}`, `<v>${Math.random()}</v>`)]);
  const bytes = xlsx({ sheets: [{ name: "Big", xml: sheetXml(rows) }] });
  const work = countWork(t);
  await assert.rejects(cellsOf(t, bytes), misses("over_budget", /xl\/worksheets\/sheet1\.xml is \d+\.\d MiB, over the 4\.0 MiB/));
  assert.ok(work.bytesOut < 200_000, `${work.bytesOut} bytes inflated: the workbook's small parts, never the sheet`);
});

test("a sheet whose repeat counts expand to billions of cells stops at the cell cap", async (t) => {
  const body = '<table:table table:name="Wide"><table:table-row table:number-rows-repeated="1048576"><table:table-cell office:value-type="string"><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16384" office:value-type="float" office:value="1"/></table:table-row></table:table>';
  const work = countWork(t, { cells: OFFICE_LIMITS.maxCells });
  await assert.rejects(cellsOf(t, odf("spreadsheet", body)), misses("over_budget", /the sheet Wide holds more than 250000 cells, over what the reader builds/));
  assert.equal(work.cells, OFFICE_LIMITS.maxCells, "it built the cap and not one cell more");
});

test("repeat and span counts that name billions read as the widest a table or sheet can be", async (t) => {
  const word = docx(`<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2000000000"/></w:tcPr>${para("wide")}</w:tc></w:tr></w:tbl>`);
  const [{ text }] = await textOf(t, word);
  assert.equal([...text].filter((ch) => ch === "|").length, 64, "a span of 2 billion columns is 63 columns: 64 bars");
  const body = '<text:p>a<text:s text:c="2000000000"/>b</text:p><text:h text:outline-level="1000000">deep</text:h><table:table><table:table-row><table:table-cell table:number-columns-repeated="2000000000"><text:p>r</text:p></table:table-cell></table:table-row></table:table>';
  const [odt] = await textOf(t, odf("text", body));
  const lines = odt.text.split("\n");
  assert.equal(lines[0], `a${" ".repeat(80)}b`);
  assert.equal(lines[1], "###### deep");
  assert.equal(lines[2].split(" | ").length, 63);
});

test("a part nested deeper than the reader walks is over budget before it is walked, however deep", async (t) => {
  const nested = (depth) => docx(`${"<w:sdt><w:sdtContent>".repeat(depth)}${para("buried")}${"</w:sdtContent></w:sdt>".repeat(depth)}`);
  assert.equal((await textOf(t, nested(100)))[0].text, "buried", "a hundred levels read");
  await assert.rejects(textOf(t, nested(20_000)), misses("over_budget", /^word\/document\.xml nests more than 256 levels deep/));
  await assert.rejects(textOf(t, nested(130)), misses("over_budget", /nests more than 256 levels deep/), "an sdt and its content are two levels each");
});

test("a part with more elements than the reader takes is over budget before it is parsed", async (t) => {
  const dense = (count) => docx(`<w:p>${"<w:r/>".repeat(count)}<w:r><w:t>x</w:t></w:r></w:p>`);
  const lenient = officeJsProvider({ limits: { maxRatio: 1_000_000 } });
  assert.equal((await textOf(t, dense(1000), {}, lenient))[0].text, "x");
  await assert.rejects(textOf(t, dense(520_000), {}, lenient), misses("over_budget", /^word\/document\.xml holds 520\d{3} elements, over the 500000 the reader takes of one part/));
});

test("an entity bomb is not expanded: the part is unreadable, and nothing of it reaches the text", async (t) => {
  const lol = '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]>';
  const bytes = zipSync({ "word/document.xml": strToU8(`<?xml version="1.0"?>${lol}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&d;</w:t></w:r></w:p></w:body></w:document>`) });
  await assert.rejects(textOf(t, bytes), misses("unreadable", /the file could not be read: .*entity not found/));
});

test("a file with a deck of parts is held to the parsed total, and the total is the provider's to set", async (t) => {
  const slides = Array.from({ length: 30 }, (_, i) => ({ shapes: [shape([`Slide ${i + 1} ${"word ".repeat(200)}`])] }));
  const bytes = pptx(slides);
  assert.equal((await textOf(t, bytes)).length, 30);
  await assert.rejects(textOf(t, bytes, {}, officeJsProvider({ limits: { maxParsedBytes: 20_000 } })), misses("over_budget", /the parts of this file pass 0\.0 MiB, the most the reader parses in one read/));
  assert.equal((await textOf(t, bytes, { pages: { from: 1, to: 2 } }, officeJsProvider({ limits: { maxParsedBytes: 20_000 } }))).length, 2, "reading two slides parses two slides and their relationships, not the deck");
});

test("a damaged archive is a typed miss at each place it can be damaged", async (t) => {
  const good = docx(para("x"));
  const patched = (bytes, change) => {
    const copy = bytes.slice();
    change(new DataView(copy.buffer), copy);
    return copy;
  };
  const end = good.length - 22;
  const named = (bytes, name) => centralEntries(bytes).at.find((at) => Buffer.from(bytes.subarray(at + 46, at + 46 + bytes[at + 28])).toString() === name);
  const document = named(good, "word/document.xml");
  await assert.rejects(textOf(t, patched(good, (v) => v.setUint16(end + 10, 0xffff, true))), misses("over_budget", /is a zip64 archive/));
  await assert.rejects(textOf(t, patched(good, (v) => v.setUint32(end + 16, good.length + 1000, true))), misses("unreadable", /the directory runs past the end of the file/));
  await assert.rejects(textOf(t, patched(good, (v) => v.setUint32(document, 0x12345678, true))), misses("unreadable", /a directory entry is damaged/));
  await assert.rejects(textOf(t, patched(good, (v) => v.setUint32(v.getUint32(document + 42, true), 0, true))), misses("unreadable", /word\/document\.xml has a damaged header/));
  await assert.rejects(textOf(t, patched(good, (v) => v.setUint16(document + 10, 9, true))), misses("unsupported", /word\/document\.xml uses compression method 9/));
  await assert.rejects(textOf(t, patched(good, (v) => v.setUint32(document + 20, 0xffffffff, true))), misses("over_budget", /is a zip64 archive/));
  await assert.rejects(textOf(t, patched(good, (v) => v.setUint32(document + 20, good.length + 100, true))), misses("unreadable", /word\/document\.xml is cut short/));
  const twins = zipSync({ "a.xml": strToU8("<a/>"), "b.xml": strToU8("<b/>") });
  const second = named(twins, "b.xml");
  await assert.rejects(textOf(t, patched(twins, (v, b) => b.set(strToU8("a.xml"), second + 46))), misses("unreadable", /a\.xml appears twice/));
});

test("a cancelled call is a cancellation, not a miss", async (t) => {
  const w = await workspace(t);
  const controller = new AbortController();
  const source = await w.source("late.docx", docx(para("x")));
  controller.abort(new Error("the run was cancelled"));
  await assert.rejects(provider.text(source, {}, w.call(controller.signal)), (error) => error.message === "the run was cancelled");
  await assert.rejects(provider.cells(source, {}, w.call(controller.signal)), (error) => error.message === "the run was cancelled");
});

test("a part that is not XML is unreadable, not empty text, and a package with no main part is not a word document", async (t) => {
  const bytes = docx(para("x"), { "word/header1.xml": "this is not xml at all <<<" });
  await assert.rejects(textOf(t, bytes), misses("unreadable", /the file could not be read/));
  const noBody = zipSync({ "word/numbering.xml": strToU8(wordPart("numbering", "")) });
  await assert.rejects(textOf(t, noBody), misses("unsupported", /not a docx/));
});

test("a file larger than it was described as is refused by its real size, before it is read", async (t) => {
  const w = await workspace(t);
  const source = { ...(await w.source("grown.docx", new Uint8Array(65 * MiB))), bytes: 100 };
  await assert.rejects(provider.text(source, {}, w.call()), misses("over_budget", /65\.0 MiB is over the 64\.0 MiB the reader takes into memory/));
});

test("tables nested in tables that repeat their cells are held to the text budget before they are built", async (t) => {
  const nest = (depth) => (depth === 0 ? "<text:p>seed</text:p>" : `<table:table><table:table-row><table:table-cell table:number-columns-repeated="63">${nest(depth - 1)}</table:table-cell></table:table-row></table:table>`);
  const [{ text }] = await textOf(t, odf("text", nest(1)));
  assert.equal(text.split(" | ").length, 63, "one level reads");
  const work = countWork(t, { join: MOST_ONE_STRING });
  await assert.rejects(textOf(t, odf("text", nest(9))), misses("over_budget", /the text of this file grows past what the reader builds/));
  assert.ok(work.longestJoin <= MOST_ONE_STRING, `the longest string built was ${work.longestJoin} characters`);
});

test("a table row that repeats is read as many times as it says, empty repeated rows cost nothing, and a repeat of billions is over budget", async (t) => {
  const row = (times, cell) => `<table:table-row table:number-rows-repeated="${times}"><table:table-cell>${cell}</table:table-cell></table:table-row>`;
  assert.deepEqual(await textOf(t, odf("text", `<table:table>${row(3, "<text:p>again</text:p>")}${row(1_048_000, "")}</table:table>`)), [{ page: 1, text: "| again |\n| again |\n| again |" }]);
  const work = countWork(t, { join: MOST_ONE_STRING });
  await assert.rejects(textOf(t, odf("text", `<table:table>${row(1_048_576, "<text:p>again</text:p>")}</table:table>`)), misses("over_budget", /the text of this file grows past what the reader builds/));
  assert.ok(work.longestJoin <= MOST_ONE_STRING, "the million rows were never joined into one string");
});

test("list labels that grow with the number they start at are charged to the text budget, like any other text", async (t) => {
  const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="${WORD}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="32767"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const few = docx(Array.from({ length: 10 }, () => item("x", 1)).join(""), { "word/numbering.xml": numbering });
  assert.equal((await textOf(t, few))[0].text.split("\n").length, 10, "ten such labels read");
  const many = docx(Array.from({ length: 4000 }, () => item("x", 1)).join(""), { "word/numbering.xml": numbering });
  await assert.rejects(textOf(t, many), misses("over_budget", /the text of this file grows past what the reader builds/));
});

test("a shared formula whose master is huge is charged to the text budget once for every cell that shares it", async (t) => {
  const master = randomBytes(750_000).toString("base64");
  const dependents = Array.from({ length: 100 }, (_, i) => c(`A${i + 2}`, '<f t="shared" si="0"/><v>1</v>'));
  const rows = [[1, c("A1", `<f t="shared" ref="A1:A101" si="0">${master}</f><v>1</v>`)], ...dependents.map((cell, i) => [i + 2, cell])];
  const bytes = xlsx({ sheets: [{ name: "S", xml: sheetXml(rows) }] });
  await assert.rejects(cellsOf(t, bytes), misses("over_budget", /the text of this file grows past what the reader builds/));
});

test("a spreadsheet cell with a long value that a repeat count copies thousands of times is charged to the text budget", async (t) => {
  const value = randomBytes(75_000).toString("base64");
  const body = `<table:table table:name="Wide"><table:table-row><table:table-cell table:number-columns-repeated="16384" office:value-type="string" office:string-value="${value}"/></table:table-row></table:table>`;
  const work = countWork(t);
  await assert.rejects(cellsOf(t, odf("spreadsheet", body)), misses("over_budget", /the text of this file grows past what the reader builds/));
  assert.ok(work.cells < 500, `${work.cells} of the 16,384 copies were built before the budget stopped it`);
});
