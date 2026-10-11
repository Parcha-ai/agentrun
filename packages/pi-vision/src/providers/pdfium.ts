// PDF pages rendered with nothing installed: PDFium compiled to WASM, in a worker with a time and memory cap, encoded
// to PNG with Node's own zlib.
import type { Provider } from "../core/provider.js";
import { notBuilt } from "../core/not-built.js";

export function pdfiumProvider(): Provider {
  return notBuilt("pdfiumProvider");
}
