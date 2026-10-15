// The planner: one function from a source's facts, the selector the caller asked for, the route's limits and a mode
// (`show` for the lead, `ask` for the eyes) to the parts to send, each with the fragment of the source it covers, and
// what was reduced to fit, with the numbers. No plan exceeds the limits it was given; what cannot fit even at the floor
// is a refusal, never an illegible success.

import type { MissCode } from "./contract.js";
import type { Fragment, PageSpan, Region } from "./fragments.js";
import type { Kind } from "./kinds.js";
import {
  DECODE_GUARD_PIXELS, FLOOR_EDGE, LOOK_FRAMES_PER_REQUEST, LOOK_FRAME_SPACING_S, LOOK_PAGES_PER_REQUEST, LOOK_TOKENS_PER_PART,
  PDF_MAX_DPI, POINTS_PER_INCH, RESULT_BYTES_SHARE, TILE_ASPECT, TILE_KEEP_BELOW, TILE_MAX_EDGE, TILE_OVERLAP, VIDEO_FRAMES_PER_READ,
} from "./limits.js";
import type { Limits } from "./limits.js";

/** What is known of a source for free: no render, no decode beyond a header. */
export type SourceFacts = {
  readonly kind: Kind;
  readonly bytes: number;
  readonly sha256: string;
  readonly mimeType?: string;
  /** Pixels of an image, upright; the frame size of a video. */
  readonly width?: number;
  readonly height?: number;
  /** A document's pages, their sizes in points as displayed, and which carry a text layer (1-based). */
  readonly pages?: number;
  readonly pageSizes?: readonly { readonly width: number; readonly height: number }[];
  readonly textPages?: readonly number[];
  readonly durationS?: number;
};

/** What the caller asked for: pages, a window, a region. `render` shows a document's pages as images even when they
 *  carry text (a `read` with a question); a plan for the eyes always renders. */
export type Selector = { readonly pages?: PageSpan; readonly fromS?: number; readonly toS?: number; readonly region?: Region; readonly render?: boolean };

export type PlanMode = "show" | "ask";

/** A host's own caps on one plan for the eyes (`ask`): the pages, and the frames or clips, it may take. None by default. */
export type PlanCaps = { readonly pages?: number; readonly frames?: number };

export type Reduction = "as_is" | "downscaled" | "tiled" | "sampled" | "windowed" | "text_only" | "refused";

/** What a plan did to fit, with the numbers a receipt and the model's first line carry. */
export type Fit = {
  readonly reduction: Reduction;
  readonly original?: { readonly width?: number; readonly height?: number; readonly pages?: number; readonly durationS?: number; readonly bytes?: number };
  readonly shown?: { readonly width?: number; readonly height?: number; readonly pages?: number; readonly frames?: number; readonly tiles?: number; readonly dpi?: number; readonly bytes?: number };
  /** Set when `reduction` is `refused`. */
  readonly refusal?: { readonly code: MissCode; readonly detail: string };
};

type Size = { readonly width: number; readonly height: number };
type Rect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

/** One part to derive and send: which piece of the source it is and the target it is derived to. An empty fragment is
 *  the whole source. `as_is` sends the source's own bytes (an image in a format the route does not take is converted
 *  at the same size). A part whose fragment names a page is rendered from that page. */
export type PlannedPart = {
  readonly fragment: Fragment;
  readonly derive: "as_is" | "image" | "tile" | "page" | "frame" | "clip" | "text";
  /** The part's own pixels: `crop`'s size, or `raster`'s when nothing is cut. */
  readonly width?: number;
  readonly height?: number;
  readonly dpi?: number;
  readonly atS?: number;
  /** The whole image, page (at `dpi`) or frame scaled to this size, before `crop` is cut from it. A page renders only `crop`. */
  readonly raster?: Size;
  /** The rectangle of `raster` this part is: a tile, a region, or a tile of a region. Absent: the whole raster. */
  readonly crop?: Rect;
  /** Base64 bytes the derived part must fit in: its share of the result's budget (`show`) or of its request's (`ask`). */
  readonly maxBytes?: number;
};

export type Plan = { readonly parts: readonly PlannedPart[]; readonly fit: Fit };

/** A derived part, ready for a model. `data` is base64. `fragment` is the citation form of where it came from. */
export type Part =
  | { readonly type: "text"; readonly text: string; readonly fragment?: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string; readonly width: number; readonly height: number; readonly fragment: string }
  | { readonly type: "video"; readonly data: string; readonly mimeType: string; readonly fragment: string };

