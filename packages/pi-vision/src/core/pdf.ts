// PDF: the free facts (pages, their sizes, which carry a text layer, producer, creator, saved revisions, signatures),
// text by page, and a page rendered at a dpi. Zero install: `unpdf` for text and PDFium (WASM) for pages, each in a
// child process with a time and memory cap, since a hostile file can run a reader out of time or memory; poppler when
// the environment has it. Providers are tried in the order the host lists them: the first that reads the file wins, a
// failure falls to the next, and every result names the provider and version that made it (`derive.ts`). The text of a
// PDF held in memory is what a browser's fetch takes for a fetched document.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { derivations, derivedName, ProviderMiss, viaProviders, type DeriveContext, type DeriveMiss, type DeriveOutcome } from "./derive.js";
import { visionContext } from "./env.js";
import { SOURCE_BYTES_IN_PROCESS } from "./limits.js";
import type { MadeBy, Provider, ProviderCall, ProviderSource, RenderedImage } from "./provider.js";

/** Time for one document's text: the time hosts already give `pdftotext` (read 2026-10-11). */
export const PDF_TEXT_TIMEOUT_MS = 120_000;
/** Time for one page's render: a 200 dpi scan takes 0.9 s in poppler and 0.5 s in PDFium (measured 2026-10-11); a page that takes a minute is not one to read. */
export const PDF_RENDER_TIMEOUT_MS = 60_000;
/** The memory of a worker reading a PDF, its JavaScript heap and, for PDFium, its WASM memory: pdf.js held 455 MB for 200 pages (measured 2026-10-11). */
export const PDF_WORKER_MEMORY_MB = 1024;
/** The most pixels one page render may have: a 150 dpi render of an A0 sheet. The planner asks for at most 2,000 px on a long edge (4 MP); a bitmap is 4 bytes a pixel in WASM beside a copy and the PNG's rows (2026-10-11). */
export const PDF_RENDER_MAX_PIXELS = 25_000_000;

/** Why a PDF could not be read, as the model reads it after the file's name. */
export type PdfMiss = DeriveMiss;
/** What a PDF operation gave: its value, or the miss that says why there is none. */
export type PdfOutcome<T> = DeriveOutcome<T>;

/** What the file's own structure says: pages and their sizes in points, with each page's rotation applied. */
export type PdfInfo = {
  readonly pages: number;
  readonly pageSizes: readonly { readonly width: number; readonly height: number }[];
  readonly producer?: string;
  readonly creator?: string;
};

/** The free facts of a document. `revisions` counts the times the file was saved (1 for a file written once) and
 *  `signatures` the signature dictionaries in it; both are null for a file over `SOURCE_BYTES_IN_PROCESS`, which is not
 *  scanned. */
export type PdfFacts = PdfInfo & {
  /** The 1-based pages that have a text layer. */
  readonly textPages: readonly number[];
  readonly revisions: number | null;
  readonly signatures: number | null;
};

/** A document read: the facts and the text layer of every page ("" for a page with none). */
export type PdfDocument = { readonly madeBy: MadeBy; readonly facts: PdfFacts; readonly pages: readonly string[] };

/** A provider of PDF text that also reads the file's structure in the same pass. A provider that only declares `text` is
 *  used too, and its document has no page sizes. */
export type PdfProvider = Provider & {
  document(source: ProviderSource, call: ProviderCall): Promise<{ readonly madeBy: MadeBy; readonly pages: readonly string[]; readonly info?: PdfInfo }>;
};

export { ProviderMiss as PdfProviderError } from "./derive.js";

/** What a PDF operation runs with: the environment, the providers to try, where derivations are kept and the signal. */
export type PdfContext = DeriveContext;

/** What a worker may use: milliseconds and megabytes of heap, and the signal that stops it. */
export type PdfWorkerCaps = { readonly timeoutMs: number; readonly memoryMb: number; readonly signal?: AbortSignal };

