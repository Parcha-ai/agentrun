// PDF: the free facts (pages, their sizes, which carry a text layer, producer, creator, saved revisions, signatures),
// text by page, and a page rendered at a dpi. Zero install: `unpdf` for text and PDFium (WASM) for pages, each in a
// worker thread with a time and memory cap, since a hostile file can run a reader out of time or memory; poppler when
// the environment has it. Providers are tried in the order the host lists them: the first that reads the file wins, a
// failure falls to the next, and every result names the provider and version that made it. What is derived is kept
// under the host's derive directory, named by the source's hash, the provider and the parameters, written to a temp
// name and renamed. The text of a PDF held in memory is what a browser's fetch takes for a fetched document.

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { MissCode } from "./contract.js";
import { visionContext, type VisionEnv } from "./env.js";
import { SOURCE_BYTES_IN_PROCESS } from "./limits.js";
import { detectOnce, type MadeBy, type Provider, type ProviderCall, type ProviderSource, type RenderedImage } from "./provider.js";

/** Time for one document's text: the time hosts already give `pdftotext` (read 2026-10-11). */
export const PDF_TEXT_TIMEOUT_MS = 120_000;
/** Time for one page's render: a 200 dpi scan takes 0.9 s in poppler and 0.5 s in PDFium (measured 2026-10-11); a page that takes a minute is not one to read. */
export const PDF_RENDER_TIMEOUT_MS = 60_000;
/** The memory of a worker reading a PDF, its JavaScript heap and, for PDFium, its WASM memory: pdf.js held 455 MB for 200 pages (measured 2026-10-11). */
export const PDF_WORKER_MEMORY_MB = 1024;
/** The most pixels one page render may have: a 150 dpi render of an A0 sheet. The planner asks for at most 2,000 px on a long edge (4 MP); a bitmap is 4 bytes a pixel in WASM beside a copy and the PNG's rows (2026-10-11). */
export const PDF_RENDER_MAX_PIXELS = 25_000_000;

/** Why a PDF could not be read, as the model reads it after the file's name. */
export type PdfMiss = { readonly code: MissCode; readonly detail: string };
export type PdfOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly miss: PdfMiss };

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

/** What a provider throws for a file it cannot read, so the miss carries the right code. Any other error is `unreadable`. */
export class PdfProviderError extends Error {
  constructor(readonly code: "unreadable" | "over_budget", message: string) {
    super(message);
    this.name = "PdfProviderError";
  }
}

export type PdfContext = {
  readonly env: VisionEnv;
  /** In the order to try them: a binary first, the zero-install reader last. */
  readonly providers: readonly Provider[];
  /** Where derivations are kept. Without it nothing is kept. */
  readonly deriveDir?: string;
  readonly signal?: AbortSignal;
};

const firstLine = (error: unknown): string => String((error as Error)?.message ?? error).split("\n")[0]!.trim();

export type PdfWorkerCaps = { readonly timeoutMs: number; readonly memoryMb: number; readonly signal?: AbortSignal };

/** Runs `script`, plain JavaScript with no `require` or `import` statement, in a worker thread with `input` as its
 *  `workerData`. The script posts `{ value }` or `{ error: { name, message } }` once. A worker that runs out of time or
 *  heap is terminated and the call is an `over_budget` error. The script is a string, so a bundled host carries it. */
export function runPdfWorker<T>(script: string, input: Record<string, unknown>, caps: PdfWorkerCaps): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (caps.signal?.aborted) return reject(caps.signal.reason);
    // The worker gets no environment variables (a file it reads cannot reach the host's keys) and its output is dropped.
    const worker = new Worker(script, { eval: true, workerData: input, env: {}, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: caps.memoryMb } });
    worker.stdout.resume();
    worker.stderr.resume();
    const end = (settle: () => void) => {
      clearTimeout(timer);
      caps.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      settle();
    };
    const onAbort = () => end(() => reject(caps.signal!.reason));
    const timer = setTimeout(() => end(() => reject(new PdfProviderError("over_budget", `the PDF engine did not finish within ${Number((caps.timeoutMs / 1000).toFixed(2))} s`))), caps.timeoutMs);
    caps.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (m: { value?: T; error?: { name?: string; message?: string } }) =>
      end(() => (m.error ? reject(Object.assign(new Error(m.error.message), { name: m.error.name })) : resolve(m.value as T))));
    worker.once("error", (error: Error & { code?: string }) =>
      end(() => reject(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? new PdfProviderError("over_budget", `the PDF engine needed more than ${caps.memoryMb} MB`) : error)));
    worker.once("exit", (code) => end(() => reject(new Error(`the PDF engine stopped (exit ${code})`))));
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
    throw new PdfProviderError("over_budget", `the file is ${Math.ceil(source.bytes / 1048576)} MiB and this reader holds a PDF in memory up to ${SOURCE_BYTES_IN_PROCESS / 1048576} MiB; a larger file needs poppler (poppler-utils) in the environment`);
  }
  const read = await call.env.readBinaryFile(source.path, visionContext(call.signal));
  if (!read.ok) throw read.error;
  return read.value;
}

const missed = (code: MissCode, detail: string): { ok: false; miss: PdfMiss } => ({ ok: false, miss: { code, detail } });

