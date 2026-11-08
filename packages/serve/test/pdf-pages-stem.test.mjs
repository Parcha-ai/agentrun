// pdf_pages draws each document under a directory of its own (work/pages/<stem>/<dpi>/<n>.png): the stem comes from the
// document's path below the documents (or work) directory, so company-a/certificate.pdf and company-b/certificate.pdf,
// drawn in one run, never share a page, and a judge about one is never shown the other's. Ghostscript draws the PDFs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { imageLoader, pdfPages } from "../dist/pdf-pages.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { scratch } from "./support.mjs";

/** A one-page PDF reading `title`. */
function pdf(file, title) {
  execFileSync("gs", ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", `-sOutputFile=${file}`, "-"], {
    input: `%!PS\n/Helvetica findfont 20 scalefont setfont\n72 700 moveto (${title}) show\nshowpage\n`,
  });
}

async function layout(t) {
  const dir = await scratch(t);
  const [documents, work] = [join(dir, "documents"), join(dir, "work")];
  for (const company of ["company-a", "company-b"]) await mkdir(join(documents, company), { recursive: true });
  await mkdir(work);
  // The run's Workspace on work/: pdf_pages reads and draws through it.
  return { documents, work, ws: localWorkspace(work) };
}

const stemOf = (ref) => ref.split("/")[1];

test("two documents of one file name in different folders draw pages of their own, each holding its own document", async (t) => {
  const { documents, work, ws } = await layout(t);
  pdf(join(documents, "company-a", "certificate.pdf"), "CERTIFICATE Acme Holdings");
  pdf(join(documents, "company-b", "certificate.pdf"), "CERTIFICATE Bravo Trading");
  const a = await pdfPages({ path: "company-a/certificate.pdf", maxPages: 1, dpi: 50 }, { work: ws, documents });
  const drawnA = await readFile(join(work, a.pages[0].image));
  const b = await pdfPages({ path: "company-b/certificate.pdf", maxPages: 1, dpi: 50 }, { work: ws, documents });
  assert.match(a.text, /Acme Holdings/);
  assert.match(b.text, /Bravo Trading/);
  assert.notEqual(a.pages[0].image, b.pages[0].image, "one page each");
  assert.deepEqual(await readFile(join(work, a.pages[0].image)), drawnA, "company-a's page is still company-a's after company-b's is drawn");
  assert.notDeepEqual(await readFile(join(work, b.pages[0].image)), drawnA, "company-b's page is its own");
  // An image passes through the same way: one page each.
  await writeFile(join(documents, "company-a", "scan.png"), "the bytes of company-a's scan");
  await writeFile(join(documents, "company-b", "scan.png"), "the bytes of company-b's scan");
  const [sa, sb] = [await pdfPages({ path: "company-a/scan.png" }, { work: ws, documents }), await pdfPages({ path: "company-b/scan.png" }, { work: ws, documents })];
  assert.notEqual(sa.pages[0].image, sb.pages[0].image);
  assert.equal(await readFile(join(work, sa.pages[0].image), "utf8"), "the bytes of company-a's scan");
  assert.equal(await readFile(join(work, sb.pages[0].image), "utf8"), "the bytes of company-b's scan");
});

test("the stem is one path-safe name, the same for the same file however it is named, and short for a deep path", async (t) => {
  const { documents, work, ws } = await layout(t);
  pdf(join(documents, "company-a", "certificate.pdf"), "CERTIFICATE Acme Holdings");
  const first = await pdfPages({ path: "company-a/certificate.pdf", maxPages: 1, dpi: 50 }, { work: ws, documents });
  const again = await pdfPages({ path: "company-a/./certificate.pdf", maxPages: 1, dpi: 50 }, { work: ws, documents });
  assert.equal(again.pages[0].image, first.pages[0].image, "the same file draws under the same name");
  // A link inside the documents directory names the file it points to.
  await symlink(join(documents, "company-a", "certificate.pdf"), join(documents, "latest.pdf"));
  const linked = await pdfPages({ path: "latest.pdf", maxPages: 1, dpi: 50 }, { work: ws, documents });
  assert.equal(linked.pages[0].image, first.pages[0].image);
  const deep = join(documents, ...Array.from({ length: 8 }, (_, i) => `folder-${i}-${"x".repeat(40)}`));
  await mkdir(deep, { recursive: true });
  pdf(join(deep, "certificate of incorporation (final).pdf"), "CERTIFICATE Deep");
  const long = await pdfPages({ path: join(...Array.from({ length: 8 }, (_, i) => `folder-${i}-${"x".repeat(40)}`), "certificate of incorporation (final).pdf"), maxPages: 1, dpi: 50 }, { work: ws, documents });
  for (const ref of [first.pages[0].image, long.pages[0].image]) {
    const stem = stemOf(ref);
    assert.match(stem, /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/, `${ref}: one name, no separator, never a dot name`);
    assert.ok(Buffer.byteLength(stem) <= 80, `${stem}: ${Buffer.byteLength(stem)} bytes`);
    assert.match(ref, /^pages\/[^/]+\/50\/1\.png$/, "the layout stays pages/<stem>/<dpi>/<n>.png");
  }
  assert.match(stemOf(long.pages[0].image), /final/, "the stem keeps the end of the name, its most telling part");
});

test("a document still resolves by its name, and a page drawn under the old pages/<basename>/ name still loads by its ref", async (t) => {
  const { documents, work, ws } = await layout(t);
  pdf(join(documents, "certificate.pdf"), "CERTIFICATE Root");
  assert.match((await pdfPages({ path: "certificate.pdf", maxPages: 1, dpi: 50 }, { work: ws, documents })).text, /CERTIFICATE Root/, "the documents' own file, by its name");
  // A run drawn before the change holds refs such as pages/certificate/110/1.png in its state and its receipts.
  await mkdir(join(work, "pages", "certificate", "110"), { recursive: true });
  await writeFile(join(work, "pages", "certificate", "110", "1.png"), "a page drawn before");
  const loaded = await imageLoader(ws)("pages/certificate/110/1.png");
  assert.equal(Buffer.from(loaded.bytes).toString(), "a page drawn before");
  const now = await pdfPages({ path: "certificate.pdf", maxPages: 1, dpi: 110 }, { work: ws, documents });
  assert.notEqual(now.pages[0].image, "pages/certificate/110/1.png", "a new draw goes under the new name");
  assert.equal(Buffer.from((await imageLoader(ws)("pages/certificate/110/1.png")).bytes).toString(), "a page drawn before", "and leaves the old page as it was");
});