const ENGINE = `
const { Worker } = process.getBuiltinModule("node:worker_threads");
process.once("disconnect", () => process.exit(1));
process.once("message", ({ script, input }) => {
  const worker = new Worker(script, { eval: true, workerData: input, env: {}, stdout: true, stderr: true, execArgv: [], transferList: [...new Set(Object.values(input).filter(ArrayBuffer.isView).map((view) => view.buffer))] });
  worker.stdout.resume();
  worker.stderr.resume();
  let replied = false;
  const reply = (message) => { if (!replied) { replied = true; process.send(message, () => process.exit(0)); } };
  worker.once("message", reply);
  worker.once("error", (error) => reply(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? { memory: true } : { error: { name: error.name, message: String(error.message) } }));
  worker.once("exit", () => reply({ error: { name: "Error", message: "the PDF engine's worker stopped" } }));
});
`;

/** Runs `script`, plain JavaScript with no `require` or `import` statement, in a worker thread of a child process of its
 *  own, with `input` as its `workerData`. The script posts `{ value }` or `{ error: { name, message } }` once. A file can
 *  make an engine run out of heap past the point where V8 can still stop one thread, and V8 then aborts the whole
 *  process: that ends the child, never the host. A child that runs out of time or heap is killed and the call is an
 *  `over_budget` error; one that cannot be started is a `needs` error. The child has no environment variables, no output
 *  and no way to outlive its host. The script is a string, so a bundled host carries it. */
export function runPdfWorker<T>(script: string, input: Record<string, unknown>, caps: PdfWorkerCaps): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (caps.signal?.aborted) return reject(caps.signal.reason);
    const child = spawn(process.execPath, [`--max-old-space-size=${Math.floor(caps.memoryMb)}`, "-e", ENGINE], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", windowsHide: true });
    const end = (settle: () => void) => {
      clearTimeout(timer);
      caps.signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL");
      settle();
    };
    const memory = () => new ProviderMiss("over_budget", `the PDF engine needed more than ${caps.memoryMb} MB`);
    const onAbort = () => end(() => reject(caps.signal!.reason));
    const timer = setTimeout(() => end(() => reject(new ProviderMiss("over_budget", `the PDF engine did not finish within ${Number((caps.timeoutMs / 1000).toFixed(2))} s`))), caps.timeoutMs);
    caps.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => end(() => reject(new ProviderMiss("needs", `the PDF engine could not be started (${error.message.split("\n")[0]})`))));
    child.once("message", (m: { value?: T; memory?: true; error?: { name?: string; message?: string } }) =>
      end(() => (m.memory ? reject(memory()) : m.error ? reject(Object.assign(new Error(m.error.message), { name: m.error.name })) : resolve(m.value as T))));
    child.once("exit", (code, signal) => end(() => reject(signal === "SIGABRT" ? memory() : new Error(`the PDF engine stopped (${signal ?? `exit ${code}`})`))));
    child.send({ script, input }, (error) => { if (error) end(() => reject(error)); });
  });
}

const dependencies = new Map<string, Promise<{ readonly url: string; readonly version: string }>>();

/** The module URL and installed version of a dependency, as the package's own manifest says them. */
export function resolvePdfDependency(name: string): Promise<{ readonly url: string; readonly version: string }> {
  let found = dependencies.get(name);
  if (!found) {
    found = (async () => {
      const url = import.meta.resolve(name);
      const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", url)), "utf8")) as { version: string };
      return { url, version: manifest.version };
    })();
    dependencies.set(name, found);
    found.catch(() => dependencies.delete(name));
  }
  return found;
}

/** The bytes of a source for a reader that holds the whole file: refused over the in-process cap. */
export async function readPdfBytes(source: ProviderSource, call: ProviderCall): Promise<Uint8Array> {
  if (source.bytes > SOURCE_BYTES_IN_PROCESS) {
    throw new ProviderMiss("over_budget", `the file is ${Math.ceil(source.bytes / 1048576)} MiB and this reader holds a PDF in memory up to ${SOURCE_BYTES_IN_PROCESS / 1048576} MiB; a larger file needs poppler (poppler-utils) in the environment`);
  }
  const read = await call.env.readBinaryFile(source.path, visionContext(call.signal));
  if (!read.ok) throw read.error;
  return read.value;
}

/** The saves of a file: the sections of its cross-reference chain, from the last `startxref` back along each section's
 *  `/Prev`. A section is a table with a trailer or a cross-reference stream, and only its own dictionary is read, never
 *  the words in a page. Null when the chain does not lead through sections. */
