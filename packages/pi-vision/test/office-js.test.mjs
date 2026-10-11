// The office reader on files of each format, built here: what a model reads from them. The expected text in each test
// is what the document says, written out from the fixture and not from the reader's output: a table where it stood, a
// slide in presentation order with its notes, a formula whose result was never stored said so in its cell, a sixteen
// digit number kept as its digits, a date that a number stands for, and the formats the reader refuses named as such.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OfficeMissError } from "@parcha/pi-vision";
import { officeJsProvider } from "@parcha/pi-vision/providers/office-js";
import { fixtureDir, registerProviderConformance } from "@parcha/pi-vision/testing";
import { strToU8, unzipSync, zipSync } from "fflate";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { WORD, c, cell, docx, item, odf, para, pptx, row, sha256, shape, sheetXml, slideTable, table, workspace, wordPart, xlsx } from "./office-fixtures.mjs";

const provider = officeJsProvider();
const textOf = async (t, bytes, request = {}, name = "file.bin", kind = "office") => {
  const w = await workspace(t);
  return (await provider.text(await w.source(name, bytes, kind), request, w.call())).pages;
};
const cellsOf = async (t, bytes, request = {}) => {
  const w = await workspace(t);
  return (await provider.cells(await w.source("file.bin", bytes, "sheet"), request, w.call())).sheets;
};
const misses = (code, message) => (error) => error instanceof OfficeMissError && error.code === code && message.test(error.message);

test("detect names the reader's version and a result names the same one", async (t) => {
  assert.deepEqual(await provider.detect(), { available: true, version: "1" });
  const w = await workspace(t);
  const out = await provider.text(await w.source("a.odt", odf("text", "<text:p>x</text:p>")), {}, w.call());
  assert.deepEqual(out.madeBy, { provider: "office-js", version: "1" });
});

test("a word document reads in order: headings, paragraphs, lists with their numbers, tables with merged cells, headers and footers", async (t) => {
  const body = [
    para("Statement of services", "Heading1"),
    para("Prepared for Quillfeather Holdings by the Orchard Lane Office."),
    item("Bring the signed form", 1),
    item("Bring two letters", 1),
    item("Open the account", 2),
    item("Confirm the address", 2),
    item("Sub step", 2, 1),
    item("Second sub step", 2, 1),
    item("Back at the top", 2),
    table(row(cell(para("Item")), cell(para("Fee"))), row(cell(para("Setup")), cell(para("12.50"))), row(cell(para("Merged note"), 2))),
    '<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:del w:id="1"><w:r><w:delText>removed </w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>added</w:t></w:r></w:ins></w:p>',
    '<w:p><w:r><w:t>Anchor line</w:t></w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Boxed words</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>Boxed words</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:p>',
    "<w:sdt><w:sdtPr/><w:sdtContent>" + para("Inside a content control") + "</w:sdtContent></w:sdt>",
    para("Closing line"),
  ].join("");
  const bytes = docx(body, {
    "word/header1.xml": wordPart("hdr", para("Orchard Lane Office, 100 Example Street")),
    "word/header2.xml": wordPart("hdr", para("Orchard Lane Office, 100 Example Street")),
    "word/footer1.xml": wordPart("ftr", para("Page footer text")),
  });
  const numbering = (await textOf(t, bytes))[0];
  assert.equal(numbering.page, 1);
  assert.equal(numbering.text, [
    "Header: Orchard Lane Office, 100 Example Street",
    "# Statement of services",
    "Prepared for Quillfeather Holdings by the Orchard Lane Office.",
    "- Bring the signed form",
    "- Bring two letters",
    "1. Open the account",
    "2. Confirm the address",
    "  a. Sub step",
    "  b. Second sub step",
    "3. Back at the top",
    "| Item | Fee |",
    "| Setup | 12.50 |",
    "| Merged note |  |",
    "Kept added",
    "Anchor line",
    "Boxed words",
    "Inside a content control",
    "Closing line",
    "Footer: Page footer text",
  ].join("\n"));
});

