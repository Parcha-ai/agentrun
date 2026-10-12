// The package's own readers, one a kind, each composed from the planner and that kind's primitives: an image fitted or
// tiled; a document's text with page marks, or its pages rendered at the planner's dpi with their text beside them; an
// office document's text and a spreadsheet's cells; a video's frames by seek, or the file or a window of it for a route
// that takes video. The providers and the image processor are the call's, as the host passed them; a provider that
// cannot run is passed over, and what nothing can do is a typed miss.

import { randomUUID } from "node:crypto";
import type { MissCode } from "./contract.js";
import { fitImage, fitSentence } from "./image.js";
import { imageHeader, sniffKind, type Kind } from "./kinds.js";
import { PAGE_TEXT_CHARS, SOURCE_BYTES_IN_PROCESS } from "./limits.js";
import { ProviderMiss } from "./derive.js";
import { notRenderedNote } from "./office.js";
import { pdfDocument, pdfMarkedText, pdfPage, type PdfContext } from "./pdf.js";
import { plan, type Fit, type Part } from "./plan.js";
import { detectOnce, type ProviderCall } from "./provider.js";
import type { KindContext, KindReader, KindResult, ReadKinds } from "./read.js";
import { describeVideo, probeVideo, unprobedVideo, videoAsIs, videoClip, videoFrames, videoWindow, type VideoProvider } from "./video.js";
import { visionContext } from "./env.js";
import type { ImageContent, TextContent } from "./host.js";

/** The call's providers that read `kind`, in the host's order. */
const providersFor = (context: KindContext, kind: Kind) => context.providers.filter((p) => p.kinds.includes(kind));
const callOf = (context: KindContext): ProviderCall => ({ env: context.env, signal: context.signal, tempDir: context.tempDir });
const block = (b: { readonly data: string; readonly mimeType: string }): ImageContent => ({ type: "image", data: b.data, mimeType: b.mimeType });
const text = (value: string): TextContent => ({ type: "text", text: value });
/** A derived part as a content block: a video goes as an image block with its video MIME type. */
const asBlock = (part: Part): TextContent | ImageContent => (part.type === "text" ? text(part.text) : block(part));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type Fitted = { readonly blocks: ImageContent[]; readonly sentence: string; readonly tiles: number; readonly fit: Fit };

/** A fitted image's blocks, the sentence that maps them back to the original, and its fit; or the miss. */
async function fitted(context: KindContext, bytes: Uint8Array, mimeType: string): Promise<Fitted | { readonly miss: MissCode; readonly reason: string }> {
  if (!context.images) return { miss: "needs", reason: "an image processor (Photon or sharp) from the host, to fit it to the image limits" };
  const fit = await fitImage(context.images, bytes, mimeType, { ...context.limits.image, imagesPerCall: context.limits.imagesPerCall });
  if (fit.fit === "refused") return { miss: fit.code, reason: `${fit.limit}, and ${fit.why}` };
  const reduction: Fit["reduction"] = fit.fit === "tiled" ? "tiled" : fit.fit === "resized" ? "downscaled" : "as_is";
  const largest = fit.blocks[0]!;
  return {
    blocks: fit.blocks.map(block), sentence: fitSentence(fit, context.limits.image), tiles: fit.blocks.length,
    fit: { reduction, original: fit.original, shown: { width: largest.width, height: largest.height, ...(fit.blocks.length > 1 ? { tiles: fit.blocks.length } : {}) } },
  };
}

/** The most of a source's file name a kept text file carries, before the hash that names its bytes. */
const SAVED_NAME_CHARS = 80;
/** A path as the model is told it: relative to the environment's directory when it lies under it. */
const shownPath = (context: KindContext, path: string) => (path.startsWith(`${context.env.cwd}/`) ? path.slice(context.env.cwd.length + 1) : path);

/** A document's text kept beside its other derivations, for an agent to search with its shell: `<file name>-<first 16
 *  of the source's hash>[-p<page>].txt`, written under another name and renamed, and left as it is when it is already
 *  there (the name carries the hash of the bytes, so it holds the same text). Null when the read keeps nothing or the
 *  file could not be written. */
