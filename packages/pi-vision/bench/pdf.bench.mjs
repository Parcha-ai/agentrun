// The PDF providers on the synthetic PDFs: text by unpdf and by poppler, and one page rendered at 150 dpi (the planner's
// rule for a Letter page) by PDFium and by poppler. One cold call per file.
import { pdfiumProvider } from "@parcha/pi-vision/providers/pdfium";
import { popplerProvider } from "@parcha/pi-vision/providers/poppler";
import { unpdfProvider } from "@parcha/pi-vision/providers/unpdf";
import { fixtureDir, letterPdf, mixedPdf, scanPdf, textPdf } from "@parcha/pi-vision/testing";
import { HEADER, jobRows, sharpFactory, table, writeFiles } from "./support.mjs";

const DPI = 150;

const text = async (provider, file, call) => {
  const out = await provider.text(file.source, {}, call);
  return { bytes: out.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0), pixels: "-" };
};

const render = async (provider, file, call) => {
  const out = await provider.render(file.source, { page: file.page, dpi: DPI }, call);
  return { bytes: out.image.data.length, pixels: `${out.image.width}x${out.image.height}` };
};

const dir = await fixtureDir("pi-vision-bench-");
try {
  const files = await writeFiles(dir, {
    "letter.pdf": { kind: "pdf", bytes: letterPdf(), page: 1 },
    "letter-scan.pdf": { kind: "pdf", bytes: await scanPdf(sharpFactory), page: 1 },
    "mixed-30p.pdf": { kind: "pdf", bytes: await mixedPdf(sharpFactory, 30, 17), page: 17 },
    "text-200p.pdf": { kind: "pdf", bytes: textPdf(200), page: 1 },
  });
  const rows = [
    ...await jobRows({ label: "unpdf", job: "text", make: unpdfProvider, cwd: dir.path, files, run: text }),
    ...await jobRows({ label: "poppler", job: "text", make: popplerProvider, cwd: dir.path, files, run: text }),
    ...await jobRows({ label: "pdfium", job: "render", make: pdfiumProvider, cwd: dir.path, files, run: render }),
    ...await jobRows({ label: "poppler", job: "render", make: popplerProvider, cwd: dir.path, files, run: render }),
  ];
  table("PDF providers: text, and one page at 150 dpi (page 1; page 17 of the mixed file)", HEADER, rows);
} finally {
  await dir.remove();
}
