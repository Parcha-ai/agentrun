// The PDF builders read in poppler, the reader a PDF is checked with in a shell: the page counts, the text layer where it
// should be and where it should not, the scanned page as one image at its size, and a page rendered at 72 dpi at the
// size a Letter page has. Needs poppler-utils (`pdfinfo`, `pdftotext`, `pdfimages`, `pdftoppm`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";
import { fixtureDir, imageSize, letterPdf, mixedPdf, scanPdf, textPdf } from "@parcha/pi-vision/testing";

const sharpFactory = (input, options) => sharp(input, options);
const poppler = (tool, ...args) => execFileSync(tool, args, { encoding: "utf8" });
const pageCount = (path) => Number(/^Pages:\s+(\d+)$/m.exec(poppler("pdfinfo", path))[1]);
const textOf = (path, page) => poppler("pdftotext", "-f", String(page), "-l", String(page), path, "-").trim();
/** The rows of `pdfimages -list` as `{ page, width, height }`. */
const images = (path) => poppler("pdfimages", "-list", path).split("\n").slice(2).filter(Boolean).map((row) => {
  const [page, , , width, height] = row.trim().split(/\s+/);
  return { page: Number(page), width: Number(width), height: Number(height) };
});

test("the letter has one page and a text layer", async () => {
  const dir = await fixtureDir("pi-vision-binaries-");
  try {
    const path = await dir.file("letter.pdf", letterPdf());
    assert.equal(pageCount(path), 1);
    assert.notEqual(textOf(path, 1), "");
    assert.deepEqual(images(path), []);
  } finally {
    await dir.remove();
  }
});

test("the scan has one page, no text layer, and one image at 200 dpi", async () => {
  const dir = await fixtureDir("pi-vision-binaries-");
  try {
    const path = await dir.file("scan.pdf", await scanPdf(sharpFactory));
    assert.equal(pageCount(path), 1);
    assert.equal(textOf(path, 1), "");
    assert.deepEqual(images(path), [{ page: 1, width: 1700, height: 2200 }]);
  } finally {
    await dir.remove();
  }
});

test("in the mixed file, the scanned page 17 is the only image and the only page without text", async () => {
  const dir = await fixtureDir("pi-vision-binaries-");
  try {
    const path = await dir.file("mixed.pdf", await mixedPdf(sharpFactory, 30, 17));
    assert.equal(pageCount(path), 30);
    assert.equal(textOf(path, 17), "");
    assert.notEqual(textOf(path, 16), "");
    assert.deepEqual(images(path), [{ page: 17, width: 1700, height: 2200 }]);
  } finally {
    await dir.remove();
  }
});

test("the 200 page text file has 200 pages, and page one renders at Letter size at 72 dpi", async () => {
  const dir = await fixtureDir("pi-vision-binaries-");
  try {
    assert.equal(pageCount(await dir.file("text200.pdf", textPdf(200))), 200);
    const path = await dir.file("letter.pdf", letterPdf());
    poppler("pdftoppm", "-r", "72", "-f", "1", "-l", "1", "-png", "-singlefile", path, `${dir.path}/page`);
    assert.deepEqual(imageSize(new Uint8Array(await readFile(`${dir.path}/page.png`))), { mimeType: "image/png", width: 612, height: 792 });
  } finally {
    await dir.remove();
  }
});