/** A look's price before its first request, and its refusal when that is over the host's cap. */
export type LookEstimate = { readonly parts: number; readonly requests: number; readonly tokens: number; readonly usd: number | null; readonly refusal?: Fit["refusal"] };

type Original = NonNullable<Fit["original"]>;
type Shown = NonNullable<Fit["shown"]>;
/** A rectangle in fractions of the whole: left, top, right, bottom. */
type Box = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
type Cut = { readonly crop: Rect; readonly raster: Size; readonly dpi?: number };
type Layout = { readonly cuts: readonly Cut[]; readonly shrunk: boolean };

const WHOLE: Box = Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1 });
const IMAGE_DERIVES: ReadonlySet<PlannedPart["derive"]> = new Set(["image", "tile", "page", "frame"]);
const PRECEDENCE: readonly Reduction[] = ["windowed", "sampled", "tiled", "downscaled"];
const grouped = (n: number): string => n.toLocaleString("en-US");
const base64 = (raw: number): number => Math.ceil(raw / 3) * 4;
/** Seconds are planned to the millisecond, the resolution of a fragment. */
const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;
const reduced = (applies: Partial<Record<Reduction, boolean>>): Reduction => PRECEDENCE.find((r) => applies[r]) ?? "as_is";
const perCall = (limits: Limits, mode: PlanMode): number => Math.floor(mode === "show" ? limits.imagesPerCall : Math.min(limits.imagesPerCall, LOOK_PAGES_PER_REQUEST));

function refuse(code: MissCode, detail: string, original?: Original): Plan {
  return { parts: [], fit: { reduction: "refused", ...(original ? { original } : {}), refusal: { code, detail } } };
}

/** A region in percent as a box, or null when it is not a region of the whole. */
function boxOf(region: Region | undefined): Box | null {
  if (!region) return WHOLE;
  const { x, y, w, h } = region;
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || !(w > 0) || !(h > 0) || x + w > 100 || y + h > 100) return null;
  return { x0: x / 100, y0: y / 100, x1: (x + w) / 100, y1: (y + h) / 100 };
}

/** A cut in percent of its raster, in whole thousandths so the fragment it becomes always reads back. */
function regionOf(crop: Rect, raster: Size): Region {
  const lo = (v: number, of: number) => Math.floor((v * 100_000) / of);
  const hi = (v: number, of: number) => Math.min(100_000, Math.ceil((v * 100_000) / of));
  const x = lo(crop.left, raster.width), y = lo(crop.top, raster.height);
  return { x: x / 1000, y: y / 1000, w: (hi(crop.left + crop.width, raster.width) - x) / 1000, h: (hi(crop.top + crop.height, raster.height) - y) / 1000 };
}

/** A picture of `natural` pixels, or the `box` of it, fitted to the image limits as one part; or cut into tiles in
 *  reading order when it is over TILE_ASPECT times as long as it is wide and a fit would keep under TILE_KEEP_BELOW
 *  of it, the whole scaled so at most `maxParts` tiles cover it. `render` gives the whole raster at a scale (a page
 *  renders at whole dpi), or null when nothing can be rendered. A shrunk part is never under the floor: the string
 *  says why it cannot be shown. */
