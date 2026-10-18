// `vision.see`, the one function a host puts in an agent's code mode: a vision model answers a question about images the
// agent's code made or holds (rendered pages, video frames, crops), by path through the call's environment or as image
// blocks. Each image is fitted to the eyes' limits and the images go in as few requests as the eyes take, each request a
// look whose answer is kept as the call's memo before it is filed and told: a call run again pays for each look and tells
// the host of it once. Several requests come back as one text, each part headed by its fragments; the agent joins them.
// A look that cannot be made is filed and told as a miss, then thrown with its code.

import { VISION_SEE } from "./contract.js";
import type { VisionEnv } from "./env.js";
import { blocksSha256, fileLook, fileTold, keptAnswer, lookKey, type Filing, type LookRecord } from "./evidence.js";
import type { CallContext, CallSetup, EyesAnswer } from "./host.js";
import { fitImage } from "./image.js";
import { aboutMedium, AS_IS, gatherMedia, namesMedia, once, requestedAbout, throwMiss, type About, type MediaMiss, type MediaRequest } from "./media.js";
import { firstLine } from "./misses.js";
import { packRequests, type Part } from "./plan.js";

export { SeeMiss } from "./media.js";

/** What the agent's code asks: `fragments[i]` names medium `i`, the images first and then the paths. */
export type SeeRequest = MediaRequest & { readonly ask: string };
/** The answer, the eyes' model, the looks' price (null when one is unknown), the receipts filed, one a request in order
 *  (none for a request the host's sink filed nothing for), and `kept` when this request asked nothing: each answer was
 *  the call's already, kept in its memo or being asked by another request of the call. */
export type SeeAnswer = { readonly text: string; readonly model: string; readonly costUsd: number | null; readonly receipts: readonly string[]; readonly kept?: true };

/** A code-mode global as pi-codemode's `globals` take it: the contract's name and words, and `execute`. */
export type CodeGlobal<C, A> = C & { execute(request: unknown, context?: { readonly signal?: AbortSignal }): Promise<A> };
/** `vision.see` as a code-mode global: the contract's words and `execute`, which puts a question about images to the eyes. */
export type SeeGlobal = CodeGlobal<typeof VISION_SEE, SeeAnswer>;

/** A fitted block on its way to the eyes, with the fragment it came from and the line the eyes are told beside it. */
type Item = { readonly data: string; readonly mimeType: string; readonly width?: number; readonly height?: number; readonly fragment: string; readonly caption: string };

/** A look asked, filed and told: what the eyes answered, whether it was read back from the call's memo, and its receipt. */
type Asked = { readonly look: EyesAnswer; readonly readBack: boolean; readonly receipt: string | null; readonly body: string };

const isVideo = (item: { readonly mimeType: string }) => item.mimeType.startsWith("video/");

function checked(input: unknown): SeeRequest {
  const r = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (typeof r.ask !== "string" || !r.ask.trim() || !namesMedia(r)) {
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
  const fail = ({ about, ...cause }: MediaMiss, items: readonly Item[] = [], spent: Partial<LookRecord["facts"]> = { tokens_in: 0, tokens_out: 0, cost_usd: 0 }): Promise<never> =>
    throwMiss(filing, VISION_SEE.name, call, cause, record(items, cause.model ?? "no vision route", "", spent, about));
  const eyes = setup.eyes;
  if (!eyes?.accepts.image) return fail({ ...(eyes ? { code: "no_vision_route", reason: `the vision route ${eyes.model} does not accept images`, model: eyes.model } : { code: "no_vision_route", reason: "no vision route is configured for this run" }), about: requestedAbout(request) });
  const media = await gatherMedia(request, env, call, setup, VISION_SEE.name, fail);

  // Each image within the eyes' own limits and what one request to them carries; a video clip as it is, when they take it.
  const box = { ...eyes.limits.image, maxBytes: Math.min(eyes.limits.image.maxBytes, eyes.limits.requestBytes), imagesPerCall: eyes.limits.imagesPerCall };
  const clipChars = Math.min(Math.ceil(eyes.limits.video.inlineBytes / 3) * 4, eyes.limits.requestBytes);
  const items: Item[] = [];
  for (const { bytes, mimeType, fragment } of media) {
    if (isVideo({ mimeType })) {
      const data = Buffer.from(bytes).toString("base64");
      if (!eyes.accepts.video) return fail({ code: "video_unseeable", reason: `${fragment}: the vision route ${eyes.model} does not take video; cut frames with ffmpeg and pass them as images`, model: eyes.model, about: aboutMedium(fragment, "video", bytes) });
      if (data.length > clipChars) return fail({ code: "over_budget", reason: `${fragment} is ${data.length} base64 characters, over the ${clipChars} one request to ${eyes.model} carries; cut a shorter window`, model: eyes.model, about: aboutMedium(fragment, "video", bytes) });
      items.push({ data, mimeType, fragment, caption: fragment });
      continue;
    }
    const fit = await fitImage(setup.images ?? AS_IS, bytes, mimeType, box);
    if (fit.fit === "refused") return fail({ code: setup.images ? fit.code : "needs", reason: `${fragment}: ${fit.limit}, and ${setup.images ? fit.why : "no image processor is installed to fit it (Photon or sharp)"}`, model: eyes.model, about: aboutMedium(fragment, "image", bytes) });
    fit.blocks.forEach((block, k) => items.push({ ...block, fragment, caption: fit.blocks.length > 1 ? `${fragment} (tile ${k + 1} of ${fit.blocks.length})` : fragment }));
  }

  const ask1 = async (items: readonly Item[], at: LookRecord): Promise<Asked> => {
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
  const texts: string[] = [], receipts: string[] = [];
  let costUsd: number | null = 0, kept = true, model = eyes.model;
  for (const items of requests) {
    const at = record(items, eyes.model, "");
    const { value: { look, readBack, receipt, body }, shared } = await once(call, at.facts.key, () => ask1(items, at));
    texts.push(requests.length > 1 ? `(${at.args.path}${receipt ? `; look filed at ${receipt}` : ""})\n${body}` : body);
    if (receipt) receipts.push(receipt);
    costUsd = costUsd === null || look.costUsd === null ? null : costUsd + look.costUsd;
    kept &&= readBack || shared;
    model = look.model;
  }
  return { text: texts.join("\n\n"), model, costUsd, receipts, ...(kept ? { kept: true } : {}) };
}
