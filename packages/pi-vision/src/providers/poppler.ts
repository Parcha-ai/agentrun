// PDF text and pages through poppler in the environment (`pdftotext -layout`, `pdftoppm`, `pdfinfo`), when it is
// installed there. A page is drawn through its crop box, as `pdfinfo` sizes it and as PDFium and pdf.js show it: poppler
// draws the media box by default, which can hold what the page's own viewer hides. Every program runs through the
// environment's `exec`, which answers with an exit code and no output: a program's output goes to files beside the call
// and is read back. The environment's timeout is in seconds, as pi's is.
import { visionContext } from "../core/env.js";
import { PDF_RENDER_MAX_PIXELS, PDF_TEXT_TIMEOUT_MS, PdfProviderError, type PdfInfo, type PdfProvider } from "../core/pdf.js";
import type { ProviderCall } from "../core/provider.js";

export type PopplerOptions = { readonly timeoutS?: number; readonly maxPixels?: number };

/** Runs the program in "$@" with its output in the two files named first. */
const CAPTURE = 'o=$1; e=$2; shift 2; exec "$@" >"$o" 2>"$e"';
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
let runs = 0;

/** The program's standard output; a non-zero exit is an error holding the first line of its standard error. */
async function run(call: ProviderCall, timeoutS: number, argv: readonly string[]): Promise<string> {
  const c = visionContext(call.signal);
  const base = `${call.tempDir}/run-${++runs}`;
  const ran = await call.env.exec(["sh", "-c", CAPTURE, "sh", `${base}.out`, `${base}.err`, ...argv], { timeout: timeoutS }, c);
  if (!ran.ok) throw ran.error.code === "timeout" ? new PdfProviderError("over_budget", `${argv[0]} did not finish within ${timeoutS} s`) : ran.error;
  if (ran.value.exitCode === 0) {
    const output = await call.env.readBinaryFile(`${base}.out`, c);
    if (!output.ok) throw output.error;
    return utf8(output.value);
  }
  const diagnostics = await call.env.readBinaryFile(`${base}.err`, c);
  throw new Error((diagnostics.ok && firstLine(utf8(diagnostics.value))) || `${argv[0]} exited ${ran.value.exitCode}`);
}

const fail = (page: number): never => { throw new Error(`pdfinfo gave no size for page ${page}`); };

/** `pdfinfo`'s pages `first` to `last`: size in points (as the page is shown: a quarter turn swaps its sides), producer and creator. */
function parseInfo(out: string, first: number, last: number): PdfInfo {
  const field = (name: string) => new RegExp(`^${name}:\\s+(.+)$`, "m").exec(out)?.[1]?.trim();
  const sizes = new Map([...out.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((m) => [Number(m[1]), [Number(m[2]), Number(m[3])] as const]));
  const turns = new Map([...out.matchAll(/^Page\s+(\d+) rot:\s+(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]));
  const pageSizes = Array.from({ length: last - first + 1 }, (_, i) => {
    const [width, height] = sizes.get(first + i) ?? fail(first + i);
    return (turns.get(first + i) ?? 0) % 180 === 90 ? { width: height, height: width } : { width, height };
  });
  return { pages: last, pageSizes, ...(field("Producer") ? { producer: field("Producer")! } : {}), ...(field("Creator") ? { creator: field("Creator")! } : {}) };
}

export function popplerProvider(options: PopplerOptions = {}): PdfProvider {
  const timeoutS = options.timeoutS ?? PDF_TEXT_TIMEOUT_MS / 1000;
  const maxPixels = options.maxPixels ?? PDF_RENDER_MAX_PIXELS;
  const info = async (call: ProviderCall, path: string, first: number, last: number) => parseInfo(await run(call, timeoutS, ["pdfinfo", "-f", String(first), "-l", String(last), path]), first, last);
  const versions = new Map<string, string>();
  /** What `detect` found in the call's environment, found now when nothing asked yet. */
  const madeBy = async (call: ProviderCall) => {
    if (!versions.has(call.env.id)) await detect(call.env, call.signal);
    return { provider: "poppler", version: versions.get(call.env.id) ?? "" };
  };
  const document: PdfProvider["document"] = async (source, call) => {
    const text = (await run(call, timeoutS, ["pdftotext", "-layout", "-enc", "UTF-8", source.path, "-"])).split("\f");
    if (text.length > 1 && !text.at(-1)!.trim()) text.pop();
    return { madeBy: await madeBy(call), pages: text.map((page) => page.trimEnd()), info: await info(call, source.path, 1, text.length) };
  };
  const detect: PdfProvider["detect"] = async (env, signal) => {
    const needs = "poppler-utils (pdftotext, pdftoppm, pdfinfo)";
    const c = visionContext(signal);
    const dir = await env.createTempDir("pi-vision-poppler-", c);
    if (!dir.ok) return { available: false, needs, reason: dir.error.message.split("\n")[0]! };
    try {
      const out = `${dir.value}/versions`;
      const ran = await env.exec(["sh", "-c", 'for p in pdftotext pdftoppm pdfinfo; do "$p" -v 2>&1 | head -n 1; done >"$1"', "sh", out], { timeout: 30 }, c);
      const read = ran.ok ? await env.readBinaryFile(out, c) : null;
      const found = read?.ok ? [...utf8(read.value).matchAll(/version (\S+)/g)].map((m) => m[1]!) : [];
      if (found.length < 3) return { available: false, needs, reason: ran.ok ? "one of the programs is not on the PATH" : ran.error.message.split("\n")[0]! };
      versions.set(env.id, found[0]!);
      return { available: true, version: found[0]! };
    } finally {
      await env.remove(dir.value, { recursive: true, force: true }, visionContext());
    }
  };
  return {
    name: "poppler",
    capabilities: ["text", "render"],
    kinds: ["pdf"],
    detect,
    document,
    async text(source, request, call) {
      const read = await document(source, call);
      return { madeBy: read.madeBy, pages: read.pages.map((text, i) => ({ page: i + 1, text })).filter((p) => !request.pages || (p.page >= request.pages.from && p.page <= request.pages.to)) };
    },
    async render(source, request, call) {
      const c = visionContext(call.signal);
      const [size] = (await info(call, source.path, request.page, request.page)).pageSizes;
      const width = Math.ceil((size!.width * request.dpi) / 72);
      const height = Math.ceil((size!.height * request.dpi) / 72);
      if (width * height > maxPixels) throw new PdfProviderError("over_budget", `page ${request.page} at ${request.dpi} dpi is ${width}x${height} px, over the ${maxPixels} pixel cap; render it at a lower dpi`);
      const stem = `${call.tempDir}/page-${++runs}`;
      await run(call, timeoutS, ["pdftoppm", "-f", String(request.page), "-l", String(request.page), "-png", "-singlefile", "-cropbox", "-r", String(request.dpi), source.path, stem]);
      const read = await call.env.readBinaryFile(`${stem}.png`, c);
      if (!read.ok) throw new Error("pdftoppm wrote no image");
      const view = Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength);
      return { madeBy: await madeBy(call), image: { data: read.value, mimeType: "image/png", width: view.readUInt32BE(16), height: view.readUInt32BE(20) } };
    },
  };
}
