// The sources the PDF suites read: a file written into a fixture directory with its size and hash as a provider is
// given them, and the documents every PDF provider is held to.
import { createHash } from "node:crypto";
import { documentPdf, mixedPdf, textPdf } from "./pdf-builders.mjs";

export const A4 = [595.276, 841.89];

export const sourceOf = async (dir, name, bytes) => ({ path: await dir.file(name, bytes), kind: "pdf", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

/** A letter, six pages with a scan among them, and pages of other sizes: A4, a quarter turn, a crop box. */
export async function documents(dir) {
  return {
    letter: await sourceOf(dir, "letter.pdf", textPdf(["Invoice 4471", "Total due 1,203.50"])),
    six: await sourceOf(dir, "six.pdf", mixedPdf(6, 4)),
    odd: await sourceOf(dir, "odd.pdf", documentPdf(
      [{ lines: ["Letter page"] }, { scan: true, size: [300, 500], rotate: 90 }, { lines: ["A4 page"], size: A4 }, { content: "BT /F1 12 Tf 120 300 Td (Cropped page) Tj ET", cropBox: [100, 100, 400, 400] }],
      { info: { Producer: "Invented Writer 2.1", Creator: "Fixture Maker" } },
    )),
  };
}

/** What every provider of PDF text or pages must give on those documents. */
export const conformanceFixtures = ({ letter, six, odd }) => [
  { name: "a one-page letter", source: letter, expect: { text: [{ page: 1, contains: ["Invoice 4471", "Total due 1,203.50"] }], render: [{ page: 1, dpi: 150, width: 1275, height: 1650 }] } },
  { name: "six pages, the fourth a scan", source: six, expect: { text: [{ page: 1, contains: ["Section 1"] }, { page: 5, contains: ["Ledger entry 5 reads ZK-5004"] }], render: [{ page: 4, dpi: 150, width: 1275, height: 1650 }] } },
  { name: "pages of other sizes, one turned, one cropped", source: odd, expect: { text: [{ page: 1, contains: ["Letter page"] }, { page: 3, contains: ["A4 page"] }, { page: 4, contains: ["Cropped page"] }], render: [{ page: 2, dpi: 150, width: 1042, height: 625 }, { page: 3, dpi: 150, width: 1241, height: 1754 }, { page: 4, dpi: 150, width: 625, height: 625 }] } },
];