function saveChain(raw: string): number | null {
  const marker = raw.lastIndexOf("startxref");
  let at: number | null = marker < 0 ? null : Number(/^startxref\s+(\d+)/.exec(raw.slice(marker, marker + 40))?.[1] ?? NaN);
  const seen = new Set<number>();
  while (at !== null && Number.isInteger(at) && at >= 0 && at < raw.length && !seen.has(at) && seen.size < 10_000) {
    seen.add(at);
    const table = raw.startsWith("xref", at);
    if (!table && !/^\d+\s+\d+\s+obj\b/.test(raw.slice(at, at + 32))) return null;
    const from = table ? raw.indexOf("trailer", at) : at;
    const to = from < 0 ? -1 : raw.indexOf(table ? "startxref" : "stream", from);
    if (to < 0) return null;
    const prev = /\/Prev\s+(\d+)/.exec(raw.slice(from, to));
    at = prev ? Number(prev[1]) : null;
  }
  return at === null ? seen.size : null;
}

/** The `/ByteRange` keys of signature dictionaries: names outside strings, comments and stream data, so text a page shows
 *  is not one. */
function signatureCount(raw: string): number {
  let count = 0;
  for (let i = 0; i < raw.length; ) {
    const c = raw.charCodeAt(i);
    if (c === 0x25) { while (i < raw.length && raw.charCodeAt(i) !== 10 && raw.charCodeAt(i) !== 13) i++; }
    else if (c === 0x28) { for (let depth = 0; i < raw.length; i++) { const d = raw.charCodeAt(i); if (d === 0x5c) i++; else if (d === 0x28) depth++; else if (d === 0x29 && --depth === 0) break; } i++; }
    else if (c === 0x3c) i = raw.charCodeAt(i + 1) === 0x3c ? i + 2 : (raw.indexOf(">", i) + 1 || raw.length);
    else if (c === 0x73 && raw.startsWith("stream", i) && /[\r\n]/.test(raw[i + 6] ?? "") && !/[a-z]/i.test(raw[i - 1] ?? "")) { const end = raw.indexOf("endstream", i + 6); i = end < 0 ? raw.length : end + 9; }
    else if (c === 0x2f && /^\/ByteRange\s*\[/.test(raw.slice(i, i + 24))) { count++; i += 10; }
    else i++;
  }
  return count;
}

/** Saved revisions (1 for a file written once; a linearized file's first-page section is not a save) and signature
 *  dictionaries, read from the file's structure; null for a file over `SOURCE_BYTES_IN_PROCESS`, which is not scanned. */
async function structureOf(source: ProviderSource, ctx: PdfContext): Promise<Pick<PdfFacts, "revisions" | "signatures">> {
  const read = source.bytes > SOURCE_BYTES_IN_PROCESS ? null : await ctx.env.readBinaryFile(source.path, visionContext(ctx.signal));
  if (!read?.ok) return { revisions: null, signatures: null };
  const raw = Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength).toString("latin1");
  const head = raw.slice(0, 1024);
  const first = head.search(/\d+\s+\d+\s+obj\b/);
  const linearized = first >= 0 && (head.slice(first).split("endobj")[0] ?? "").includes("/Linearized");
  const saves = saveChain(raw);
  return { revisions: saves === null ? null : Math.max(1, saves - (linearized && saves > 1 ? 1 : 0)), signatures: signatureCount(raw) };
}