function layout(natural: Size, box: Box, limits: Limits, maxParts: number, render: (scale: number) => { raster: Size; dpi?: number } | null): Layout | string {
  const { maxWidth, maxHeight } = limits.image;
  const w = natural.width * (box.x1 - box.x0), h = natural.height * (box.y1 - box.y0);
  const long = Math.max(w, h), short = Math.min(w, h), vertical = h >= w;
  let scale = Math.min(1, maxWidth / w, maxHeight / h);
  let cap: Size = { width: maxWidth, height: maxHeight };
  let tile = 0;
  if (maxParts > 1 && long > TILE_ASPECT * short && scale < TILE_KEEP_BELOW) {
    const along = Math.min(TILE_MAX_EDGE, vertical ? maxHeight : maxWidth), across = vertical ? maxWidth : maxHeight;
    const cover = along + (maxParts - 1) * (along - TILE_OVERLAP);
    const tiled = Math.min(1, cover / long, across / short);
    if (along > TILE_OVERLAP && long * tiled > along) {
      [scale, tile, cap] = [tiled, along, vertical ? { width: across, height: cover } : { width: cover, height: across }];
    }
  }
  const rendered = render(scale);
  if (!rendered) return `it is too large to render at any size within ${maxWidth}x${maxHeight} px`;
  const { raster, dpi } = rendered;
  const left = Math.floor(box.x0 * raster.width), top = Math.floor(box.y0 * raster.height);
  const width = Math.min(cap.width, Math.ceil(box.x1 * raster.width) - left), height = Math.min(cap.height, Math.ceil(box.y1 * raster.height) - top);
  const span = vertical ? height : width;
  const crops: Rect[] = [];
  if (tile && span > tile) {
    const step = tile - TILE_OVERLAP;
    for (let index = 0, count = Math.ceil((span - tile) / step) + 1; index < count; index++) {
      // The last tile ends at the edge, so every tile has the full length and none is a sliver.
      const at = Math.min(index * step, span - tile);
      crops.push(vertical ? { left, top: top + at, width, height: tile } : { left: left + at, top, width: tile, height });
    }
  } else crops.push({ left, top, width, height });
  const under = crops.find((c) => Math.max(c.width, c.height) < FLOOR_EDGE);
  if (scale < 1 && under) {
    return `${Math.round(w)}x${Math.round(h)} px would be shown at ${under.width}x${under.height}, under the ${grouped(FLOOR_EDGE)} px floor of the long edge within ${maxWidth}x${maxHeight} px`;
  }
  return { cuts: crops.map((crop) => ({ crop, raster, ...(dpi === undefined ? {} : { dpi }) })), shrunk: scale < 1 };
}

const imageRender = (natural: Size) => (scale: number) => ({ raster: { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) } });

/** A page of `points`, or the box of it, rendered at `min(PDF_MAX_DPI, the dpi that fits the limits)`. A region is
 *  given the pixels the whole page would have, so a closer look sees more of it. */
function layoutPage(points: Size, box: Box, limits: Limits, maxParts: number): Layout | string {
  const dpiAtOne = PDF_MAX_DPI / Math.sqrt((box.x1 - box.x0) * (box.y1 - box.y0));
  const natural = { width: (points.width * dpiAtOne) / POINTS_PER_INCH, height: (points.height * dpiAtOne) / POINTS_PER_INCH };
  return layout(natural, box, limits, maxParts, (scale) => {
    const dpi = Math.floor(dpiAtOne * scale);
    if (dpi < 1) return null;
    return { dpi, raster: { width: Math.max(1, Math.round((points.width * dpi) / POINTS_PER_INCH)), height: Math.max(1, Math.round((points.height * dpi) / POINTS_PER_INCH)) } };
  });
}

/** The parts of one laid-out picture, each with the fragment it covers within `base`. */
function cutParts(laid: Layout, base: Fragment, derive: PlannedPart["derive"], whole: boolean, extra: Partial<PlannedPart> = {}): PlannedPart[] {
  return laid.cuts.map(({ crop, raster, dpi }) => {
    const full = crop.left === 0 && crop.top === 0 && crop.width === raster.width && crop.height === raster.height;
    return {
      fragment: full && whole ? base : { ...base, xywh: regionOf(crop, raster) },
      derive: laid.cuts.length > 1 ? "tile" : derive,
      width: crop.width, height: crop.height, raster, ...(full ? {} : { crop }), ...(dpi === undefined ? {} : { dpi }), ...extra,
    };
  });
}

/** Parts grouped one eyes request each, in order: a picture's tiles and a page's tiles stay together; at most
 *  LOOK_PAGES_PER_REQUEST images or LOOK_FRAMES_PER_REQUEST frames, never over the route's `imagesPerCall`, or one
 *  clip or file in a request. */
function pack(parts: readonly PlannedPart[], limits: Limits): PlannedPart[][] {
  const units: { key: string; parts: PlannedPart[] }[] = [];
  parts.forEach((part, index) => {
    const key = part.derive === "page" || part.derive === "tile" || part.derive === "image" ? `page ${part.fragment.page?.from ?? 0}` : `part ${index}`;
    if (units.at(-1)?.key === key) units.at(-1)!.parts.push(part);
    else units.push({ key, parts: [part] });
  });
  const images = Math.floor(limits.imagesPerCall);
  const capOf = (part: PlannedPart) => (part.derive === "clip" || part.derive === "as_is" ? 1 : Math.min(images, part.derive === "frame" ? LOOK_FRAMES_PER_REQUEST : LOOK_PAGES_PER_REQUEST));
  const requests: PlannedPart[][] = [];
  for (const unit of units) {
    const open = requests.at(-1);
    if (open && open.length + unit.parts.length <= capOf(unit.parts[0])) open.push(...unit.parts);
    else requests.push([...unit.parts]);
  }
  return requests;
}

