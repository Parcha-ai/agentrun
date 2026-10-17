// `vision.see`, the one function a host puts in an agent's code mode: a vision model answers a question about images the
// agent's code made or holds (rendered pages, video frames, crops), by path through the call's environment or as image
// blocks. Each image is fitted to the eyes' limits and the images go in as few requests as the eyes take, each request a
// look whose answer is kept as the call's memo before it is filed and told: a call run again pays for each look and tells
// the host of it once. Several requests come back as one text, each part headed by its fragments; the agent joins them.
// A look that cannot be made is filed and told as a miss, then thrown with its code.

import { createHash } from "node:crypto";
import { VISION_SEE, type MissCode } from "./contract.js";
import { visionContext, type VisionEnv } from "./env.js";
import { blocksSha256, fileLook, fileTold, keptAnswer, lookKey, type Filing, type LookRecord } from "./evidence.js";
import type { CallContext, CallSetup, EyesAnswer, ImageContent } from "./host.js";
import { formatFragment, parseCitation } from "./fragments.js";
import { fitImage, type ImageProcessor } from "./image.js";
import { sniffKind, SNIFF_BYTES, type Kind } from "./kinds.js";
import { SOURCE_BYTES_IN_PROCESS } from "./limits.js";
import { firstLine, linkSafe, reportMiss, type Miss } from "./misses.js";
import { packRequests, type Part } from "./plan.js";

/** What the agent's code asks: `fragments[i]` names medium `i`, the images first and then the paths. */
export type SeeRequest = { readonly ask: string; readonly paths?: readonly string[]; readonly images?: readonly ImageContent[]; readonly fragments?: readonly string[] };
/** The answer, the eyes' model, the looks' price (null when one is unknown), the receipts filed, one a request in order
 *  (none for a request the host's sink filed nothing for), and `kept` when this request asked nothing: each answer was
 *  the call's already, kept in its memo or being asked by another request of the call. */
export type SeeAnswer = { readonly text: string; readonly model: string; readonly costUsd: number | null; readonly receipts: readonly string[]; readonly kept?: true };

/** A look `vision.see` could not make, thrown once it is filed and told; the message starts with the code. */
export class SeeMiss extends Error {
  constructor(readonly code: MissCode, reason: string) { super(`${code}: ${reason}`); this.name = "SeeMiss"; }
}

/** `vision.see` as pi-codemode's `globals` take it: the contract's name and words, and `execute`. */
export type SeeGlobal = typeof VISION_SEE & { execute(request: unknown, context?: { readonly signal?: AbortSignal }): Promise<SeeAnswer> };

/** A fitted block on its way to the eyes, with the fragment it came from and the line the eyes are told beside it. */
type Item = { readonly data: string; readonly mimeType: string; readonly width?: number; readonly height?: number; readonly fragment: string; readonly caption: string };

/** What a miss with no block in a request is about: the medium as the agent named it, the kind it reads as, the hash
 *  of its bytes ("" when none were read), and the window or page its name cites; or the request's media before any is
 *  read. */
type About = { readonly path: string; readonly kind: Kind; readonly sha256: string; readonly fragment: string };
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** The window or page a medium's name cites (`clip.mp4#t=60,90`), "" when it cites none. */
const citedFragment = (label: string) => {
  const cited = parseCitation(label).fragment;
  try { return cited ? formatFragment(cited) : ""; } catch { return ""; }
};
const aboutMedium = (label: string, kind: Kind, bytes?: Uint8Array): About => ({ path: label, kind, sha256: bytes ? sha256Of(bytes) : "", fragment: citedFragment(label) });

/** A look asked, filed and told: what the eyes answered, whether it was read back from the call's memo, and its receipt. */
type Asked = { readonly look: EyesAnswer; readonly readBack: boolean; readonly receipt: string | null; readonly body: string };
/** The looks each call (by its memo port) has in flight, by key: a second ask for one waits for the first, which alone
 *  pays, files and tells. */