async function keepText(request: Parameters<KindReader>[0], context: KindContext, body: string): Promise<string | null> {
  if (!context.deriveDir) return null;
  const ctx = visionContext(context.signal);
  // The file's own name, without anything a name taken from a link carries after `?` or `#`.
  const base = request.name.split("/").pop()!.split("?")[0]!.split("#")[0]!.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, SAVED_NAME_CHARS);
  const file = `${context.deriveDir}/${base}-${request.source.sha256.slice(0, 16)}${request.page !== undefined ? `-p${request.page}` : ""}.txt`;
  if (!(await context.env.fileInfo(file, ctx)).ok) {
    const part = `${file}.${randomUUID().slice(0, 8)}.part`;
    const made = await context.env.createDir(context.deriveDir, { recursive: true }, ctx);
    const wrote = made.ok && (await context.env.writeFile(part, body, ctx)).ok && (await context.env.renameFile(part, file, ctx)).ok;
    if (!wrote) { await context.env.remove(part, { force: true }, ctx); return null; }
  }
  return shownPath(context, file);
}

/** The source's bytes, when the process may hold them. */
async function bytesOf(context: KindContext, path: string, size: number): Promise<Uint8Array | KindResult> {
  if (size > SOURCE_BYTES_IN_PROCESS) return { miss: "over_budget", reason: `it is ${size} bytes, over the ${SOURCE_BYTES_IN_PROCESS} read into this process` };
  const read = await context.env.readBinaryFile(path, visionContext(context.signal));
  if (!read.ok) return { miss: "unreadable", reason: `it could not be read (${read.error.message.split("\n")[0]})` };
  return read.value;
}

const readImage: KindReader = async (request, context) => {
  const bytes = request.data ?? await bytesOf(context, request.source.path, request.source.bytes);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const shown = await fitted(context, bytes, request.mimeType);
  if ("miss" in shown) return shown;
  const size = request.width ? `${bytes.length} bytes, ${request.width}x${request.height}` : `${bytes.length} bytes`;
  const head = `Image file ${request.name} (${request.mimeType}, ${size}).${shown.sentence ? ` ${shown.sentence}` : ""}${request.ask ? ` Asked: ${request.ask}` : ""}`;
  return { content: [text(head), ...shown.blocks], fit: shown.fit, ...(shown.tiles > 1 ? { media: { units: shown.blocks.map(() => 0) } } : {}) };
};

const readPdf: KindReader = async (request, context) => {
  const ctx: PdfContext = { env: context.env, providers: providersFor(context, "pdf"), deriveDir: context.deriveDir, signal: context.signal };
  const doc = await pdfDocument(request.source, ctx);
  if (!doc.ok) return { miss: doc.miss.code, reason: doc.miss.detail };
  const { facts, pages, madeBy } = doc.value;
  const { page, ask, name } = request;
  if (page !== undefined && page > facts.pages) return { refusal: `Cannot read ${name}: page ${page} is past the end of the document (${plural(facts.pages, "page")}).` };
  const selector = { ...(page !== undefined ? { pages: { from: page, to: page } } : {}), render: Boolean(ask) };
  const planned = plan({ kind: "pdf", bytes: request.source.bytes, sha256: request.source.sha256, pages: facts.pages, pageSizes: facts.pageSizes, textPages: facts.textPages }, selector, context.limits, "show");
  if (planned.fit.refusal) return { miss: planned.fit.refusal.code, reason: planned.fit.refusal.detail };
  if (planned.fit.reduction === "text_only") {
    const scans = page === undefined ? pages.flatMap((t, i) => (t.trim() ? [] : [i + 1])) : [];
    const listed = scans.length ? ` ${scans.length === 1 ? "Page" : "Pages"} ${scans.slice(0, 20).join(", ")}${scans.length > 20 ? ", ..." : ""} ${scans.length === 1 ? "has" : "have"} no text layer: read with page=N to look.` : "";
    const body = page !== undefined ? pages[page - 1]! : pdfMarkedText(pages);
    const saved = await keepText(request, context, body);
    const head = `Text of ${name}${page !== undefined ? ` page ${page}` : ` (${plural(facts.pages, "page")})`}, extracted with ${madeBy.provider}${saved ? `; the text is saved at ${saved}` : ""}.${listed} Pass page=N for one page, or ask to look at a rendered page.`;
    return { content: [text(head)], text: body, fit: planned.fit, document: { ...(saved ? { text: saved } : {}), extractor: madeBy.provider, ...(page !== undefined ? { page } : {}), pages: facts.pages } };
  }
  // Each page planned is rendered once at its dpi and fitted (tiled when tall) to the image limits.
  const shownPages = [...new Set(planned.parts.map((part) => part.fragment.page!.from))];
  const span = shownPages.length === facts.pages ? `its ${plural(facts.pages, "page")}` : `pages ${shownPages[0]}-${shownPages.at(-1)} of ${facts.pages}`;
  const why = ask ? `${name}: ${span} shown rendered. Asked: ${ask}`
    : page !== undefined ? `${name}: page ${page} has no text layer (a scan), so it is shown rendered.`
    : `${name} has no text layer (a scan): ${span} shown rendered; read with page=N for another.`;
  const content: (TextContent | ImageContent)[] = [text(why)];
  const renders: string[] = [];
  let blocks = 0;
  for (const at of shownPages) {
    const dpi = planned.parts.find((part) => part.fragment.page!.from === at)!.dpi!;
    const rendered = await pdfPage(request.source, ctx, { page: at, dpi });
    if (!rendered.ok) return { miss: rendered.miss.code, reason: `page ${at} could not be rendered: ${rendered.miss.detail}`, text: pages[at - 1] };
    const shown = await fitted(context, rendered.value.image.data, rendered.value.image.mimeType);
    if ("miss" in shown) return { ...shown, text: pages[at - 1] };
    const layer = pages[at - 1]?.trim();
    const beside = layer ? `\nText layer of this page:\n${layer.length > PAGE_TEXT_CHARS ? `${layer.slice(0, PAGE_TEXT_CHARS)}\n[page text continues; read with page=${at} and no ask for all of it]` : layer}` : "";
    const kept = rendered.value.path ? shownPath(context, rendered.value.path) : null;
    if (kept) renders.push(kept);
    content.push(text(`PDF ${name}, page ${at} of ${facts.pages}, rendered at ${dpi} dpi (${rendered.value.image.width}x${rendered.value.image.height})${kept ? ` and saved at ${kept}` : ""}.${shown.sentence ? ` ${shown.sentence}` : ""}${beside}`), ...shown.blocks);
    blocks += shown.tiles;
  }
  return { content, fit: planned.fit, media: { ...(page === undefined && shownPages.length === 1 ? { page: shownPages[0] } : {}), ...(blocks > 1 ? { units: Array<number>(blocks).fill(0) } : {}), ...(renders.length ? { derived: renders } : {}) } };
};