/** Each image part's byte budget: an equal share of the result's (a quarter of the request) in `show`, of its own
 *  request's in `ask`, never over one image's limit. A string when a part's share is no byte at all. */
function withBytes(parts: readonly PlannedPart[], limits: Limits, mode: PlanMode): PlannedPart[] | string {
  const budget = mode === "show" ? Math.floor(limits.requestBytes * RESULT_BYTES_SHARE) : limits.requestBytes;
  const sized = (mode === "show" ? [[...parts]] : pack(parts, limits)).flatMap((group) => {
    const images = group.filter((part) => IMAGE_DERIVES.has(part.derive)).length;
    return group.map((part) => (IMAGE_DERIVES.has(part.derive) ? { ...part, maxBytes: Math.min(limits.image.maxBytes, Math.floor(budget / images)) } : part));
  });
  const empty = sized.some((part) => part.maxBytes !== undefined && part.maxBytes < 1);
  return empty ? `a request budget of ${grouped(limits.requestBytes)} bytes leaves no bytes for ${parts.length === 1 ? "an image" : `${parts.length} images`}` : sized;
}

function planImage(facts: SourceFacts, selector: Selector, limits: Limits, mode: PlanMode): Plan {
  const { width = 0, height = 0 } = facts;
  const original = { width: facts.width, height: facts.height, bytes: facts.bytes };
  if (!(width > 0 && height > 0)) return refuse("unreadable", "the image's size is not in its header", original);
  if (width * height > DECODE_GUARD_PIXELS) return refuse("over_budget", `${width}x${height} is ${grouped(width * height)} pixels, over the ${grouped(DECODE_GUARD_PIXELS)} decoded`, original);
  const box = boxOf(selector.region);
  if (!box) return refuse("refused", `the region ${JSON.stringify(selector.region)} is not within the image`, original);
  const maxParts = perCall(limits, mode);
  if (maxParts < 1) return refuse("over_budget", "the route takes no image in a result", original);
  const laid = layout({ width, height }, box, limits, maxParts, imageRender({ width, height }));
  if (typeof laid === "string") return refuse("over_budget", laid, original);
  const parts = withBytes(cutParts(laid, {}, "image", box === WHOLE), limits, mode);
  if (typeof parts === "string") return refuse("over_budget", parts, original);
  const fitsBytes = base64(facts.bytes) <= (parts[0].maxBytes ?? 0);
  const asIs = box === WHOLE && parts.length === 1 && !laid.shrunk && fitsBytes;
  const first = laid.cuts[0];
  const shown: Shown = parts.length > 1 ? { width: first.raster.width, height: first.raster.height, tiles: parts.length } : { width: first.crop.width, height: first.crop.height };
  const reduction = reduced({ tiled: parts.length > 1, downscaled: laid.shrunk || (box === WHOLE && !fitsBytes) });
  return { parts: asIs ? [{ ...parts[0], derive: "as_is" }] : parts, fit: { reduction, original, shown } };
}

