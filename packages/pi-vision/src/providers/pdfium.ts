// PDF pages rendered with nothing installed: PDFium compiled to WASM, in a worker thread with a time and heap cap and a
// cap on the pixels of a page, encoded to PNG with Node's own zlib. The page is drawn at the size poppler's `pdftoppm`
// would give it (its size in points times dpi over 72, rounded up), so the two agree to the pixel.
import { PDF_RENDER_MAX_PIXELS, PDF_RENDER_TIMEOUT_MS, PDF_WORKER_MEMORY_MB, PdfProviderError, readPdfBytes, resolvePdfDependency, runPdfWorker } from "../core/pdf.js";
import type { Provider, RenderedImage } from "../core/provider.js";

/** The worker's script. PDFium's bitmap comes back as R, G, B, A bytes; the PNG is RGB with no filter. It takes its
 *  built-in modules from the process, so it runs the same whether the host's eval is CommonJS or ESM. PDFium's WASM memory
 *  is outside the worker's heap limit, so growth past `memoryMb` is refused here; PDFium then aborts, and that abort is
 *  reported as the cap it hit. */
const SCRIPT = `
const { parentPort, workerData: d } = process.getBuiltinModule("node:worker_threads");
const zlib = process.getBuiltinModule("node:zlib");
const fail = (name, message) => parentPort.postMessage({ error: { name, message } });
let refused = false;
const grow = WebAssembly.Memory.prototype.grow;
WebAssembly.Memory.prototype.grow = function (pages) {
  if (this.buffer.byteLength + pages * 65536 > d.memoryMb * 1048576) { refused = true; throw new RangeError("memory cap"); }
  return grow.call(this, pages);
};
const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
};
(async () => {
  const { PDFiumLibrary } = await import(d.module);
  const doc = await (await PDFiumLibrary.init()).loadDocument(d.bytes);
  const count = doc.getPageCount();
  if (!(d.page <= count)) return fail("RangeError", "page " + d.page + " is past the end of the document (" + count + " pages)");
  const size = doc.getPage(d.page - 1).getOriginalSize();
  const width = Math.ceil(size.originalWidth * d.dpi / 72);
  const height = Math.ceil(size.originalHeight * d.dpi / 72);
  if (!(width >= 1 && height >= 1)) return fail("RangeError", "page " + d.page + " has no size");
  if (width * height > d.maxPixels) return fail("OverBudget", "page " + d.page + " at " + d.dpi + " dpi is " + width + "x" + height + " px, over the " + d.maxPixels + " pixel cap; render it at a lower dpi");
  const { data } = await doc.getPage(d.page - 1).render({ render: "bitmap", width, height });
  const rows = Buffer.allocUnsafe((width * 3 + 1) * height);
  for (let y = 0, o = 0, i = 0; y < height; y++) {
    rows[o++] = 0;
    for (let x = 0; x < width; x++, i += 4) { rows[o++] = data[i]; rows[o++] = data[i + 1]; rows[o++] = data[i + 2]; }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  parentPort.postMessage({ value: { png: new Uint8Array(png), width, height } });
})().catch((e) => (refused ? fail("OverBudget", "the PDF engine needed more than " + d.memoryMb + " MB") : fail(e && e.name, String((e && e.message) || e))));
`;

/** The worker's time and heap caps and the cap on a page's pixels; the defaults hold when they are left out. */
export type PdfiumOptions = { readonly timeoutMs?: number; readonly memoryMb?: number; readonly maxPixels?: number };

/** PDF pages as PNG with nothing installed: PDFium compiled to WASM, in a worker thread with a time and heap cap, at the size poppler would give. */
export function pdfiumProvider(options: PdfiumOptions = {}): Provider {
  const maxPixels = options.maxPixels ?? PDF_RENDER_MAX_PIXELS;
  return {
    name: "pdfium",
    capabilities: ["render"],
    kinds: ["pdf"],
    async detect() {
      try {
        return { available: true, version: (await resolvePdfDependency("@hyzyla/pdfium")).version };
      } catch (error) {
        return { available: false, needs: "@hyzyla/pdfium", reason: String((error as Error)?.message ?? error).split("\n")[0]! };
      }
    },
    async render(source, request, call) {
      const { url, version } = await resolvePdfDependency("@hyzyla/pdfium");
      const bytes = await readPdfBytes(source, call);
      const caps = { timeoutMs: options.timeoutMs ?? PDF_RENDER_TIMEOUT_MS, memoryMb: options.memoryMb ?? PDF_WORKER_MEMORY_MB, signal: call.signal };
      const done = await runPdfWorker<{ png: Uint8Array; width: number; height: number }>(SCRIPT, { module: url, bytes, ...request, maxPixels, memoryMb: caps.memoryMb }, caps).catch((error: Error) => {
        if (error.name === "OverBudget") throw new PdfProviderError("over_budget", error.message);
        throw error;
      });
      const image: RenderedImage = { data: done.png, mimeType: "image/png", width: done.width, height: done.height };
      return { madeBy: { provider: "pdfium", version }, image };
    },
  };
}