test("a word list numbered in letters shows letters, one numbered another way shows a bullet, and a restarted list restarts", async (t) => {
  const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerRoman"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num><w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>
  </w:numbering>`;
  const body = [item("first", 1), item("second", 1), item("roman", 2), item("one", 3), item("two", 3), item("separate list", 4)].join("");
  assert.equal((await textOf(t, docx(body, { "word/numbering.xml": numbering })))[0].text, ["a. first", "b. second", "- roman", "1. one", "2. two", "1. separate list"].join("\n"));
});

test("a presentation reads its slides in presentation order, with tables, grouped shapes, notes and hidden slides, and without slide numbers", async (t) => {
  const bytes = pptx([
    { shapes: [shape(["Quarterly review"], "title"), shape(["Revenue grew", '<a:p><a:pPr lvl="1"/><a:r><a:t>Sub point</a:t></a:r></a:p>']), shape(["‹#›"], "sldNum")] },
    { shapes: [slideTable([["Region", "Total"], ["North", "41"]])], notes: ["Mention the late filing", "Ask about the 41"] },
    { shapes: [`<p:grpSp><p:nvGrpSpPr/>${shape(["Grouped words"])}</p:grpSp>`], hidden: true },
  ]);
  const pages = await textOf(t, bytes);
  assert.deepEqual(pages, [
    { page: 1, text: "Quarterly review\nRevenue grew\n  Sub point" },
    { page: 2, text: "| Region | Total |\n| North | 41 |\n\nNotes:\nMention the late filing\nAsk about the 41" },
    { page: 3, text: "(hidden slide)\nGrouped words" },
  ]);
  assert.deepEqual(await textOf(t, bytes, { pages: { from: 2, to: 2 } }), [pages[1]]);
});

const LEDGER = [
  [1, c("A1", "<v>0</v>", ' t="s"'), c("B1", "<v>1</v>", ' t="s"'), c("C1", "<v>2</v>", ' t="s"'), c("D1", "<v>3</v>", ' t="s"'), c("E1", "<v>4</v>", ' t="s"')],
  [2, c("A2", "<v>5</v>", ' t="s"'), c("B2", "<v>45292</v>", ' s="1"'), c("C2", "<v>120.5</v>"), c("D2", "<f>SUM(C$2:C2)</f><v>120.5</v>"), c("E2", "<is><t>first</t></is>", ' t="inlineStr"')],
  [3, c("A3", "<v>6</v>", ' t="s"'), c("B3", "<v>45293.5</v>", ' s="2"'), c("C3", "<v>99.25</v>"), c("D3", '<f t="shared" ref="D3:D4" si="0">SUM(C$2:C3)</f><v>219.75</v>')],
  [4, c("A4", "<v>7</v>", ' t="s"'), c("C4", "<v>7.75</v>"), c("D4", '<f t="shared" si="0"/><v>227.5</v>'), c("E4", "<v>1</v>", ' t="b"')],
  [5, c("A5", "<v>8</v>", ' t="s"'), c("C5", "<v>1234567890123456</v>"), c("D5", "<f>SUM(C$2:C5)</f>"), c("E5", "<v>#DIV/0!</v>", ' t="e"')],
  [6, c("A6", "", ' s="3"'), c("D6", "<f>C5*2</f><v></v>")],
  [7, c("A7", '<f>"x"&amp;"y"</f><v>xy</v>', ' t="str"')],
  [8, c("A8", "<v>9</v>", ' t="s"')],
];
const LEDGER_STRINGS = ["<t>Account</t>", "<t>Opened</t>", "<t>Amount</t>", "<t>Running</t>", "<t>Memo</t>", "<t>ACC-00001</t>", "<t>ACC-00002</t>", "<t>ACC-00003</t>", '<r><t>Quill</t></r><r><rPr/><t>feather Ltd</t></r>', '<t>Tokyo</t><rPh sb="0" eb="1"><t>ignored</t></rPh>'];
const ledger = (extra = {}) => xlsx({
  sheets: [{ name: "Ledger", xml: sheetXml(LEDGER) }, { name: "Notes", state: "hidden", xml: sheetXml([[1, c("A1", "<v>0</v>", ' t="s"')]]) }],
  strings: [...LEDGER_STRINGS],
  formats: { 164: "yyyy\\-mm\\-dd\\ hh:mm", 165: "0.00 &quot;d&quot;" },
  styles: [0, 14, 164, 165],
  ...extra,
});
const ledgerCells = [
  { ref: "A1", value: "Account" }, { ref: "B1", value: "Opened" }, { ref: "C1", value: "Amount" }, { ref: "D1", value: "Running" }, { ref: "E1", value: "Memo" },
  { ref: "A2", value: "ACC-00001" }, { ref: "B2", value: 45292, date: "2024-01-01" }, { ref: "C2", value: 120.5 }, { ref: "D2", value: 120.5, formula: "SUM(C$2:C2)", cached: true }, { ref: "E2", value: "first" },
  { ref: "A3", value: "ACC-00002" }, { ref: "B3", value: 45293.5, date: "2024-01-02T12:00:00" }, { ref: "C3", value: 99.25 }, { ref: "D3", value: 219.75, formula: "SUM(C$2:C3)", cached: true },
  { ref: "A4", value: "ACC-00003" }, { ref: "C4", value: 7.75 }, { ref: "D4", value: 227.5, formula: "SUM(C$2:C3) (shared from D3)", cached: true }, { ref: "E4", value: true },
  { ref: "A5", value: "Quillfeather Ltd" }, { ref: "C5", value: "1234567890123456" }, { ref: "D5", value: null, formula: "SUM(C$2:C5)", cached: false }, { ref: "E5", value: "#DIV/0!" },
  { ref: "D6", value: null, formula: "C5*2", cached: false },
  { ref: "A7", value: "xy", formula: '"x"&"y"', cached: true },
  { ref: "A8", value: "Tokyo" },
];

test("a workbook's cells keep value, formula and stored result; a formula with no stored result and a 16 digit integer are said as they are; a gap shifts nothing", async (t) => {
  const sheets = await cellsOf(t, ledger());
  assert.deepEqual(sheets.map((s) => s.name), ["Ledger", "Notes"]);
  assert.deepEqual(sheets[0].cells, ledgerCells);
  assert.deepEqual(sheets[1].cells, [{ ref: "A1", value: "Account" }]);
  assert.deepEqual((await cellsOf(t, ledger(), { sheet: "Notes" })).map((s) => s.name), ["Notes"]);
  await assert.rejects(cellsOf(t, ledger(), { sheet: "Missing" }), misses("unsupported", /no sheet named Missing/));
});

test("a workbook as text: one page a sheet, a row a line, every cell with its reference, a missing result said in the cell", async (t) => {
  const pages = await textOf(t, ledger());
  assert.deepEqual(pages.map((p) => p.page), [1, 2]);
  assert.equal(pages[0].text, [
    'Sheet "Ledger"',
    "A1=Account | B1=Opened | C1=Amount | D1=Running | E1=Memo",
    "A2=ACC-00001 | B2=45292 [2024-01-01] | C2=120.5 | D2=120.5 {=SUM(C$2:C2)} | E2=first",
    "A3=ACC-00002 | B3=45293.5 [2024-01-02T12:00:00] | C3=99.25 | D3=219.75 {=SUM(C$2:C3)}",
    "A4=ACC-00003 | C4=7.75 | D4=227.5 {=SUM(C$2:C3) (shared from D3)} | E4=TRUE",
    "A5=Quillfeather Ltd | C5=1234567890123456 | D5=<no stored value> {=SUM(C$2:C5)} | E5=#DIV/0!",
    "D6=<no stored value> {=C5*2}",
    'A7=xy {="x"&"y"}',
    "A8=Tokyo",
  ].join("\n"));
  assert.equal(pages[1].text, 'Sheet "Notes" (hidden)\nA1=Account');
  assert.deepEqual((await textOf(t, ledger(), { pages: { from: 2, to: 2 } })).map((p) => p.page), [2]);
});

test("dates before March 1900 carry Excel's own leap-year error: serial 1 is 1 January 1900 and serial 59 is 28 February", async (t) => {
  const bytes = xlsx({ sheets: [{ name: "D", xml: sheetXml([[1, c("A1", "<v>1</v>", ' s="1"'), c("B1", "<v>59</v>", ' s="1"'), c("C1", "<v>61</v>", ' s="1"')]]) }], styles: [0, 14] });
  assert.deepEqual((await cellsOf(t, bytes))[0].cells.map((x) => x.date), ["1900-01-01", "1900-02-28", "1900-03-01"]);
});

test("dates: a built-in or custom date format shows its date, a time format its time, the 1904 system its own epoch, and a plain number nothing", async (t) => {
  const bytes = (date1904, serial) => xlsx({
    date1904,
    sheets: [{ name: "D", xml: sheetXml([[1, c("A1", `<v>${serial}</v>`, ' s="1"'), c("B1", "<v>0.5</v>", ' s="2"'), c("C1", `<v>${serial}</v>`, ' s="3"'), c("D1", `<v>${serial}</v>`, ' s="4"')]]) }],
    formats: { 170: "[$-409]d mmm yyyy", 171: '0.0 "days"' },
    styles: [0, 14, 18, 170, 171],
  });
  assert.deepEqual((await cellsOf(t, bytes(false, 61)))[0].cells.map((x) => x.date), ["1900-03-01", "12:00:00", "1900-03-01", undefined]);
  assert.deepEqual((await cellsOf(t, bytes(true, 1)))[0].cells.map((x) => x.date), ["1904-01-02", "12:00:00", "1904-01-02", undefined]);
});

const ODS_BODY = `<table:table table:name="Ledger">
  <table:table-row><table:table-cell office:value-type="string"><text:p>Account</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Amount</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Total</text:p></table:table-cell></table:table-row>
  <table:table-row><table:table-cell office:value-type="string"><text:p>ACC-1</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="120.5"><text:p>120.50</text:p></table:table-cell><table:table-cell table:formula="of:=SUM([.B2:.B3])" office:value-type="float" office:value="219.75"><text:p>219.75</text:p></table:table-cell></table:table-row>
  <table:table-row><table:table-cell office:value-type="string"><text:p>ACC-2</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="99.25"><text:p>99.25</text:p></table:table-cell><table:table-cell table:formula="of:=[.C2]+1"/></table:table-row>
  <table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="float" office:value="1234567890123456"><text:p>1234567890123456</text:p></table:table-cell><table:table-cell office:value-type="date" office:date-value="2024-01-01"><text:p>01/01/24</text:p></table:table-cell><table:table-cell office:value-type="boolean" office:boolean-value="true"/><table:table-cell table:number-columns-repeated="1000"/></table:table-row>
  <table:table-row table:number-rows-repeated="3"><table:table-cell office:value-type="string"><text:p>again</text:p></table:table-cell></table:table-row>
  <table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
</table:table>
<table:table table:name="Aside" table:display="false"><table:table-row><table:table-cell office:value-type="string" office:string-value="from the attribute"/></table:table-row></table:table>`;

test("an OpenDocument sheet keeps value, formula and stored result, expands repeated rows, skips repeated empty cells and rows, and keeps a 16 digit number as digits", async (t) => {
  const sheets = await cellsOf(t, odf("spreadsheet", ODS_BODY));
  assert.deepEqual(sheets.map((s) => [s.name]), [["Ledger"], ["Aside"]]);
  assert.deepEqual(sheets[0].cells, [
    { ref: "A1", value: "Account" }, { ref: "B1", value: "Amount" }, { ref: "C1", value: "Total" },
    { ref: "A2", value: "ACC-1" }, { ref: "B2", value: 120.5 }, { ref: "C2", value: 219.75, formula: "SUM([.B2:.B3])", cached: true },
    { ref: "A3", value: "ACC-2" }, { ref: "B3", value: 99.25 }, { ref: "C3", value: null, formula: "[.C2]+1", cached: false },
    { ref: "C4", value: "1234567890123456" }, { ref: "D4", value: "2024-01-01" }, { ref: "E4", value: true },
    { ref: "A5", value: "again" }, { ref: "A6", value: "again" }, { ref: "A7", value: "again" },
  ]);
  assert.deepEqual(sheets[1].cells, [{ ref: "A1", value: "from the attribute" }]);
  const pages = await textOf(t, odf("spreadsheet", ODS_BODY));
  assert.match(pages[0].text, /^Sheet "Ledger"\nA1=Account \| B1=Amount/);
  assert.match(pages[0].text, /C3=<no stored value> \{=\[\.C2\]\+1\}/);
  assert.match(pages[1].text, /^Sheet "Aside" \(hidden\)/);
});

test("an OpenDocument text reads headings, runs with spaces, tabs and breaks, nested lists, tables with covered cells and sections; comments and deleted text are not text", async (t) => {
  const body = `<text:tracked-changes><text:changed-region><text:deletion><text:p>deleted words</text:p></text:deletion></text:changed-region></text:tracked-changes>
    <text:h text:outline-level="1">Lease summary</text:h>
    <text:p>Tenant: <text:span>Marlo Fennimore</text:span><text:s text:c="3"/>and<text:tab/>Co<text:line-break/>second line</text:p>
    <text:list><text:list-item><text:p>First term</text:p><text:list><text:list-item><text:p>Sub term</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p>Second term</text:p></text:list-item></text:list>
    <table:table><table:table-row><table:table-cell><text:p>Rent</text:p></table:table-cell><table:table-cell><text:p>900</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>Paid monthly</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table>
    <text:p>Note<office:annotation><text:p>hidden comment</text:p></office:annotation> ends</text:p>
    <text:section><text:p>Inside a section</text:p></text:section>`;
  assert.deepEqual(await textOf(t, odf("text", body)), [{
    page: 1,
    text: ["# Lease summary", "Tenant: Marlo Fennimore   and\tCo", "second line", "- First term", "  - Sub term", "- Second term", "| Rent | 900 |", "| Paid monthly |", "Note ends", "Inside a section"].join("\n"),
  }]);
});

test("an OpenDocument presentation reads its slides in order with their notes", async (t) => {
  const frame = (...paragraphs) => `<draw:frame><draw:text-box>${paragraphs.map((p) => `<text:p>${p}</text:p>`).join("")}</draw:text-box></draw:frame>`;
  const body = `<draw:page draw:name="one">${frame("Opening slide")}</draw:page><draw:page draw:name="two">${frame("Second slide", "More words")}<presentation:notes><draw:page-thumbnail/>${frame("Say this aloud")}</presentation:notes></draw:page>`;
  assert.deepEqual(await textOf(t, odf("presentation", body)), [{ page: 1, text: "Opening slide" }, { page: 2, text: "Second slide\nMore words\n\nNotes:\nSay this aloud" }]);
  assert.deepEqual(await textOf(t, odf("presentation", body), { pages: { from: 2, to: 2 } }), [{ page: 2, text: "Second slide\nMore words\n\nNotes:\nSay this aloud" }]);
});

test("RTF reads as its source text", async (t) => {
  const source = "{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Dear Mr. Wickerby,\\par Your balance is \\b 42\\b0 .\\par}";
  assert.deepEqual(await textOf(t, strToU8(source)), [{ page: 1, text: source }]);
  await assert.rejects(cellsOf(t, strToU8(source)), misses("unsupported", /cells are read from a spreadsheet, and this is an rtf file/));
});

test("a part the file points to and does not hold is said, not read as empty", async (t) => {
  const without = (bytes, name) => { const files = unzipSync(bytes); delete files[name]; return zipSync(files); };
  const deck = pptx([{ shapes: [shape(["First"])] }, { shapes: [shape(["Second"])] }]);
  assert.deepEqual((await textOf(t, without(deck, "ppt/slides/slide1.xml"))).map((p) => p.text), ["First", "(slide 2 is missing from the file)"]);
  await assert.rejects(cellsOf(t, without(ledger(), "xl/worksheets/sheet1.xml")), misses("unreadable", /sheet Ledger is missing from the file/));
});

test("of the alternatives a package offers for one thing, the first it prefers is read and never the others", async (t) => {
  const choice = (word) => `<mc:Choice Requires="wps"><w:r><w:t>${word}</w:t></w:r></mc:Choice>`;
  const alternatives = (...choices) => `<w:p><w:r><w:t>Before </w:t></w:r><mc:AlternateContent>${choices.join("")}<mc:Fallback><w:r><w:t>fallback copy</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>`;
  assert.equal((await textOf(t, docx(alternatives(choice("first choice"), choice("second choice")))))[0].text, "Before first choice");
  assert.equal((await textOf(t, docx(alternatives())))[0].text, "Before fallback copy");
  const block = `<mc:AlternateContent><mc:Choice Requires="x">${para("Chosen paragraph")}</mc:Choice><mc:Choice Requires="y">${para("Other paragraph")}</mc:Choice><mc:Fallback>${para("Fallback paragraph")}</mc:Fallback></mc:AlternateContent>`;
  assert.equal((await textOf(t, docx(block)))[0].text, "Chosen paragraph");
  const slide = `<mc:AlternateContent><mc:Choice Requires="p14">${shape(["Chosen words"])}</mc:Choice><mc:Choice Requires="p15">${shape(["Other choice"])}</mc:Choice><mc:Fallback>${shape(["Fallback words"])}</mc:Fallback></mc:AlternateContent>`;
  assert.deepEqual(await textOf(t, pptx([{ shapes: [slide] }])), [{ page: 1, text: "Chosen words" }]);
});

test("a header or footer is read when the document relates to it, and not for the name of a part it does not", async (t) => {
  const bytes = docx(para("Body"), {
    "word/header1.xml": wordPart("hdr", para("Used header")),
    "word/header9.xml": wordPart("hdr", para("Leftover header")),
    "word/footer1.xml": wordPart("ftr", para("Used footer")),
  }, ["word/header9.xml"]);
  assert.equal((await textOf(t, bytes))[0].text, "Header: Used header\nBody\nFooter: Used footer");
});

test("a list keeps the number it starts at and the number an override restarts it at, and letters run on past z as Word writes them", async (t) => {
  const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="${WORD}">
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="5"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    <w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="9"/></w:lvlOverride></w:num>
    <w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>
  </w:numbering>`;
  const body = [item("five", 1), item("six", 1), item("nine", 2), item("ten", 2), ...Array.from({ length: 28 }, (_, i) => item(`letter ${i + 1}`, 3))].join("");
  const lines = (await textOf(t, docx(body, { "word/numbering.xml": numbering })))[0].text.split("\n");
  assert.deepEqual(lines.slice(0, 5), ["5. five", "6. six", "9. nine", "10. ten", "a. letter 1"]);
  assert.deepEqual(lines.slice(-4), ["y. letter 25", "z. letter 26", "aa. letter 27", "bb. letter 28"]);
});

