// What the office module holds that needs no dependency: the zip directory and its guard, the text a sheet is
// rendered to, the note that says what a text read is not, and the typed miss.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OFFICE_LIMITS, OfficeMissError, cellText, notRenderedNote, sheetText, zipDirectory } from "@parcha/pi-vision";
import { strToU8, zipSync } from "fflate";

const misses = (code, message) => (error) => error instanceof OfficeMissError && error.code === code && message.test(error.message);

test("the directory lists the entries of an archive with their sizes, in the order they are stored", () => {
  const bytes = zipSync({ "a/one.txt": strToU8("hello hello hello hello"), "b.txt": [strToU8("x"), { level: 0 }] });
  const entries = zipDirectory(bytes);
  assert.deepEqual(entries.map((e) => [e.name, e.method, e.originalSize]), [["a/one.txt", 8, 23], ["b.txt", 0, 1]]);
  assert.ok(entries[0].size > 0 && entries[0].offset === 0 && entries[1].offset > 0);
});

test("the guard counts entries, declared bytes and the declared ratio, and a small archive is never refused by its ratio", () => {
  const files = { a: new Uint8Array(10), b: new Uint8Array(10), c: new Uint8Array(10) };
  assert.throws(() => zipDirectory(zipSync(files), { ...OFFICE_LIMITS, maxEntries: 2 }), misses("over_budget", /holds 3 entries, over the 2 the reader takes/));
  assert.throws(() => zipDirectory(zipSync(files), { ...OFFICE_LIMITS, maxUncompressedBytes: 29 }), misses("over_budget", /declares 0\.0 MiB uncompressed, over the 0\.0 MiB/));
  assert.equal(zipDirectory(zipSync(files), { ...OFFICE_LIMITS, maxUncompressedBytes: 30 }).length, 3);
  const zeros = zipSync({ "z.bin": new Uint8Array(900 * 1024) }, { level: 9 });
  assert.equal(zipDirectory(zeros).length, 1, "900 KiB of zeros is under the floor the ratio applies above");
  assert.throws(() => zipDirectory(zeros, { ...OFFICE_LIMITS, ratioFloorBytes: 1024 }), misses("over_budget", /declares 0\.9 MiB from 0\.0 MiB, over 100 to 1/));
});

test("a file that is not a zip archive, or whose directory is cut, is unreadable", () => {
  assert.throws(() => zipDirectory(new Uint8Array(0)), misses("unreadable", /no end record/));
  assert.throws(() => zipDirectory(strToU8("PK but not really a zip archive at all")), misses("unreadable", /no end record/));
});

test("a cell is its reference and its value; a formula, a date and a missing result are said in the cell", () => {
  assert.equal(cellText({ ref: "A1", value: "Account" }), "A1=Account");
  assert.equal(cellText({ ref: "B2", value: 0 }), "B2=0");
  assert.equal(cellText({ ref: "B3", value: true }), "B3=TRUE");
  assert.equal(cellText({ ref: "B4", value: false }), "B4=FALSE");
  assert.equal(cellText({ ref: "C5", value: "line one\r\nline two" }), "C5=line one\\nline two");
  assert.equal(cellText({ ref: "D6", value: 45292, date: "2024-01-01" }), "D6=45292 [2024-01-01]");
  assert.equal(cellText({ ref: "E7", value: 3, formula: "1+2", cached: true }), "E7=3 {=1+2}");
  assert.equal(cellText({ ref: "E8", value: null, formula: "1+2", cached: false }), "E8=<no stored value> {=1+2}");
});

test("a sheet is a line a row, rows told by their number and not by their place, columns past Z included", () => {
  const cells = [{ ref: "A2", value: "x" }, { ref: "C2", value: "y" }, { ref: "AA2", value: "z" }, { ref: "A10", value: "w" }];
  assert.equal(sheetText("Data", cells), 'Sheet "Data"\nA2=x | C2=y | AA2=z\nA10=w');
  assert.equal(sheetText("Empty", []), 'Sheet "Empty"\n(no cells)');
  assert.equal(sheetText("Old", [], true), 'Sheet "Old" (hidden)\n(no cells)');
});

test("a text read names what it left out and what would render it", () => {
  assert.equal(notRenderedNote("office"), "Text only: page layout, images, charts, drawings and text inside pictures are not shown here. A faithful render needs LibreOffice (soffice) in the environment.");
  assert.equal(notRenderedNote("sheet"), "Cells only: formatting, charts, images and pivot views are not shown here. A faithful render needs LibreOffice (soffice) in the environment.");
});

test("a typed miss carries its code and its one line", () => {
  const miss = new OfficeMissError("needs", "LibreOffice is not installed");
  assert.equal(miss.code, "needs");
  assert.equal(miss.name, "OfficeMissError");
  assert.ok(miss instanceof Error);
});