function planPages(facts: SourceFacts, selector: Selector, limits: Limits, mode: PlanMode, caps: PlanCaps): Plan {
  const pages = facts.pages ?? facts.pageSizes?.length ?? 0;
  const original = { pages, bytes: facts.bytes };
  if (!(pages > 0)) return refuse("unreadable", "its page count is not known", original);
  const from = selector.pages?.from ?? 1, to = Math.min(selector.pages?.to ?? pages, pages);
  if (Number.isInteger(from) && from > pages) return refuse("refused", `page ${from} is past the last page, ${pages}`, original);
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from)) return refuse("refused", `pages ${from}-${to} are not pages of a ${pages} page document`, original);
  if (mode === "show" && !selector.render) {
    const withText = new Set((facts.textPages ?? []).filter((page) => page >= from && page <= to)).size;
    if (withText > 0) return { parts: [{ fragment: { page: { from, to } }, derive: "text" }], fit: { reduction: "text_only", original, shown: { pages: withText } } };
  }
  const count = to - from + 1;
  if (mode === "ask" && caps.pages !== undefined && count > caps.pages) return refuse("over_budget", `pages ${from}-${to} are ${count} pages, over the ${caps.pages} one look takes; ask about fewer pages`, original);
  const box = boxOf(selector.region);
  if (!box) return refuse("refused", `the region ${JSON.stringify(selector.region)} is not within the page`, original);
  const maxParts = perCall(limits, mode);
  const parts: PlannedPart[] = [];
  let shownPages = 0, shrunk = false, dpi = Infinity;
  for (let page = from; page <= to && (mode === "ask" || shownPages < limits.pagesPerRead); page++) {
    const points = facts.pageSizes?.[page - 1];
    if (!(points && points.width > 0 && points.height > 0)) return refuse("unreadable", `the size of page ${page} is not known`, original);
    const laid = layoutPage(points, box, limits, maxParts);
    if (typeof laid === "string") return refuse("over_budget", `page ${page}: ${laid}`, original);
    if (parts.length + laid.cuts.length > (mode === "show" ? maxParts : Infinity)) break;
    parts.push(...cutParts(laid, { page: { from: page, to: page } }, "page", box === WHOLE));
    shownPages++;
    shrunk ||= laid.shrunk;
    dpi = Math.min(dpi, laid.cuts[0].dpi ?? Infinity);
  }
  if (!shownPages) return refuse("over_budget", `page ${from} does not fit in the ${maxParts} images one result takes`, original);
  const reduction = reduced({ windowed: shownPages < count, tiled: parts.length > shownPages, downscaled: shrunk });
  const shown: Shown = { pages: shownPages, dpi, ...(parts.length > shownPages ? { tiles: parts.length } : {}) };
  const sized = withBytes(parts, limits, mode);
  if (typeof sized === "string") return refuse("over_budget", sized, original);
  return { parts: sized, fit: { reduction, original, shown } };
}

function planVideo(facts: SourceFacts, selector: Selector, limits: Limits, mode: PlanMode, caps: PlanCaps): Plan {
  const duration = facts.durationS;
  const original = { durationS: duration, width: facts.width, height: facts.height, bytes: facts.bytes };
  // Raw video bytes whose base64 fits the request too; a region is a crop, which frames can show and a clip cannot.
  const inline = Math.min(limits.video.inlineBytes, Math.floor(limits.requestBytes / 4) * 3);
  const native = limits.video.native && inline >= 1 && !selector.region;
  const windowed = selector.fromS !== undefined || selector.toS !== undefined;
  if (native && !windowed && facts.bytes <= inline) {
    return { parts: [{ fragment: {}, derive: "as_is", maxBytes: base64(inline) }], fit: { reduction: "as_is", original, shown: { bytes: facts.bytes } } };
  }
  if (!(duration !== undefined && duration > 0)) return refuse("unreadable", "its duration is not known, so no window or frame can be chosen", original);
  const from = ms(selector.fromS ?? 0), to = ms(Math.min(selector.toS ?? duration, duration)), span = to - from;
  if (!(from >= 0 && from < duration && to > from)) return refuse("refused", `the window ${from}..${to} s is not within the video's ${ms(duration)} s`, original);
  if (native && (windowed || mode === "ask")) {
    // Each window is sized so its stream copy fits the inline budget; one that does not is re-encoded when derived.
    const windows = mode === "show" ? 1 : Math.min(Math.round(span * 1000), Math.max(1, Math.ceil((facts.bytes * span) / duration / inline)));
    if (caps.frames !== undefined && windows > caps.frames) return refuse("over_budget", `${from}..${to} s is ${windows} clips of ${grouped(inline)} bytes, over the ${caps.frames} video parts one look takes; ask about a shorter window`, original);
    const edge = (i: number) => (i === windows ? to : ms(from + (i * span) / windows));
    const parts = Array.from({ length: windows }, (_, i): PlannedPart => ({ fragment: { t: { from: edge(i), to: edge(i + 1) } }, derive: "clip", maxBytes: base64(inline) }));
    return { parts, fit: { reduction: "windowed", original, shown: {} } };
  }
  const frames = mode === "show"
    ? Math.min(VIDEO_FRAMES_PER_READ, perCall(limits, mode))
    : Math.min(caps.frames ?? Infinity, Math.max(VIDEO_FRAMES_PER_READ, Math.ceil(span / LOOK_FRAME_SPACING_S)));
  if (frames < 1) return refuse("over_budget", "the route takes no image in a result", original);
  const box = boxOf(selector.region);
  if (!box) return refuse("refused", `the region ${JSON.stringify(selector.region)} is not within the frame`, original);
  const natural = facts.width && facts.height ? { width: facts.width, height: facts.height } : undefined;
  const laid = natural ? layout(natural, box, limits, 1, imageRender(natural)) : undefined;
  if (typeof laid === "string") return refuse("over_budget", laid, original);
  const parts = Array.from({ length: frames }, (_, i): PlannedPart => {
    const atS = ms(from + ((i + 0.5) * span) / frames);
    if (laid) return cutParts(laid, { t: { from: atS } }, "frame", box === WHOLE, { atS })[0];
    return { fragment: selector.region ? { t: { from: atS }, xywh: selector.region } : { t: { from: atS } }, derive: "frame", atS };
  });
  const shown: Shown = { frames, ...(laid ? { width: laid.cuts[0].crop.width, height: laid.cuts[0].crop.height } : {}) };
  const sized = withBytes(parts, limits, mode);
  if (typeof sized === "string") return refuse("over_budget", sized, original);
  return { parts: sized, fit: { reduction: "sampled", original, shown } };
}