test("a number is annotated as the kind of thing its format shows: a date, a time of day, both, or nothing for elapsed time", async (t) => {
  const bytes = xlsx({
    sheets: [{ name: "K", xml: sheetXml([[1, ...[1, 2, 3, 4, 5, 6, 7, 8].map((s, i) => c(`${"ABCDEFGH"[i]}1`, "<v>61.75</v>", ` s="${s}"`))], [2, c("A2", "<v>0</v>", ' s="2"'), c("B2", "<v>1.5</v>", ' s="5"')]]) }],
    formats: { 164: "[h]:mm:ss", 165: "mm:ss", 166: "mmm yyyy" },
    styles: [0, 14, 18, 22, 46, 164, 165, 166, 27],
  });
  const [{ cells }] = await cellsOf(t, bytes);
  assert.deepEqual(cells.map((x) => [x.ref, x.date]), [
    ["A1", "1900-03-01"], ["B1", "18:00:00"], ["C1", "1900-03-01T18:00:00"], ["D1", undefined], ["E1", undefined], ["F1", "18:00:00"], ["G1", "1900-03-01"], ["H1", undefined],
    ["A2", "00:00:00"], ["B2", undefined],
  ]);
});

test("a formula whose stored result is the empty string has a result; one the writer left empty has none", async (t) => {
  const bytes = xlsx({ sheets: [{ name: "E", xml: sheetXml([[1, c("A1", '<f>""</f><v></v>', ' t="str"'), c("B1", "<f>1+1</f><v></v>"), c("C1", "<f>1+1</f>")]]) }] });
  const [{ cells }] = await cellsOf(t, bytes);
  assert.deepEqual(cells, [{ ref: "A1", value: "", formula: '""', cached: true }, { ref: "B1", value: null, formula: "1+1", cached: false }, { ref: "C1", value: null, formula: "1+1", cached: false }]);
  assert.equal((await textOf(t, bytes))[0].text, 'Sheet "E"\nA1= {=""} | B1=<no stored value> {=1+1} | C1=<no stored value> {=1+1}');
});