/** An office document's or a sheet's text through the first office provider that runs; a sheet is a page of cells. */
async function officeText(request: Parameters<KindReader>[0], context: KindContext, kind: "office" | "sheet"): Promise<KindResult> {
  for (const provider of providersFor(context, kind).filter((p) => p.text)) {
    const found = await detectOnce(provider, context.env);
    if (!found.available) continue;
    try {
      const out = await provider.text!(request.source, request.page !== undefined ? { pages: { from: request.page, to: request.page } } : {}, callOf(context));
      if (request.page !== undefined && !out.pages.length) return { refusal: `Cannot read ${request.name}: page ${request.page} is past the end of the document.` };
      const marked = out.pages.map((p) => (out.pages.length > 1 ? `--- ${kind === "sheet" ? "sheet" : "page"} ${p.page} ---\n${p.text}` : p.text)).join("\n\n");
      const asked = request.ask ? ` Asked: ${request.ask}. It is answered from this text: a rendered page needs LibreOffice (soffice) in the environment.` : "";
      const saved = await keepText(request, context, marked);
      const head = `${kind === "sheet" ? "Cells" : "Text"} of ${request.name}${request.page !== undefined ? ` page ${request.page}` : ` (${plural(out.pages.length, kind === "sheet" ? "sheet" : "page")})`}, read with ${out.madeBy.provider}${saved ? `; the text is saved at ${saved}` : ""}. ${notRenderedNote(kind)}${asked}`;
      const document = { ...(saved ? { text: saved } : {}), extractor: out.madeBy.provider, ...(request.page !== undefined ? { page: request.page } : { pages: out.pages.length }) };
      return { content: [text(head)], text: marked, fit: { reduction: "text_only", shown: { pages: out.pages.length } }, document };
    } catch (error) {
      if (context.signal?.aborted) throw error;
      if (error instanceof ProviderMiss) return { miss: error.code, reason: error.message };
      throw error;
    }
  }
  return { miss: "needs", reason: `reading ${kind === "sheet" ? "a spreadsheet" : "an office document"} needs an office reader in the host's providers` };
}

