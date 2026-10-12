// The guard: every image block a tool returns is fitted to the lead's limits or refused with a typed reason; the
// original never stays in the result when a fit fails. Then each block goes where the lead's route can take it: shown
// natively and filed as a look, or answered by the eyes (the agent's question, or a description) and filed with what
// the eyes cost, or replaced by a miss the model can act on. The blocks of an image read as tiles (`details.media.tiles`)
// are one unit: kept together, looked at in one request and filed as one look.

import { formatFragment } from "./fragments.js";
import { blocksSha256, fileLook, lookKey, type Filing, type LookRecord } from "./evidence.js";
import type { CallContext, CallSetup, EyesAnswer, ImageContent, Json, TextContent, ToolResult, Usage } from "./host.js";
import { KINDS, type Kind } from "./kinds.js";
import { firstLine, MISS_ACTION, reportMiss, type Miss } from "./misses.js";
import { notBuilt } from "./not-built.js";
import type { Fit, Part } from "./plan.js";

/** The question the eyes answer when the agent asked none: say what is shown, completely and only that. */
export const DESCRIBE_ASK =
  "Describe what is shown so a reader who cannot see it knows exactly what it shows. List every visible text, " +
  "label, button, link, price, and form field; every logo, brand mark, badge, icon and seal (name the brand when " +
  "the mark is legible or unmistakable, say 'unidentified' when it is not); banners, overlays, drawers, modals " +
  "and error states; and the layout order from top to bottom. For a video, walk the distinct screens in order " +
  "with their timestamps. Report only what is rendered.";

/** What a door says about the media in its result: the file, the agent's question and window or page, and what it
 *  learned (its hash, its pixels, how it was fitted). `tiles` counts the blocks one image came back as. */
export type MediaDetails = {
  readonly kind?: string; readonly path?: string; readonly ask?: string; readonly fromS?: number; readonly toS?: number; readonly page?: number;
  readonly tiles?: number; readonly sha256?: string; readonly original?: string; readonly fit?: Fit;
};

/** The pixels an image's header states, without decoding it (`imageHeader`, kinds.ts). */
export type ImageSize = (bytes: Uint8Array) => { readonly width: number; readonly height: number } | null;
const headerNotBuilt: ImageSize = () => notBuilt("the image header reader");

type Sized = ImageContent & { readonly width: number; readonly height: number };

const isVideo = (block: ImageContent) => block.mimeType.startsWith("video/");
const raw = (block: ImageContent) => Buffer.from(block.data, "base64");
const kindOf = (media: MediaDetails, video: boolean): Kind =>
  media.kind === "pdf_page" ? "pdf" : (KINDS as readonly string[]).includes(media.kind ?? "") ? media.kind as Kind : video ? "video" : "image";
const addUsage = (a: Usage | undefined, b: Usage): Usage => (a ? {
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens,
  cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output, cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total },
} : b);
/** The lead model's name for receipts: a catalog entry's `id`, a reference's `modelId`. */
const leadName = (model: unknown): string => {
  const m = (model && typeof model === "object" ? model : {}) as { id?: unknown; modelId?: unknown };
  return typeof m.id === "string" && m.id ? m.id : typeof m.modelId === "string" && m.modelId ? m.modelId : "the lead model";
};

/** The block within the image limits: as it is when its header says so, else what the processor makes of it; the
 *  miss, never the original, when nothing fits. */
