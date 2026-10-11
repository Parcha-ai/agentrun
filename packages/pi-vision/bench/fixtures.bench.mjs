// The fixture builders' own cost: the time to write each synthetic file, its size, its pixels, and the peak memory of the
// process after it. The other bench files build the same files. Needs no provider.
import { docxBytes, imageSize, letterPdf, mixedPdf, odtBytes, photoJpeg, pptxBytes, scanPdf, tallPng, textPdf, widePng, xlsxBytes } from "@parcha/pi-vision/testing";
import { peakRssMb, sharpFactory, table } from "./support.mjs";

const builders = [
  ["letter.pdf", () => letterPdf()],
  ["letter-scan.pdf", () => scanPdf(sharpFactory)],
  ["mixed-30p.pdf", () => mixedPdf(sharpFactory, 30, 17)],
  ["text-200p.pdf", () => textPdf(200)],
  ["tall-screenshot.png", () => tallPng(sharpFactory)],
  ["dashboard-2x.png", () => widePng(sharpFactory)],
  ["phone-photo.jpg", () => photoJpeg(sharpFactory)],
  ["proof-of-address.docx", () => docxBytes()],
  ["deck.pptx", () => pptxBytes()],
  ["ledger.xlsx", () => xlsxBytes()],
  ["doc.odt", () => odtBytes()],
];

const rows = [];
for (const [name, build] of builders) {
  const started = performance.now();
  const bytes = await build();
  const size = imageSize(bytes);
  rows.push([name, (performance.now() - started).toFixed(1), bytes.length, size ? `${size.width}x${size.height}` : "-", peakRssMb()]);
}
table("fixture builders: the time to write each synthetic file", ["file", "build ms", "bytes", "pixels", "peak RSS MB"], rows);