/** The facts and the text of every page, from the first provider that reads the file; kept once per content and provider. */
export async function pdfDocument(source: ProviderSource, ctx: PdfContext): Promise<PdfOutcome<PdfDocument>> {
  const kept = derivations(ctx);
  return viaProviders(ctx, { kind: "pdf", capability: "text", what: "the text of a PDF" }, async (provider, version, call) => {
    const name = `${derivedName(source, provider, version)}.pdf.json`;
    const keptDoc = await kept.read(name);
    try {
      const doc = keptDoc && (JSON.parse(Buffer.from(keptDoc).toString("utf8")) as PdfDocument);
      if (doc && Array.isArray(doc.pages) && doc.facts && doc.madeBy?.provider === provider.name) return doc;
    } catch { /* read it again */ }
    const read = "document" in provider
      ? await (provider as PdfProvider).document(source, call)
      : await provider.text!(source, {}, call).then((r) => ({ madeBy: r.madeBy, pages: r.pages.map((p) => p.text), info: undefined }));
    const info: PdfInfo = read.info ?? { pages: read.pages.length, pageSizes: [] };
    const textPages = read.pages.flatMap((text, i) => (text.trim() ? [i + 1] : []));
    const doc: PdfDocument = { madeBy: read.madeBy, facts: { ...info, textPages, ...(await structureOf(source, ctx)) }, pages: read.pages };
    await kept.keep(name, Buffer.from(JSON.stringify(doc), "utf8"));
    return doc;
  });
}

/** The pixels a complete PNG's header gives; null for bytes that start with no PNG signature or do not end in its IEND chunk. */
const pngSize = (png: Uint8Array): { width: number; height: number } | null => {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  return view.length > 45 && view.readUInt32BE(0) === 0x89504e47 && view.readUInt32BE(view.length - 8) === 0x49454e44 ? { width: view.readUInt32BE(16), height: view.readUInt32BE(20) } : null;
};

/** A page as a PNG at `dpi`: its size is the page's size in points times dpi over 72, rounded up. `path` is where the
 *  render is kept, or null when the host keeps nothing. */
export async function pdfPage(source: ProviderSource, ctx: PdfContext, request: { readonly page: number; readonly dpi: number }): Promise<PdfOutcome<{ readonly madeBy: MadeBy; readonly image: RenderedImage; readonly path: string | null }>> {
  if (!(Number.isInteger(request.page) && request.page >= 1 && Number.isFinite(request.dpi) && request.dpi > 0)) throw new RangeError(`not a page render: page ${request.page} at ${request.dpi} dpi`);
  const kept = derivations(ctx);
  return viaProviders(ctx, { kind: "pdf", capability: "render", what: "the page image of a PDF" }, async (provider, version, call) => {
    const name = `${derivedName(source, provider, version, `-p${request.page}-${request.dpi}dpi`)}.png`;
    const keptPng = await kept.read(name);
    const keptSize = keptPng && pngSize(keptPng);
    if (keptPng && keptSize) return { madeBy: { provider: provider.name, version }, image: { data: keptPng, mimeType: "image/png", ...keptSize }, path: kept.path(name) };
    const made = await provider.render!(source, request, call);
    return { madeBy: made.madeBy, image: made.image, path: made.image.mimeType === "image/png" ? await kept.keep(name, made.image.data) : null };
  });
}

/** The text with a mark before each page, as `read` shows a document: a page with no text layer is listed, not dropped. */
export const pdfMarkedText = (pages: readonly string[]): string =>
  pages.map((text, i) => (text.trim() ? `--- page ${i + 1} ---\n${text}` : `--- page ${i + 1} (no text layer: read with page=${i + 1} to look at it) ---`)).join("\n\n");

/** The text of a PDF held in memory, each page headed `[page N]`; null when no page has text (a scan), no provider can
 *  read it, or the caller has stopped waiting. The bytes are written to the environment for the providers, and removed. */
export async function pdfText(bytes: Uint8Array, ctx: Omit<PdfContext, "deriveDir">): Promise<string | null> {
  if (ctx.signal?.aborted) return null;
  const c = visionContext(ctx.signal);
  const dir = await ctx.env.createTempDir("pi-vision-pdf-text-", c);
  if (!dir.ok) return null;
  try {
    const path = `${dir.value}/fetched.pdf`;
    if (!(await ctx.env.writeFile(path, bytes, c)).ok) return null;
    const read = await pdfDocument({ path, kind: "pdf", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, ctx);
    return read.ok && read.value.pages.some((text) => text.trim()) ? read.value.pages.map((text, i) => `[page ${i + 1}]\n${text}`).join("\n\n") : null;
  } catch (error) {
    if (ctx.signal?.aborted) return null;
    throw error;
  } finally {
    await ctx.env.remove(dir.value, { recursive: true, force: true }, visionContext());
  }
}
