// The office providers on the synthetic documents: text and cells by the package's own reader, and the faithful render of
// the documents by LibreOffice. One cold call per file.
import { stat } from "node:fs/promises";
import { officeJsProvider } from "@parcha/pi-vision/providers/office-js";
import { sofficeProvider } from "@parcha/pi-vision/providers/soffice";
import { docxBytes, fixtureDir, odtBytes, pptxBytes, xlsxBytes } from "@parcha/pi-vision/testing";
import { HEADER, jobRows, table, writeFiles } from "./support.mjs";

const text = async (provider, file, call) => {
  const out = await provider.text(file.source, {}, call);
  return { bytes: out.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0), pixels: "-" };
};

const cells = async (provider, file, call) => {
  const out = await provider.cells(file.source, {}, call);
  return { bytes: Buffer.byteLength(JSON.stringify(out.sheets)), pixels: "-" };
};

const render = async (provider, file, call) => {
  const out = await provider.office(file.source, {}, call);
  return { bytes: (await stat(out.path)).size, pixels: "-" };
};

const dir = await fixtureDir("pi-vision-bench-");
try {
  const files = await writeFiles(dir, {
    "proof-of-address.docx": { kind: "office", bytes: docxBytes() },
    "deck.pptx": { kind: "office", bytes: pptxBytes() },
    "doc.odt": { kind: "office", bytes: odtBytes() },
    "ledger.xlsx": { kind: "sheet", bytes: xlsxBytes() },
  });
  const documents = ["proof-of-address.docx", "deck.pptx", "doc.odt"];
  const rows = [
    ...await jobRows({ label: "office-js", job: "text", make: officeJsProvider, cwd: dir.path, files, names: documents, run: text }),
    ...await jobRows({ label: "office-js", job: "cells", make: officeJsProvider, cwd: dir.path, files, names: ["ledger.xlsx"], run: cells }),
    ...await jobRows({ label: "soffice", job: "office", make: sofficeProvider, cwd: dir.path, files, names: ["proof-of-address.docx", "deck.pptx"], run: render }),
  ];
  table("office providers: text, cells, and a LibreOffice render", HEADER, rows);
} finally {
  await dir.remove();
}