/** Runs `attempt` with each provider that has the capability and runs here, in order, until one answers. */
async function viaProviders<T>(ctx: PdfContext, capability: "text" | "render", what: string, attempt: (provider: Provider, version: string, call: ProviderCall) => Promise<T>): Promise<PdfOutcome<T>> {
  const scratch = await ctx.env.createTempDir("pi-vision-pdf-", visionContext(ctx.signal));
  if (!scratch.ok) return missed("unreadable", `no scratch directory in the environment (${firstLine(scratch.error)})`);
  const call: ProviderCall = { env: ctx.env, signal: ctx.signal, tempDir: scratch.value };
  const needs: string[] = [];
  const failures = new Map<string, string[]>();
  let code: MissCode | undefined;
  try {
    for (const provider of ctx.providers.filter((p) => p.kinds.includes("pdf") && p.capabilities.includes(capability))) {
      const found = await detectOnce(provider, ctx.env);
      if (!found.available) { needs.push(`${found.needs} (${found.reason})`); continue; }
      try {
        return { ok: true, value: await attempt(provider, found.version, call) };
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        code ??= error instanceof PdfProviderError ? error.code : "unreadable";
        failures.set(firstLine(error), [...(failures.get(firstLine(error)) ?? []), provider.name]);
      }
    }
  } finally {
    await ctx.env.remove(scratch.value, { recursive: true, force: true }, visionContext());
  }
  return code ? missed(code, [...failures].map(([cause, by]) => `${cause} (${by.join(", ")})`).join("; ")) : missed("needs", `reading ${what} of a PDF needs ${needs.join(" or ") || "a PDF reader in the host's providers"}`);
}

const keptAt = (ctx: PdfContext, name: string) => (ctx.deriveDir ? `${ctx.deriveDir}/${name}` : null);
/** `<hash prefix><part>.<provider>-<version>`: what a derivation is named by. */
const stemOf = (source: ProviderSource, provider: Provider, version: string, part = "") => `${source.sha256.slice(0, 16)}${part}.${provider.name}-${version}`.replace(/[^\w.-]/g, "_");

async function readKept(ctx: PdfContext, name: string): Promise<Uint8Array | null> {
  const at = keptAt(ctx, name);
  const read = at ? await ctx.env.readBinaryFile(at, visionContext(ctx.signal)) : null;
  return read?.ok ? read.value : null;
}

/** Writes a derivation to a temp name and renames it into place; the path, or null when nothing was kept. */
async function keep(ctx: PdfContext, name: string, bytes: Uint8Array): Promise<string | null> {
  const at = keptAt(ctx, name);
  if (!at) return null;
  const c = visionContext(ctx.signal);
  const temp = `${at}.${randomBytes(4).toString("hex")}.tmp`;
  const done = (await ctx.env.createDir(ctx.deriveDir!, { recursive: true }, c)).ok && (await ctx.env.writeFile(temp, bytes, c)).ok && (await ctx.env.renameFile(temp, at, c)).ok;
  if (!done) await ctx.env.remove(temp, { force: true }, c);
  return done ? at : null;
}

/** Saved revisions and signature dictionaries, counted in the file's own bytes: each save ends with `startxref N %%EOF`,
 *  a linearized file carries one more for its first page, and a signature dictionary holds a `/ByteRange` over the file. */
async function structureOf(source: ProviderSource, ctx: PdfContext): Promise<Pick<PdfFacts, "revisions" | "signatures">> {
  const read = source.bytes > SOURCE_BYTES_IN_PROCESS ? null : await ctx.env.readBinaryFile(source.path, visionContext(ctx.signal));
  if (!read?.ok) return { revisions: null, signatures: null };
  const raw = Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength).toString("latin1");
  const saves = raw.match(/startxref\s+\d+\s+%%EOF/g)?.length ?? 0;
  return { revisions: saves ? Math.max(1, saves - (raw.slice(0, 1024).includes("/Linearized") ? 1 : 0)) : null, signatures: raw.match(/\/ByteRange\s*\[/g)?.length ?? 0 };
}

/** The facts and the text of every page, from the first provider that reads the file; kept once per content and provider. */
export async function pdfDocument(source: ProviderSource, ctx: PdfContext): Promise<PdfOutcome<PdfDocument>> {
  return viaProviders(ctx, "text", "the text", async (provider, version, call) => {
    const name = `${stemOf(source, provider, version)}.pdf.json`;
    const keptDoc = await readKept(ctx, name);
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
    await keep(ctx, name, Buffer.from(JSON.stringify(doc), "utf8"));
    return doc;
  });
}

const pngSize = (png: Uint8Array) => {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
};

/** A page as a PNG at `dpi`: its size is the page's size in points times dpi over 72, rounded up. `path` is where the
 *  render is kept, or null when the host keeps nothing. */
export async function pdfPage(source: ProviderSource, ctx: PdfContext, request: { readonly page: number; readonly dpi: number }): Promise<PdfOutcome<{ readonly madeBy: MadeBy; readonly image: RenderedImage; readonly path: string | null }>> {
  if (!(Number.isInteger(request.page) && request.page >= 1 && Number.isFinite(request.dpi) && request.dpi > 0)) throw new RangeError(`not a page render: page ${request.page} at ${request.dpi} dpi`);
  return viaProviders(ctx, "render", "the page image", async (provider, version, call) => {
    const name = `${stemOf(source, provider, version, `-p${request.page}-${request.dpi}dpi`)}.png`;
    const keptPng = await readKept(ctx, name);
    if (keptPng) return { madeBy: { provider: provider.name, version }, image: { data: keptPng, mimeType: "image/png", ...pngSize(keptPng) }, path: keptAt(ctx, name) };
    const made = await provider.render!(source, request, call);
    return { madeBy: made.madeBy, image: made.image, path: made.image.mimeType === "image/png" ? await keep(ctx, name, made.image.data) : null };
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
