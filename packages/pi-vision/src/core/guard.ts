// The guard: every image block a tool returns is fitted to the lead's limits or refused with a typed reason; the
// original never stays in the result when a fit fails. Then each block goes where the lead's route can take it: shown
// natively and filed as a look, or answered by the eyes (the agent's question, or a description) and filed with what
// the eyes cost, or replaced by a miss the model can act on. The blocks of one unit (`details.media.units`: an image's
// tiles, a read's pages, a video's frames) are kept together and looked at together, in requests of at most the images
// the eyes take in one, each filed as one look.

import { formatFragment } from "./fragments.js";
import { blocksSha256, fileLook, fileTold, keptAnswer, lookKey, type Filing, type LookRecord } from "./evidence.js";
import type { CallContext, CallSetup, EyesAnswer, ImageContent, TextContent, ToolResult, Usage } from "./host.js";
import { imageHeader, KINDS, type Kind } from "./kinds.js";
import { RESULT_BYTES_SHARE, type Limits } from "./limits.js";
import { firstLine, linkSafe, MISS_ACTION, reportMiss, type Miss } from "./misses.js";
import type { Fit, Part } from "./plan.js";

/** The question the eyes answer when the agent asked none: say what is shown, completely and only that. */
export const DESCRIBE_ASK =
  "Describe what is shown so a reader who cannot see it knows exactly what it shows. List every visible text, " +
  "label, button, link, price, and form field; every logo, brand mark, badge, icon and seal (name the brand when " +
  "the mark is legible or unmistakable, say 'unidentified' when it is not); banners, overlays, drawers, modals " +
  "and error states; and the layout order from top to bottom. For a video, walk the distinct screens in order " +
  "with their timestamps. Report only what is rendered.";

/** What a door says about the media in its result: the file, the agent's question and window or page, and what it
 *  learned (its hash, its pixels, how it was fitted). `units` gives each image block, in order, the unit it belongs to:
 *  the tiles of one image, the pages of one read, the frames of one video. A block with no unit is a unit of its own. */
export type MediaDetails = {
  readonly kind?: string; readonly path?: string; readonly ask?: string; readonly fromS?: number; readonly toS?: number; readonly page?: number;
  readonly units?: readonly number[]; readonly sha256?: string; readonly original?: string; readonly fit?: Fit;
  /** The files a door kept of what it shows (a rendered page), for the receipt. */
  readonly derived?: readonly string[];
};

/** The pixels an image's header states, without decoding it (`imageHeader`, kinds.ts). */
export type ImageSize = (bytes: Uint8Array) => { readonly width: number; readonly height: number } | null;

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

/** The block within `limits`, the image limits of the model that will see it: as it is when its header says so, else
 *  what the processor makes of it; the miss, never the original, when nothing fits. */