const readVideo: KindReader = async (request, context) => {
  const { source, name, ask } = request;
  const call = callOf(context);
  const asked = ask ? ` Asked: ${ask}` : "";
  const windowed = request.fromS !== undefined || request.toS !== undefined;
  // A lead that takes video is sent a file within the inline budget as it is: no program runs, not even a probe.
  if (context.limits.video.native && !windowed) {
    const whole = await videoAsIs(source, unprobedVideo(source), context.limits, call);
    if (whole.ok) return { content: [text(`Video file ${name} (${whole.bytes} bytes), sent as it is; read a from_s..to_s window for a part of it.${asked}`), asBlock(whole.part)], fit: { reduction: "as_is", shown: { bytes: whole.bytes } } };
    if (whole.code !== "over_budget") return { miss: whole.code, reason: whole.text };
  }
  let provider: VideoProvider | undefined;
  for (const p of providersFor(context, "video")) if (!provider && "probe" in p && (await detectOnce(p, context.env)).available) provider = p as VideoProvider;
  const probed = provider ? await probeVideo(provider, source, call) : undefined;
  const facts = probed?.facts ?? { durationS: null, width: null, height: null, fps: null, bytes: source.bytes };
  const window = windowed ? videoWindow(facts, request.fromS, request.toS) : undefined;
  if (typeof window === "string") return { refusal: `Cannot read ${name}: ${window}.` };
  const head = `Video file ${name}: ${describeVideo(facts)}.`;
  if (context.limits.video.native) {
    // The file itself when it fits; never the whole file re-encoded, so a larger one is read by window.
    if (!window) {
      const whole = await videoAsIs(source, facts, context.limits, call);
      return whole.ok ? { content: [text(`${head}${asked}`), asBlock(whole.part)], fit: { reduction: "as_is", shown: { bytes: whole.bytes } } } : { miss: whole.code, reason: whole.text };
    }
    if (!provider) return { miss: "needs", reason: "cutting a window of a video needs ffmpeg in the environment" };
    const clip = await videoClip(provider, source, window, context.limits, call);
    if (!clip.ok) return { miss: clip.code, reason: clip.text };
    return { content: [text(`${head} Shown: the window ${clip.fromS}s to ${clip.toS}s (${clip.bytes} bytes).${asked}`), asBlock(clip.part)], fit: { reduction: "windowed", shown: { bytes: clip.bytes } }, media: { fromS: clip.fromS, toS: clip.toS } };
  }
  if (!provider) return { miss: "video_unseeable", reason: "this route takes no video and ffmpeg is not in the environment to take frames of it" };
  if (probed?.miss) return { miss: probed.miss.code, reason: probed.miss.text };
  const planned = plan({ kind: "video", bytes: source.bytes, sha256: source.sha256, ...(facts.width && facts.height ? { width: facts.width, height: facts.height } : {}), ...(facts.durationS ? { durationS: facts.durationS } : {}) }, { ...(window ? { fromS: window.fromS, toS: window.toS } : {}) }, context.limits, "show");
  if (planned.fit.refusal) return { miss: planned.fit.refusal.code, reason: planned.fit.refusal.detail };
  const atS = planned.parts.flatMap((part) => (part.atS === undefined ? [] : [part.atS]));
  const frames = await videoFrames(provider, source, { atS, maxEdge: Math.max(context.limits.image.maxWidth, context.limits.image.maxHeight) }, context.limits, call);
  if (!frames.ok) return { miss: frames.code, reason: frames.text };
  const times = atS.filter((t) => !frames.missing.includes(t));
  const shown = `Shown: ${plural(frames.parts.length, "frame")} found by seek at ${times.join(", ")} s${window ? ` within ${window.fromS}s to ${window.toS}s` : ""}; read a from_s..to_s window for a closer look.`;
  // Each frame goes with the line that names its time, for the lead and for eyes that look in its place.
  return {
    content: [text(`${head} ${shown}${asked}`), ...frames.parts.flatMap((part, i) => [text(`Frame at ${times[i]} s.`), asBlock(part)])], fit: planned.fit,
    media: { ...(window ? { fromS: window.fromS, toS: window.toS } : {}), ...(frames.parts.length > 1 ? { units: frames.parts.map(() => 0) } : {}) },
  };
};

/** The package's own kind wiring, `read`'s default: a host that replaces or adds one reader spreads it. */
export const PACKAGE_KINDS: ReadKinds = {
  sniff: sniffKind,
  sizeOf: imageHeader,
  readers: { image: readImage, pdf: readPdf, office: (r, c) => officeText(r, c, "office"), sheet: (r, c) => officeText(r, c, "sheet"), video: readVideo },
};