const inFlight = new WeakMap<object, Map<string, Promise<Asked>>>();

/** A processor that fits nothing: an image within the limits passes as it is, any other is refused. */
const AS_IS: ImageProcessor = { prepare: async () => undefined };
const isVideo = (item: { readonly mimeType: string }) => item.mimeType.startsWith("video/");
const strings = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((s) => typeof s === "string"));

function checked(input: unknown): SeeRequest {
  const r = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const images = r.images === undefined || (Array.isArray(r.images) && r.images.every((b) => b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string"));
  const count = (Array.isArray(r.images) ? r.images.length : 0) + (Array.isArray(r.paths) ? r.paths.length : 0);
  if (typeof r.ask !== "string" || !r.ask.trim() || !images || !strings(r.paths) || !strings(r.fragments) || !count) {
    throw new TypeError("vision.see takes { ask: string, paths?: string[], images?: { type: \"image\", data, mimeType }[], fragments?: string[] } with at least one path or image");
  }
  return r as SeeRequest;
}

/** One `vision.see` call: the media read and fitted, packed into requests, each asked once, filed and told. */
export async function see(input: unknown, env: VisionEnv | undefined, call: CallContext, setup: CallSetup): Promise<SeeAnswer> {
  const request = checked(input);
  const ask = request.ask.trim();
  const filing: Filing = { conversationId: call.conversationId, label: setup.scope.label, evidence: setup.evidence, onLook: setup.onLook, onMiss: setup.onMiss };
  const record = (items: readonly Item[], model: string, body: string, facts: Partial<LookRecord["facts"]> = {}, about?: About): LookRecord => {
    if (!items.length && about) {
      return {
        tool: "look", args: { path: about.path, ask, model, native: false }, status: "ok", body,
        facts: { sha256: about.sha256, kind: about.kind, fragment: about.fragment, key: lookKey({ sha256: about.sha256, fragment: about.fragment, ask, model }), shown_blocks: 0, ...facts },
      };
    }
    const fragment = [...new Set(items.map((item) => item.fragment))].join(", ");
    const sha256 = blocksSha256(items);
    return {
      tool: "look", args: { path: fragment, ask, model, native: false }, status: "ok", body,
      // The key names each block's own line in order, so the same images named otherwise are another look.
      facts: { sha256, kind: items.some(isVideo) ? "video" : "image", fragment: "", key: lookKey({ sha256, fragment: items.map((item) => item.caption).join("\n"), ask, model }), shown_blocks: items.length, ...facts },
    };
  };
  // A miss before any request cost nothing; one after a request says what it knows of that request.
  const fail = async (cause: Miss, items: readonly Item[] = [], spent: Partial<LookRecord["facts"]> = { tokens_in: 0, tokens_out: 0, cost_usd: 0 }, about?: About): Promise<never> => {
    // A stopped call files no miss: what failed was the stop (a cancelled read, say), not the source or the eyes.
    if (call.signal?.aborted) throw call.signal.reason;
    const reason = linkSafe(cause.reason);
    await reportMiss(filing, VISION_SEE.name, record(items, cause.model ?? "no vision route", "", spent, about), { ...cause, reason });
    throw new SeeMiss(cause.code, reason);
  };
  // Before any medium is read, a miss is about the request's media as named: their kind and bytes are known only when
  // every one is a block.
  const labels = [...(request.images ?? []).map((_, i) => request.fragments?.[i] ?? `image ${i + 1}`), ...(request.paths ?? []).map((path, i) => request.fragments?.[(request.images?.length ?? 0) + i] ?? path)];
  const requested = (): About => {
    const blocksOnly = !request.paths?.length && request.images ? request.images : undefined;
    return {
      path: labels.join(", "), kind: blocksOnly ? (blocksOnly.some(isVideo) ? "video" : "image") : "unknown",
      sha256: blocksOnly ? blocksSha256(blocksOnly) : "", fragment: labels.length === 1 ? citedFragment(labels[0]!) : "",
    };
  };
  const eyes = setup.eyes;
  if (!eyes?.accepts.image) return fail(eyes ? { code: "no_vision_route", reason: `the vision route ${eyes.model} does not accept images`, model: eyes.model } : { code: "no_vision_route", reason: "no vision route is configured for this run" }, [], undefined, requested());

  const ctx = visionContext(call.signal);
  const readPath = async (path: string, label: string): Promise<{ bytes: Uint8Array; mimeType: string }> => {
    const unread = () => aboutMedium(label, "unknown");
    if (!env) return fail({ code: "refused", reason: `${path} cannot be read: this host gives vision.see no environment; pass the image as a block` }, [], undefined, unread());
    const info = await env.fileInfo(path, ctx);
    if (!info.ok || info.value.kind !== "file") return fail({ code: "unreadable", reason: `${path} is not a file that opens${info.ok ? "" : ` (${firstLine(info.error)})`}` }, [], undefined, unread());
    if (info.value.size > SOURCE_BYTES_IN_PROCESS) return fail({ code: "over_budget", reason: `${path} is ${info.value.size} bytes, over the ${SOURCE_BYTES_IN_PROCESS} read into this process; cut it smaller first` }, [], undefined, unread());
    const read = await env.readBinaryFile(path, ctx);
    if (!read.ok) return fail({ code: "unreadable", reason: `${path} could not be read (${firstLine(read.error)})` }, [], undefined, unread());
    const sniffed = sniffKind(read.value.subarray(0, SNIFF_BYTES), path);
    if (!sniffed.ok) return fail(sniffed, [], undefined, aboutMedium(label, "unknown", read.value));
    if (sniffed.kind !== "image" && sniffed.kind !== "video") return fail({ code: "unsupported", reason: `${path} reads as ${sniffed.kind}, not an image or a video; render its pages or cut its frames to images first` }, [], undefined, aboutMedium(label, sniffed.kind, read.value));
    const allowed = setup.allow?.({ path, kind: sniffed.kind, tool: VISION_SEE.name }) ?? true;
    if (allowed !== true) return fail({ code: "refused", reason: allowed }, [], undefined, aboutMedium(label, sniffed.kind, read.value));
    return { bytes: read.value, mimeType: sniffed.mimeType ?? "application/octet-stream" };
  };
  const media = (request.images ?? []).map((image, i) => ({ bytes: Buffer.from(image.data, "base64") as Uint8Array, mimeType: image.mimeType, fragment: labels[i]! }));
  for (const path of request.paths ?? []) { const label = labels[media.length]!; media.push({ ...(await readPath(path, label)), fragment: label }); }

  // Each image within the eyes' own limits and what one request to them carries; a video clip as it is, when they take it.
  const box = { ...eyes.limits.image, maxBytes: Math.min(eyes.limits.image.maxBytes, eyes.limits.requestBytes), imagesPerCall: eyes.limits.imagesPerCall };
  const clipChars = Math.min(Math.ceil(eyes.limits.video.inlineBytes / 3) * 4, eyes.limits.requestBytes);
  const items: Item[] = [];
  for (const { bytes, mimeType, fragment } of media) {
    if (isVideo({ mimeType })) {
      const data = Buffer.from(bytes).toString("base64");
      if (!eyes.accepts.video) return fail({ code: "video_unseeable", reason: `${fragment}: the vision route ${eyes.model} does not take video; cut frames with ffmpeg and pass them as images`, model: eyes.model }, [], undefined, aboutMedium(fragment, "video", bytes));
      if (data.length > clipChars) return fail({ code: "over_budget", reason: `${fragment} is ${data.length} base64 characters, over the ${clipChars} one request to ${eyes.model} carries; cut a shorter window`, model: eyes.model }, [], undefined, aboutMedium(fragment, "video", bytes));
      items.push({ data, mimeType, fragment, caption: fragment });
      continue;
    }
    const fit = await fitImage(setup.images ?? AS_IS, bytes, mimeType, box);
    if (fit.fit === "refused") return fail({ code: setup.images ? fit.code : "needs", reason: `${fragment}: ${fit.limit}, and ${setup.images ? fit.why : "no image processor is installed to fit it (Photon or sharp)"}`, model: eyes.model }, [], undefined, aboutMedium(fragment, "image", bytes));
    fit.blocks.forEach((block, k) => items.push({ ...block, fragment, caption: fit.blocks.length > 1 ? `${fragment} (tile ${k + 1} of ${fit.blocks.length})` : fragment }));
  }

  const once = async (items: readonly Item[], at: LookRecord): Promise<Asked> => {
    // Each image goes with the line that names it, so the eyes can say where they saw a thing.
    const parts = items.flatMap((item): Part[] => [{ type: "text", text: item.caption, fragment: item.fragment },
      isVideo(item) ? { type: "video", data: item.data, mimeType: item.mimeType, fragment: item.fragment }
        : { type: "image", data: item.data, mimeType: item.mimeType, width: item.width!, height: item.height!, fragment: item.fragment }]);
    let look: EyesAnswer, readBack: boolean;
    try {
      ({ answer: look, readBack } = await keptAnswer<EyesAnswer>(call.memo, at.facts.key, () => eyes.see({ parts, ask }, call.signal ?? new AbortController().signal)));
    } catch (error) {
      if (call.signal?.aborted) throw error;
      // A request that threw may still have been billed: its price is not known, so none is filed.
      return fail({ code: "look_failed", reason: `the vision route ${eyes.model} failed: ${firstLine(error)}`, model: eyes.model }, items, {});
    }
    const facts = { tokens_in: look.usage.input + look.usage.cacheRead + look.usage.cacheWrite, tokens_out: look.usage.output, cost_usd: look.costUsd, ...(look.billedBy ? { provider: look.billedBy } : {}), ...(readBack ? { kept: true as const } : {}) };
    if (!look.text.trim()) return fail({ code: "look_failed", reason: `the vision route ${look.model} returned no text`, model: look.model }, items, facts);
    const filed = { ...at, args: { ...at.args, model: look.model }, body: look.text.trim(), facts: { ...at.facts, ...facts } };
    const receipt = await fileTold(call.memo, at.facts.key, filing, (to, told) => fileLook(to, VISION_SEE.name, filed, told ? { ...look, kept: true } : look));
    return { look, readBack, receipt, body: filed.body };
  };

  const most = Math.max(1, Math.floor(eyes.limits.imagesPerCall));
  const requests = packRequests(items, (item) => item.data.length, (item) => (isVideo(item) ? 1 : most), eyes.limits.requestBytes);
  const flying = (call.memo && inFlight.get(call.memo)) || new Map<string, Promise<Asked>>();
  if (call.memo) inFlight.set(call.memo, flying);
  const texts: string[] = [], receipts: string[] = [];
  let costUsd: number | null = 0, kept = true, model = eyes.model;
  for (const items of requests) {
    const at = record(items, eyes.model, "");
    const shared = flying.get(at.facts.key);
    const asked = shared ?? once(items, at);
    if (!shared) { const done = () => flying.delete(at.facts.key); flying.set(at.facts.key, asked); asked.then(done, done); }
    const { look, readBack, receipt, body } = await asked;
    texts.push(requests.length > 1 ? `(${at.args.path}${receipt ? `; look filed at ${receipt}` : ""})\n${body}` : body);
    if (receipt) receipts.push(receipt);
    costUsd = costUsd === null || look.costUsd === null ? null : costUsd + look.costUsd;
    kept &&= readBack || shared !== undefined;
    model = look.model;
  }
  return { text: texts.join("\n\n"), model, costUsd, receipts, ...(kept ? { kept: true } : {}) };
}