async function fitted(block: ImageContent, limits: Limits["image"], setup: CallSetup, sizeOf: ImageSize, model: string): Promise<Sized | Miss> {
  const { maxWidth, maxHeight, maxBytes } = limits;
  const within = (b: ImageContent) => { const size = sizeOf(raw(b)); return size && size.width <= maxWidth && size.height <= maxHeight && b.data.length <= maxBytes ? { ...b, width: size.width, height: size.height } : null; };
  const asIs = within(block);
  if (asIs) return asIs;
  const size = sizeOf(raw(block));
  const over = `it is ${size ? `${size.width}x${size.height}` : "of a size its header does not state"} and ${block.data.length} base64 characters, over ${maxWidth}x${maxHeight} and ${maxBytes}`;
  if (!setup.images) return { code: "needs", reason: `${over}, and no image processor is installed to fit it (Photon or sharp)`, model };
  const prepared = await setup.images.prepare(raw(block), block.mimeType, limits).catch(() => undefined);
  const fit = prepared && within({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
  return fit || { code: "over_budget", reason: `${over}, and it could not be fitted`, model };
}

/** Edges tried, as a share of a block's own, when it must be re-encoded smaller to fit a result's share of the request:
 *  its own edges first (a lower JPEG quality), then smaller. */
const SHARE_REFIT_SCALES = [1, 0.75, 0.5] as const;
/** The most of a caption the eyes are told beside an image: its first line, which names the page or the time. */
const CAPTION_CHARS = 300;
const charsOf = (unit: readonly ImageContent[]) => unit.reduce((sum, b) => sum + b.data.length, 0);

/** The block re-encoded by the processor inside `box` (edges and base64 characters): at the box's edges first, then
 *  smaller ones. Null when nothing fits. */
async function refit(block: Sized, box: { readonly maxWidth: number; readonly maxHeight: number; readonly maxBytes: number }, setup: CallSetup, sizeOf: ImageSize): Promise<Sized | null> {
  for (const scale of SHARE_REFIT_SCALES) {
    const limits = { ...setup.limits.image, maxWidth: Math.floor(Math.min(block.width, box.maxWidth) * scale), maxHeight: Math.floor(Math.min(block.height, box.maxHeight) * scale), maxBytes: box.maxBytes };
    const prepared = await setup.images?.prepare(raw(block), block.mimeType, limits).catch(() => undefined);
    const size = prepared && sizeOf(Buffer.from(prepared.data, "base64"));
    if (prepared && size && prepared.data.length <= limits.maxBytes && size.width <= limits.maxWidth && size.height <= limits.maxHeight) return { type: "image", data: prepared.data, mimeType: prepared.mimeType, width: size.width, height: size.height };
  }
  return null;
}

/** The unit within `room` base64 characters, each block held to an equal share of it: as it is when it already is, else
 *  re-encoded smaller. Null when nothing fits. */
async function withinRoom(unit: readonly Sized[], room: number, setup: CallSetup, sizeOf: ImageSize): Promise<Sized[] | null> {
  if (charsOf(unit) <= room) return [...unit];
  const each = Math.floor(room / unit.length);
  const out: Sized[] = [];
  for (const block of unit) {
    const fit = block.data.length <= each ? block : await refit(block, { maxWidth: block.width, maxHeight: block.height, maxBytes: each }, setup, sizeOf);
    if (!fit) return null;
    out.push(fit);
  }
  return out;
}

/** The receipt facts of blocks shown or looked at: the largest block's pixels and base64 characters, and their count. */
const shownFacts = (unit: readonly Sized[]) => {
  const largest = unit.reduce((a, b) => (b.width * b.height > a.width * a.height || (b.width * b.height === a.width * a.height && b.data.length > a.data.length) ? b : a));
  return { shown: `${largest.width}x${largest.height}`, shown_blocks: unit.length, shown_bytes: largest.data.length };
};

/** One tool result's blocks fitted and routed for the call's lead. Text blocks and a result with no image pass as they
 *  are. A sink or a hook that throws never fails the result; the call's cancellation does. */
export async function guardResult(result: ToolResult, call: CallContext, setup: CallSetup, sizeOf: ImageSize = imageHeader): Promise<ToolResult> {
  if (!result.content.some((block) => block.type === "image")) return result;
  const lead = leadName(call.model);
  const media: MediaDetails = (result.details?.media as MediaDetails | undefined) ?? {};
  const saved = media.path ?? (typeof result.details?.path === "string" ? result.details.path : undefined);
  const tool = call.tool ?? "read";
  const source = saved ?? (call.tool ? `a ${call.tool} result` : "a tool result");
  const window = media.fromS !== undefined || media.toS !== undefined ? { from: media.fromS ?? 0, ...(media.toS !== undefined ? { to: media.toS } : {}) } : undefined;
  const fragment = media.page ? formatFragment({ page: { from: media.page, to: media.page } }) : window ? formatFragment({ t: window }) : "";
  const ask = media.ask?.trim() || undefined;
  // Unit ids name image blocks by their order, so ids that do not match the blocks (a wrap or hook added or dropped one)
  // are not trusted: every block is its own look, and each look's receipt says why.
  // Image blocks are named by where they stand, so one image object repeated in a result is two blocks.
  const at = (i: number) => result.content[i] as ImageContent;
  const stillAt = result.content.flatMap((b, i) => (b.type === "image" && !isVideo(b) ? [i] : []));
  const stills = stillAt.map(at);
  const units = media.units && media.units.length === stills.length ? media.units : undefined;
  const dropped = media.units && !units ? { units_dropped: `${media.units.length} unit ids for ${stills.length} image blocks; each block was looked at on its own` } : {};
  const whatOf = (n: number, video: boolean) => (video ? "video" : n < 2 ? "image" : media.kind === "video" ? `${n} frames` : media.kind === "pdf" ? `${n} page images` : `${n}-tile image`);
  // A look's key names the blocks looked at, so two pages of one source are two looks.
  const keyOf = (unit: readonly ImageContent[], model: string) => lookKey({ sha256: blocksSha256(unit), fragment, ask, model });
  const record = (unit: readonly ImageContent[], native: boolean, model: string, body: string, facts: Partial<LookRecord["facts"]> = {}): LookRecord => {
    const sha256 = media.sha256 ?? blocksSha256(unit);
    return {
      tool: "look",
      args: { path: source, ...(ask ? { ask } : {}), ...(media.fromS !== undefined ? { from_s: media.fromS } : {}), ...(media.toS !== undefined ? { to_s: media.toS } : {}), ...(media.page !== undefined ? { page: media.page } : {}), model, native },
      status: "ok",
      facts: { ...(media.original ? { original: media.original } : {}), ...facts, ...dropped, sha256, kind: kindOf(media, unit.some(isVideo)), fragment, ...(media.fit ? { fit: media.fit } : {}), key: keyOf(unit, model), ...(media.derived?.length ? { derived: media.derived } : {}) },
      body,
    };
  };
  // A receipt is filed only for media a door named; another tool's image is still routed and its looks and misses still
  // reach the host's hooks, with nothing to cite.
  const filing: Filing = { conversationId: call.conversationId, label: setup.scope.label, evidence: media.path ? setup.evidence : { file: async () => null }, onLook: setup.onLook, onMiss: setup.onMiss };
  const miss = async (what: string, unit: readonly ImageContent[], cause: Miss): Promise<TextContent> => {
    const m = { ...cause, reason: linkSafe(cause.reason) };
    const receipt = await reportMiss(filing, tool, record(unit, false, m.model ?? "no vision route", ""), m);
    return { type: "text", text: `(${what} withheld for this model and not described: ${m.reason}.${saved ? ` The file is saved at ${saved}.` : ""}${receipt ? ` Receipt filed at ${receipt}.` : ""} ${MISS_ACTION[m.code]})` };
  };

  type Item = TextContent | ImageContent;
  // What stands where each image block stood: its fitted self, a look's answer, a miss, or nothing.
  const placed = new Map<number, Item[]>();
  const standIn = (where: readonly number[], items: Item[]) => where.forEach((pos, i) => placed.set(pos, i ? [] : items));
  /** The first line of the text just before a block: its page or time, which the eyes are told with it. */
  const captionOf = (pos: number) => { const before = result.content[pos - 1]; return before?.type === "text" ? before.text.split("\n")[0]!.slice(0, CAPTION_CHARS) : undefined; };
  let usage = result.usage;
  let shown = 0;
  // A result's images in all are held to its share of the request, whatever each is within its own limit.
  let room = Math.floor(setup.limits.requestBytes * RESULT_BYTES_SHARE);
  // Blocks this result already had answered: the same blocks again reuse the answer, asked and paid for once.
  const answered = new Map<string, TextContent>();
  const route = async (where: readonly number[], unit: readonly Sized[] | readonly [ImageContent], video: boolean) => {
    const orig = where.map(at);
    const what = whatOf(unit.length, video);
    if (video ? setup.limits.video.native : setup.limits.image.native) {
      // A result shows at most the images one call may carry; a unit that would pass it is withheld whole.
      if (shown + unit.length > setup.limits.imagesPerCall) return standIn(where, [await miss(what, orig, { code: "over_budget", reason: `this result holds more images than the ${setup.limits.imagesPerCall} one call may show`, model: lead })]);
      const shownUnit = video ? unit : await withinRoom(unit as Sized[], room, setup, sizeOf);
      // A unit that cannot fit what is left of the share is never sent as it is: the eyes look in its place, or it is withheld.
      if (!shownUnit && !setup.eyes?.accepts.image) return standIn(where, [await miss(what, orig, { code: "over_budget", reason: `its images come to ${charsOf(unit)} base64 characters, over the ${room} left of the ${Math.floor(setup.limits.requestBytes * RESULT_BYTES_SHARE)} one result carries, and they could not be made smaller`, model: lead })]);
      if (shownUnit) {
        // Shown, each block stays where it stood, beside its own caption; the look's line follows the last.
        if (!video) room -= charsOf(shownUnit);
        shown += shownUnit.length;
        const receipt = await fileLook(filing, tool, record(shownUnit, true, lead, "shown to the model natively", video ? {} : shownFacts(shownUnit as Sized[])));
        const line: Item[] = receipt ? [{ type: "text", text: `(look filed at ${receipt}${ask ? `; your question: ${ask}` : ""})` }] : [];
        return where.forEach((pos, i) => placed.set(pos, [shownUnit[i]!, ...(i === where.length - 1 ? line : [])]));
      }
    }
    standIn(where, await viaEyes(where, unit, video, what));
  };
  const viaEyes = async (where: readonly number[], unit: readonly Sized[] | readonly ImageContent[], video: boolean, what: string): Promise<Item[]> => {
    const orig = where.map(at);
    const eyes = setup.eyes;
    const unable: Miss | null = !eyes ? { code: "no_vision_route", reason: "no vision route is configured for this run" }
      : !eyes.accepts.image ? { code: "no_vision_route", reason: `the vision route ${eyes.model} does not accept images`, model: eyes.model }
      : video && !eyes.accepts.video ? { code: "video_unseeable", reason: `the vision route ${eyes.model} does not take video; read the file again for frames`, model: eyes.model }
      : null;
    if (unable || !eyes) return [await miss(what, orig, unable!)];
    // Each image is held to the eyes' own image limits and what one request to them carries: re-encoded inside them when
    // it is over, else the unit is withheld.
    const most = Math.max(1, Math.floor(eyes.limits.imagesPerCall));
    const box = { maxWidth: eyes.limits.image.maxWidth, maxHeight: eyes.limits.image.maxHeight, maxBytes: Math.min(eyes.limits.image.maxBytes, eyes.limits.requestBytes) };
    const sized: { block: ImageContent; caption?: string }[] = [];
    for (const [i, block] of unit.entries()) {
      const b = block as Sized;
      const fit = video || (b.data.length <= box.maxBytes && b.width <= box.maxWidth && b.height <= box.maxHeight) ? block : await refit(b, box, setup, sizeOf);
      if (!fit) return [await miss(what, orig, { code: "over_budget", reason: `an image of it is ${b.width}x${b.height} and ${b.data.length} base64 characters, over the ${box.maxWidth}x${box.maxHeight} and ${box.maxBytes} one request to the vision route ${eyes.model} carries, and it could not be made smaller`, model: eyes.model })];
      sized.push({ block: fit, caption: captionOf(where[i]!) });
    }
    // A unit goes to the eyes in requests of at most the images, and the bytes, one request takes, each its own look.
    const requests: { block: ImageContent; caption?: string }[][] = [];
    for (const item of sized) {
      const open = requests.at(-1);
      if (open && open.length < most && charsOf(open.map((o) => o.block)) + item.block.data.length <= eyes.limits.requestBytes) open.push(item);
      else requests.push([item]);
    }
    const out: Item[] = [];
    for (const [index, request] of requests.entries()) out.push(await ask1(request, video, `${what}${requests.length > 1 ? ` (part ${index + 1} of ${requests.length})` : ""}`, eyes));
    return out;
  };
  const ask1 = async (items: readonly { block: ImageContent; caption?: string }[], video: boolean, what: string, eyes: NonNullable<CallSetup["eyes"]>): Promise<TextContent> => {
    const unit = items.map((item) => item.block);
    const key = keyOf(unit, eyes.model);
    const again = answered.get(key);
    if (again) return again;
    // Each image goes with the line that says where it is (a page, a time), so the eyes can say where they saw a thing.
    const parts: Part[] = items.flatMap(({ block, caption }): Part[] => [
      ...(caption ? [{ type: "text" as const, text: caption, fragment: source }] : []),
      video ? { type: "video", data: block.data, mimeType: block.mimeType, fragment: source }
        : { type: "image", data: block.data, mimeType: block.mimeType, width: (block as Sized).width, height: (block as Sized).height, fragment: source },
    ]);
    let failed: Miss;
    try {
      const { answer: look, readBack } = await keptAnswer<EyesAnswer>(call.memo, key, () => eyes.see({ parts, ask: ask ?? DESCRIBE_ASK }, call.signal ?? new AbortController().signal));
      // pi counts a result's usage only when it commits the result, and a kept answer's result never committed.
      usage = addUsage(usage, look.usage);
      if (look.text.trim()) {
        const facts = { ...(video ? {} : shownFacts(unit as Sized[])), tokens_in: look.usage.input + look.usage.cacheRead + look.usage.cacheWrite, tokens_out: look.usage.output, cost_usd: look.costUsd, ...(look.billedBy ? { provider: look.billedBy } : {}), ...(readBack ? { kept: true as const } : {}) };
        const receipt = await fileTold(call.memo, key, filing, (to, told) => fileLook(to, tool, record(unit, false, look.model, look.text.trim(), facts), told ? { ...look, kept: true } : look));
        const head = `(${what} seen for you by ${look.model}${ask ? ` \u2014 your question: ${ask}` : ""}${saved ? `; the file is saved at ${saved}` : ""}${receipt ? `; look filed at ${receipt}` : ""}:)`;
        const answer: TextContent = { type: "text", text: `${head}\n${look.text.trim()}` };
        answered.set(key, answer);
        return answer;
      }
      failed = { code: "look_failed", reason: `the vision route ${look.model} returned no text`, model: look.model };
    } catch (error) {
      if (call.signal?.aborted) throw error;
      failed = { code: "look_failed", reason: `the vision route ${eyes.model} failed: ${firstLine(error)}`, model: eyes.model };
    }
    return miss(what, unit, failed);
  };

  // A block is fitted to the limits of the model that will see it: the lead's when the lead takes images, else the
  // eyes'. The lead's limits never withhold a block only the eyes will look at. With neither, it goes on unfitted to
  // be withheld for having no one to look.
  const seer = setup.limits.image.native ? { limits: setup.limits.image, model: lead }
    : setup.eyes?.accepts.image ? { limits: setup.eyes.limits.image, model: setup.eyes.model } : undefined;
  // One block that cannot be fitted withholds its unit whole.
  const unitOf = (pos: number) => units?.[stillAt.indexOf(pos)] ?? `own ${pos}`;
  const routed = new Set<number | string>();
  for (const [pos, block] of result.content.entries()) {
    if (block.type !== "image") continue;
    if (isVideo(block)) { await route([pos], [block], true); continue; }
    const id = unitOf(pos);
    if (routed.has(id)) continue;
    routed.add(id);
    const where = stillAt.filter((p) => unitOf(p) === id);
    const fits: (Sized | Miss)[] = [];
    for (const p of where) fits.push(seer ? await fitted(at(p), seer.limits, setup, sizeOf, seer.model) : { ...at(p), width: 0, height: 0, ...sizeOf(raw(at(p))) });
    const failure = fits.find((f): f is Miss => "code" in f);
    if (failure) standIn(where, [await miss(whatOf(where.length, false), where.map(at), failure)]);
    else await route(where, fits as Sized[], false);
  }
  const content = result.content.flatMap((block, pos): Item[] => (block.type === "image" ? placed.get(pos) ?? [] : [block]));
  return { ...result, content, ...(usage ? { usage } : {}) };
}
