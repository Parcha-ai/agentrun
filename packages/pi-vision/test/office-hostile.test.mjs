// Hostile office files, built here: each is a typed miss inside a bounded time and memory, never a hang, a crash or a
// huge string handed to the model. The sizes are real (a 40 MiB bomb is built and deflated in the test), so the caps
// are exercised as the defaults are set; the few tests that lower a limit say so.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { OFFICE_LIMITS, OfficeMissError, zipDirectory } from "@parcha/pi-vision";
import { officeJsProvider } from "@parcha/pi-vision/providers/office-js";
import { strToU8, zipSync } from "fflate";
import { WORD, c, docx, item, odf, para, pptx, sheetXml, shape, workspace, wordPart, xlsx } from "./office-fixtures.mjs";

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
/** The same call, timed: a hostile file is answered within `ms`. */
const within = async (ms, run) => {
  const started = performance.now();
  try {
    return await run();
  } finally {
    assert.ok(performance.now() - started < ms, `answered within ${ms} ms, took ${Math.round(performance.now() - started)} ms`);
  }
};
const centralEntries = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = [];
  for (let i = 0; i + 4 < bytes.length; i++) if (view.getUint32(i, true) === 0x02014b50) at.push(i);
  return { view, at };
};
const bomb = (mib) => zipSync({ "word/document.xml": new Uint8Array(mib * MiB) }, { level: 1 });

test("a zip bomb that declares its size is refused by its ratio before anything is inflated", async (t) => {
  const bytes = bomb(120);
  assert.ok(bytes.length < 400 * 1024, `120 MiB of zeros deflates to ${bytes.length} bytes`);
  await within(1500, () => assert.rejects(textOf(t, bytes), misses("over_budget", /declares 120\.0 MiB from 0\.[0-9] MiB, over 100 to 1/)));
});

test("a zip bomb that lies about its size is stopped by the size it declares while it inflates, in one push of the inflater", async (t) => {
  const bytes = bomb(40);
  const { view, at } = centralEntries(bytes);
  view.setUint32(at[0] + 24, 1000, true);
  assert.equal(zipDirectory(bytes)[0].originalSize, 1000, "the directory now declares 1000 bytes, which passes every declared check");
  const w = await workspace(t);
  const error = await within(1500, () => w.source("lie.docx", bytes).then((source) => provider.text(source, {}, w.call())).then(() => assert.fail("read a bomb"), (e) => e));
  assert.ok(error instanceof OfficeMissError && error.code === "unreadable" && error.message === "word/document.xml inflates past the size its directory declares", error.message);
});

test("an archive of too many entries is refused by the count", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 12_000 }, (_, i) => [`f${i}.txt`, new Uint8Array(1)]));
  await within(1500, () => assert.rejects(textOf(t, zipSync(files)), misses("over_budget", /holds 12000 entries, over the 10000 the reader takes/)));
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
  await within(1500, () => assert.rejects(textOf(t, bytes), misses("over_budget", /word\/document\.xml is 5\.\d MiB, over the 4\.0 MiB the reader takes of one part; read it with bash/)));
});

test("a huge sheet is a typed miss naming the sheet's part", async (t) => {
  const rows = [];
  for (let n = 1; rows.length < 35_000; n++) rows.push([n, c(`A${n}`, `<v>${Math.random()}</v>`), c(`B${n}`, `<v>${Math.random()}</v>`), c(`C${n}`, `<v>${Math.random()}</v>`)]);
  const bytes = xlsx({ sheets: [{ name: "Big", xml: sheetXml(rows) }] });
  await within(3000, () => assert.rejects(cellsOf(t, bytes), misses("over_budget", /xl\/worksheets\/sheet1\.xml is \d+\.\d MiB, over the 4\.0 MiB/)));
});

test("a sheet whose repeat counts expand to billions of cells stops at the cell cap, quickly", async (t) => {
  const body = '<table:table table:name="Wide"><table:table-row table:number-rows-repeated="1048576"><table:table-cell office:value-type="string"><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16384" office:value-type="float" office:value="1"/></table:table-row></table:table>';
  await within(3000, () => assert.rejects(cellsOf(t, odf("spreadsheet", body)), misses("over_budget", /the sheet Wide holds more than 250000 cells, over what the reader builds/)));
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

test("a document nested far past the stack is a typed miss, not a crash", async (t) => {
  const depth = 20_000;
  const bytes = docx(`${"<w:sdt><w:sdtContent>".repeat(depth)}${para("buried")}${"</w:sdtContent></w:sdt>".repeat(depth)}`);
  await within(5000, () => assert.rejects(textOf(t, bytes), misses("unreadable", /the file could not be read: Maximum call stack size exceeded/)));
});

test("an entity bomb is not expanded: the part is unreadable, and nothing of it reaches the text", async (t) => {
  const lol = '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">]>';
  const bytes = zipSync({ "word/document.xml": strToU8(`<?xml version="1.0"?>${lol}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&d;</w:t></w:r></w:p></w:body></w:document>`) });
  await within(1500, () => assert.rejects(textOf(t, bytes), misses("unreadable", /the file could not be read: .*entity not found/)));
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
  await within(2000, () => assert.rejects(textOf(t, odf("text", nest(9))), misses("over_budget", /the text of this file grows past what the reader builds/)));
});

test("a table row that repeats is read as many times as it says, empty repeated rows cost nothing, and a repeat of billions is over budget", async (t) => {
  const row = (times, cell) => `<table:table-row table:number-rows-repeated="${times}"><table:table-cell>${cell}</table:table-cell></table:table-row>`;
  assert.deepEqual(await textOf(t, odf("text", `<table:table>${row(3, "<text:p>again</text:p>")}${row(1_048_000, "")}</table:table>`)), [{ page: 1, text: "| again |\n| again |\n| again |" }]);
  await within(2000, () => assert.rejects(textOf(t, odf("text", `<table:table>${row(1_048_576, "<text:p>again</text:p>")}</table:table>`)), misses("over_budget", /the text of this file grows past what the reader builds/)));
});

test("list labels that grow with the number they start at are charged to the text budget, like any other text", async (t) => {
  const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="${WORD}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="32767"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const few = docx(Array.from({ length: 10 }, () => item("x", 1)).join(""), { "word/numbering.xml": numbering });
  assert.equal((await textOf(t, few))[0].text.split("\n").length, 10, "ten such labels read");
  const many = docx(Array.from({ length: 4000 }, () => item("x", 1)).join(""), { "word/numbering.xml": numbering });
  await within(3000, () => assert.rejects(textOf(t, many), misses("over_budget", /the text of this file grows past what the reader builds/)));
});
