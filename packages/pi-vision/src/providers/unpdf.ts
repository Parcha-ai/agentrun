// PDF text with nothing installed: pdf.js through `unpdf`, in a worker thread with a time and heap cap, so a file built
// to run a reader out of either ends in a typed miss and never takes the host with it. It reads the page sizes, producer
// and creator in the same pass.
import { PDF_TEXT_TIMEOUT_MS, PDF_WORKER_MEMORY_MB, PdfProviderError, readPdfBytes, resolvePdfDependency, runPdfWorker, type PdfInfo, type PdfProvider } from "../core/pdf.js";

/** The worker's script: the document's text by page, then each page's size and the document's own metadata. It takes
 *  its built-in modules from the process, so it runs the same whether the host's eval is CommonJS or ESM. */
const SCRIPT = `
const { parentPort, workerData: d } = process.getBuiltinModule("node:worker_threads");
(async () => {
  const { getDocumentProxy, extractText, getMeta } = await import(d.module);
  const pdf = await getDocumentProxy(d.bytes, { isEvalSupported: false });
  const { text } = await extractText(pdf, { mergePages: false });
  const pageSizes = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    pageSizes.push(page.rotate % 180 !== 0 ? { width: y1 - y0, height: x1 - x0 } : { width: x1 - x0, height: y1 - y0 });
  }
  const { info } = await getMeta(pdf).catch(() => ({ info: {} }));
  parentPort.postMessage({ value: { pages: text, info: { pages: pdf.numPages, pageSizes, ...(info.Producer ? { producer: info.Producer } : {}), ...(info.Creator ? { creator: info.Creator } : {}) } } });
})().catch((e) => parentPort.postMessage({ error: { name: e && e.name, message: String((e && e.message) || e) } }));
`;

/** The worker's time and heap caps; the defaults hold when they are left out. */
export type UnpdfOptions = { readonly timeoutMs?: number; readonly memoryMb?: number };

/** PDF text with nothing installed: pdf.js through `unpdf`, in a worker thread with a time and heap cap. */
export function unpdfProvider(options: UnpdfOptions = {}): PdfProvider {
  const document: PdfProvider["document"] = async (source, call) => {
    const { url, version } = await resolvePdfDependency("unpdf");
    const bytes = await readPdfBytes(source, call);
    const caps = { timeoutMs: options.timeoutMs ?? PDF_TEXT_TIMEOUT_MS, memoryMb: options.memoryMb ?? PDF_WORKER_MEMORY_MB, signal: call.signal };
    const read = await runPdfWorker<{ pages: string[]; info: PdfInfo }>(SCRIPT, { module: url, bytes }, caps).catch((error: Error) => {
      if (error.name === "PasswordException") throw new PdfProviderError("unreadable", "the document is password-protected");
      throw error;
    });
    return { madeBy: { provider: "unpdf", version }, pages: read.pages.map((text) => text.trimEnd()), info: read.info };
  };
  return {
    name: "unpdf",
    capabilities: ["text"],
    kinds: ["pdf"],
    async detect() {
      try {
        return { available: true, version: (await resolvePdfDependency("unpdf")).version };
      } catch (error) {
        return { available: false, needs: "unpdf", reason: String((error as Error)?.message ?? error).split("\n")[0]! };
      }
    },
    document,
    async text(source, request, call) {
      const read = await document(source, call);
      const pages = read.pages.map((text, i) => ({ page: i + 1, text })).filter((p) => !request.pages || (p.page >= request.pages.from && p.page <= request.pages.to));
      return { madeBy: read.madeBy, pages };
    },
  };
}