async function fitted(block: ImageContent, setup: CallSetup, sizeOf: ImageSize, lead: string): Promise<Sized | Miss> {
  const { maxWidth, maxHeight, maxBytes } = setup.limits.image;
  const within = (b: ImageContent) => { const size = sizeOf(raw(b)); return size && size.width <= maxWidth && size.height <= maxHeight && b.data.length <= maxBytes ? { ...b, width: size.width, height: size.height } : null; };
  const asIs = within(block);
  if (asIs) return asIs;
  const size = sizeOf(raw(block));
  const over = `it is ${size ? `${size.width}x${size.height}` : "of a size its header does not state"} and ${block.data.length} base64 characters, over ${maxWidth}x${maxHeight} and ${maxBytes}`;
  if (!setup.images) return { code: "needs", reason: `${over}, and no image processor is installed to fit it (Photon or sharp)`, model: lead };
  const prepared = await setup.images.prepare(raw(block), block.mimeType, setup.limits.image).catch(() => undefined);
  const fit = prepared && within({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
  return fit || { code: "over_budget", reason: `${over}, and it could not be fitted`, model: lead };
}

/** The receipt facts of blocks shown or looked at: the largest block's pixels and base64 characters, and their count. */
const shownFacts = (unit: readonly Sized[]) => {
  const largest = unit.reduce((a, b) => (b.width * b.height > a.width * a.height || (b.width * b.height === a.width * a.height && b.data.length > a.data.length) ? b : a));
  return { shown: `${largest.width}x${largest.height}`, shown_blocks: unit.length, shown_bytes: largest.data.length };
};

/** One tool result's blocks fitted and routed for the call's lead. Text blocks and a result with no image pass as they
 *  are. A sink or a hook that throws never fails the result; the call's cancellation does. */
export async function guardResult(result: ToolResult, call: CallContext, setup: CallSetup, sizeOf: ImageSize = headerNotBuilt): Promise<ToolResult> {
  if (!result.content.some((block) => block.type === "image")) return result;
  const lead = leadName(call.model);
  const media: MediaDetails = (result.details?.media as MediaDetails | undefined) ?? {};
  const saved = media.path ?? (typeof result.details?.path === "string" ? result.details.path : undefined);
  const window = media.fromS !== undefined || media.toS !== undefined ? { from: media.fromS ?? 0, ...(media.toS !== undefined ? { to: media.toS } : {}) } : undefined;
  const fragment = media.page ? formatFragment({ page: { from: media.page, to: media.page } }) : window ? formatFragment({ t: window }) : "";
  const ask = media.ask?.trim() || undefined;
  // A look's key names the blocks looked at, so two pages of one source are two looks.
  const keyOf = (unit: readonly ImageContent[], model: string) => lookKey({ sha256: blocksSha256(unit), fragment, ask, model });
  const record = (unit: readonly ImageContent[], native: boolean, model: string, body: string, facts: Partial<LookRecord["facts"]> = {}): LookRecord => {
    const sha256 = media.sha256 ?? blocksSha256(unit);
    return {
      tool: "look",
      args: { path: saved ?? "a tool result", ...(ask ? { ask } : {}), ...(media.fromS !== undefined ? { from_s: media.fromS } : {}), ...(media.toS !== undefined ? { to_s: media.toS } : {}), ...(media.page !== undefined ? { page: media.page } : {}), model, native },
      status: "ok",
      facts: { ...(media.original ? { original: media.original } : {}), ...facts, sha256, kind: kindOf(media, unit.some(isVideo)), fragment, ...(media.fit ? { fit: media.fit } : {}), key: keyOf(unit, model) },
      body,
    };
  };
  // A receipt is filed only for media a door named; another tool's image is still routed and its looks and misses still
  // reach the host's hooks, with nothing to cite.
  const filing: Filing = { conversationId: call.conversationId, label: setup.scope.label, evidence: media.path ? setup.evidence : { file: async () => null }, onLook: setup.onLook, onMiss: setup.onMiss };
  const miss = async (what: string, unit: readonly ImageContent[], m: Miss): Promise<TextContent> => {
    const receipt = await reportMiss(filing, "read", record(unit, false, m.model ?? "no vision route", ""), m);
    return { type: "text", text: `(${what} withheld for this model and not described: ${m.reason}.${saved ? ` The file is saved at ${saved}.` : ""}${receipt ? ` Receipt filed at ${receipt}.` : ""} ${MISS_ACTION[m.code]})` };
  };

  const tiles = typeof media.tiles === "number" && media.tiles > 1 ? result.content.filter((b): b is ImageContent => b.type === "image" && !isVideo(b)) : [];
  const content: (TextContent | ImageContent)[] = [];
  let usage = result.usage;
  let shown = 0;
  // Blocks this result already had answered: the same blocks again reuse the answer, asked and paid for once.
  const answered = new Map<string, TextContent>();
  const route = async (unit: readonly Sized[] | readonly [ImageContent], video: boolean) => {
    const what = video ? "video" : unit.length > 1 ? `${unit.length}-tile image` : "image";
    if (video ? setup.limits.video.native : setup.limits.image.native) {
      // A result shows at most the images one call may carry; a unit that would pass it is withheld whole.
      if (shown + unit.length > setup.limits.imagesPerCall) return void content.push(await miss(what, unit, { code: "over_budget", reason: `this result holds more images than the ${setup.limits.imagesPerCall} one call may show`, model: lead }));
      shown += unit.length;
      content.push(...unit);
      const receipt = await fileLook(filing, "read", record(unit, true, lead, "shown to the model natively", video ? {} : shownFacts(unit as Sized[])));
      if (receipt) content.push({ type: "text", text: `(look filed at ${receipt}${ask ? `; your question: ${ask}` : ""})` });
      return;
    }
    const eyes = setup.eyes;
    const unable: Miss | null = !eyes ? { code: "no_vision_route", reason: "no vision route is configured for this run" }
      : !eyes.accepts.image ? { code: "no_vision_route", reason: `the vision route ${eyes.model} does not accept images`, model: eyes.model }
      : video && !eyes.accepts.video ? { code: "video_unseeable", reason: `the vision route ${eyes.model} does not take video; read the file again for frames`, model: eyes.model }
      : null;
    if (unable || !eyes) return void content.push(await miss(what, unit, unable!));
    const key = keyOf(unit, eyes.model);
    const again = answered.get(key);
    if (again) return void content.push(again);
    const at = saved ?? "a tool result";
    const parts: Part[] = unit.map((block) => (video ? { type: "video", data: block.data, mimeType: block.mimeType, fragment: at }
      : { type: "image", data: block.data, mimeType: block.mimeType, width: (block as Sized).width, height: (block as Sized).height, fragment: at }));
    let failed: Miss;
    try {
      // The answer is kept before the result that reports it, so a call run again after a crash does not pay twice.
      const see = () => eyes.see({ parts, ask: ask ?? DESCRIBE_ASK }, call.signal ?? new AbortController().signal);
      const look = call.memo ? await call.memo(`vision:look:${key}`, async () => (await see()) as unknown as Json) as unknown as EyesAnswer : await see();
      usage = addUsage(usage, look.usage);
      if (look.text.trim()) {
        const facts = { ...(video ? {} : shownFacts(unit as Sized[])), tokens_in: look.usage.input + look.usage.cacheRead + look.usage.cacheWrite, tokens_out: look.usage.output, cost_usd: look.costUsd, ...(look.billedBy ? { provider: look.billedBy } : {}) };
        const receipt = await fileLook(filing, "read", record(unit, false, look.model, look.text.trim(), facts), look);
        const head = `(${what} seen for you by ${look.model}${ask ? ` \u2014 your question: ${ask}` : ""}${saved ? `; the file is saved at ${saved}` : ""}${receipt ? `; look filed at ${receipt}` : ""}:)`;
        const answer: TextContent = { type: "text", text: `${head}\n${look.text.trim()}` };
        answered.set(key, answer);
        return void content.push(answer);
      }
      failed = { code: "look_failed", reason: `the vision route ${look.model} returned no text`, model: look.model };
    } catch (error) {
      if (call.signal?.aborted) throw error;
      failed = { code: "look_failed", reason: `the vision route ${eyes.model} failed: ${firstLine(error)}`, model: eyes.model };
    }
    content.push(await miss(what, unit, failed));
  };

  let tilesRouted = false;
  for (const block of result.content) {
    if (block.type !== "image") { content.push(block); continue; }
    if (isVideo(block)) { await route([block], true); continue; }
    if (tiles.includes(block)) {
      // The tiles go as one unit, where the first of them stood; one that cannot be fitted withholds them all.
      if (tilesRouted) continue;
      tilesRouted = true;
      const fits: (Sized | Miss)[] = [];
      for (const tile of tiles) fits.push(await fitted(tile, setup, sizeOf, lead));
      const failure = fits.find((f): f is Miss => "code" in f);
      if (failure) content.push(await miss(`${tiles.length}-tile image`, tiles, failure));
      else await route(fits as Sized[], false);
      continue;
    }
    const fit = await fitted(block, setup, sizeOf, lead);
    if ("code" in fit) content.push(await miss("image", [block], fit));
    else await route([fit], false);
  }
  return { ...result, content, ...(usage ? { usage } : {}) };
}