test("a part encoded as UTF-16, with either byte order, reads as the text it holds", async (t) => {
  const xml = `<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="${WORD}"><w:body><w:p><w:r><w:t>Zażółć gęślą jaźń</w:t></w:r></w:p></w:body></w:document>`;
  const encoded = (bigEndian) => { const body = Buffer.from(xml, "utf16le"); if (bigEndian) body.swap16(); return Buffer.concat([Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]), body]); };
  for (const bigEndian of [false, true]) assert.equal((await textOf(t, zipSync({ "word/document.xml": encoded(bigEndian) })))[0].text, "Zażółć gęślą jaźń");
});

test("a changed byte in a stored part is unreadable, not a different value", async (t) => {
  const stored = zipSync(unzipSync(ledger()), { level: 0 });
  assert.equal((await cellsOf(t, stored))[0].cells.find((x) => x.ref === "C2").value, 120.5, "the same bytes, unchanged, read");
  const changed = stored.slice();
  const at = Buffer.from(changed).indexOf("<v>120.5</v>");
  changed[at + 7] = 0x36;
  assert.equal(Buffer.from(changed).subarray(at, at + 12).toString(), "<v>120.6</v>");
  await assert.rejects(cellsOf(t, changed), misses("unreadable", /xl\/worksheets\/sheet1\.xml is not what its directory declares: its size or its checksum differs/));
});