export function plan(facts: SourceFacts, selector: Selector, limits: Limits, mode: PlanMode, caps: PlanCaps = {}): Plan {
  switch (facts.kind) {
    case "image": return planImage(facts, selector, limits, mode);
    case "pdf": return planPages(facts, selector, limits, mode, caps);
    case "video": case "recording": return planVideo(facts, selector, limits, mode, caps);
    case "office": case "sheet": case "text":
      return { parts: [{ fragment: selector.pages ? { page: selector.pages } : {}, derive: "text" }], fit: { reduction: "text_only", original: { bytes: facts.bytes } } };
    default: return refuse("unsupported", `a file of unknown kind${facts.mimeType ? ` (${facts.mimeType})` : ""} cannot be read`, { bytes: facts.bytes });
  }
}

/** The eyes requests of a plan made for `limits`, in order. */
export function lookRequests(planned: Plan, limits: Limits): PlannedPart[][] {
  return pack(planned.parts, limits);
}

/** Blocks already fitted, in order, one eyes request each: a request holds no more blocks than the least `most` of its
 *  blocks allows, and no more than `maxChars` base64 characters. A block is never split: one over `maxChars` alone is a
 *  request of its own. */
export function packRequests<T>(blocks: readonly T[], chars: (block: T) => number, most: (block: T) => number, maxChars: number): T[][] {
  const requests: T[][] = [];
  for (const block of blocks) {
    const open = requests.at(-1);
    if (open && open.length < Math.min(most(block), ...open.map(most)) && open.reduce((sum, b) => sum + chars(b), chars(block)) <= maxChars) open.push(block);
    else requests.push([block]);
  }
  return requests;
}

/** A look priced before its first request: parts times LOOK_TOKENS_PER_PART times the eyes' input price in dollars
 *  per million tokens; over the host's `capUsd` it is refused with the estimate. No cap, or an unknown price, refuses
 *  nothing. */
export function priceLook(planned: Plan, limits: Limits, inputUsdPerMTok: number | null | undefined, capUsd?: number): LookEstimate {
  const parts = planned.parts.length, requests = pack(planned.parts, limits).length, tokens = parts * LOOK_TOKENS_PER_PART;
  const usd = typeof inputUsdPerMTok === "number" && Number.isFinite(inputUsdPerMTok) && inputUsdPerMTok >= 0 ? (tokens * inputUsdPerMTok) / 1_000_000 : null;
  if (usd === null || capUsd === undefined || usd <= capUsd) return { parts, requests, tokens, usd };
  const detail = `this look is priced at $${usd.toFixed(4)} (${parts} parts at ${grouped(LOOK_TOKENS_PER_PART)} tokens, $${inputUsdPerMTok} per million), over the $${capUsd} cap; ask about fewer pages or a shorter window`;
  return { parts, requests, tokens, usd, refusal: { code: "over_budget", detail } };
}