test("a file is recognised by what it holds: a word document under a spreadsheet's name is read as a word document", async (t) => {
  const bytes = docx(para("Still a word document"));
  assert.equal((await textOf(t, bytes, {}, "ledger.xlsx", "sheet"))[0].text, "Still a word document");
  await assert.rejects(cellsOf(t, bytes), misses("unsupported", /this is a docx file/));
});

test("what the reader cannot read is a typed miss that names what it found", async (t) => {
  const w = await workspace(t);
  const read = (bytes, patch = {}) => w.source("x.bin", bytes).then((source) => provider.text({ ...source, ...patch }, {}, w.call()));
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await assert.rejects(read(png), misses("unsupported", /not an office document \(first bytes 89504e47\); the reader takes docx, pptx, xlsx, odt, odp, ods and rtf/));
  const legacy = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  await assert.rejects(read(legacy), misses("unsupported", /legacy binary Office file or an encrypted package \(first bytes d0cf11e0\).*LibreOffice converts the older formats/));
  await assert.rejects(read(zipSync({ "notes/readme.txt": strToU8("hello"), "data.bin": new Uint8Array(4) })), misses("unsupported", /a zip archive that is not a docx.*first entries: notes\/readme\.txt, data\.bin/));
  await assert.rejects(read(zipSync({ mimetype: [strToU8("application/vnd.oasis.opendocument.graphics"), { level: 0 }], "content.xml": strToU8("<a/>") })), misses("unsupported", /not a docx/));
  const good = docx(para("x"));
  await assert.rejects(read(good.subarray(0, good.length - 40)), misses("unreadable", /not a readable zip archive/));
  await assert.rejects(read(good.subarray(0, 10)), misses("unreadable", /not a readable zip archive: no end record/));
  await assert.rejects(read(new Uint8Array(0)), misses("unsupported", /not an office document/));
  await assert.rejects(read(zipSync({ "word/document.xml": strToU8("<w:document xmlns:w='x'><w:body><w:p></w:body>") })), misses("unreadable", /the file could not be read: .*mismatch/i));
  await assert.rejects(read(zipSync({ "word/document.xml": strToU8("<a/>") }), { sha256: "0".repeat(64) }), misses("unreadable", /it changed after it was hashed/));
  await assert.rejects(read(good, { bytes: 70 * 1024 * 1024 }), misses("over_budget", /is over the 64\.0 MiB the reader takes into memory/));
  await assert.rejects(provider.text({ ...(await w.source("gone.docx", good)), path: `${w.dir.path}/missing.docx` }, {}, w.call()), misses("unreadable", /it could not be read/));
});

test("an archive with an encrypted entry is unreadable and names the entry", async (t) => {
  const bytes = docx(para("x"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 8 < bytes.length; at++) if (view.getUint32(at, true) === 0x02014b50) { view.setUint16(at + 8, 1, true); break; }
  await assert.rejects(textOf(t, bytes), misses("unreadable", /is encrypted/));
});

test("a stored (uncompressed) part and a compressed one read alike", async (t) => {
  const content = (word) => strToU8(`<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:p>${word}</text:p></office:text></office:body></office:document-content>`);
  const mimetype = strToU8("application/vnd.oasis.opendocument.text");
  assert.equal((await textOf(t, zipSync({ mimetype: [mimetype, { level: 0 }], "content.xml": [content("stored"), { level: 0 }] })))[0].text, "stored");
  assert.equal((await textOf(t, zipSync({ mimetype: [mimetype, { level: 0 }], "content.xml": [content("deflated"), { level: 9 }] })))[0].text, "deflated");
});

// The same files through the provider conformance suite the package ships: text and cells as a binary twin would be held to.
const dir = await fixtureDir("pi-vision-office-conformance-");
test.after(() => dir.remove());
const conformanceFiles = {
  word: docx([para("Plain heading", "Heading2"), para("Account holder: Marlo Fennimore")].join("")),
  sheet: ledger(),
};
const describeFile = async (name, bytes, kind) => ({ path: await dir.file(name, bytes), kind, bytes: bytes.length, sha256: sha256(bytes) });
registerProviderConformance({
  provider,
  env: () => new NodeExecutionEnv({ cwd: dir.path }),
  requireAvailable: true,
  fixtures: [
    { name: "word document", source: await describeFile("letter.docx", conformanceFiles.word, "office"), expect: { text: [{ page: 1, contains: ["## Plain heading", "Account holder: Marlo Fennimore"] }] } },
    { name: "workbook", source: await describeFile("ledger.xlsx", conformanceFiles.sheet, "sheet"), expect: { text: [{ page: 1, contains: ["D5=<no stored value> {=SUM(C$2:C5)}"] }], cells: [{ sheet: "Ledger", cells: [ledgerCells[8], ledgerCells[19], ledgerCells[20]] }] } },
  ],
});
