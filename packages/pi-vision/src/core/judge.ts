// `vision.judge`, a code-mode global beside `vision.see`: Jev, TypeSafe's System One model, answers typed questions
// (choice, noul, score, box) about images the agent's code made or holds, in one request. The images go in
// `state.images`, each fitted to Jev's limits and named by its fragment; example images go in the questions'
// instructions or criteria by reference. The answer is kept as the call's memo before it is filed and told, so a call run
// again pays and tells once. A box answer also names its region as a fragment of its image (`#xywh=percent:`), mapped
// back through the fit and through the region the image itself was cut from.

import { VISION_JUDGE } from "./contract.js";
import type { VisionEnv } from "./env.js";
import { blocksSha256, fileLook, fileTold, keptAnswer, lookKey, type Filing, type LookRecord } from "./evidence.js";
import { citation, parseCitation } from "./fragments.js";
import type { CallContext, CallSetup, ImageContent, Json, Usage } from "./host.js";
import { fitImage, type FitLimits, type PixelSize } from "./image.js";
import { JEV_IMAGE_BYTES, JEV_MAX_EDGE, JEV_MIN_EDGE, JEV_MODEL, JEV_REQUEST_BYTES, JEV_USD_PER_MTOK } from "./limits.js";
import { AS_IS, gatherMedia, namesMedia, once, throwMiss, type MediaRequest } from "./media.js";
import { firstLine, type Miss } from "./misses.js";
import type { CodeGlobal } from "./see.js";

/** A question as TypeSafe's API takes it. A `box` question's `image` is the index of the image it finds a thing in
 *  (default 0), so its answer gives that image's fragment. */
export type JevQuestion = { readonly type: "choice" | "noul" | "score" | "box"; readonly instructions?: Json; readonly criteria?: Json; readonly image?: number };
/** What the agent's code asks: the media, the questions, example images by the reference the questions write for
 *  them, and state fields of its own beside `images`. */
export type JudgeRequest = MediaRequest & {
  readonly questions: Readonly<Record<string, JevQuestion>>;
  readonly examples?: Readonly<Record<string, string | ImageContent>>;
  readonly state?: Readonly<Record<string, Json>>;
};
/** Jev's answers as it gives them (a box answer with `fragment` too), its model, the price (null when the tokens are not
 *  known), the receipt filed, and `kept` when this request asked nothing. */
export type JudgeAnswer = { readonly answers: Readonly<Record<string, Json>>; readonly model: string; readonly costUsd: number | null; readonly receipts: readonly string[]; readonly kept?: true };
export type JudgeGlobal = CodeGlobal<typeof VISION_JUDGE, JudgeAnswer>;

/** One System One request and its result, as TypeSafe's SDK shapes them. */
export type JevRequest = { readonly model?: string; readonly state: unknown; readonly questions: unknown; readonly assets?: unknown };
export type JevResult = { readonly model: string; readonly answers: unknown; readonly usage: { readonly input_tokens: number | null; readonly output_tokens: number | null } };
/** Jev as the host reaches it: a System One client (the SDK's `TypeSafeClient` as it is) and the SDK's `image`, which
 *  makes an image the SDK sends; the model (default `JEV_MODEL`) and its price per million input tokens. */
export type JevSeam = {
  readonly client: { systemOne(request: JevRequest, options?: { readonly signal?: AbortSignal; readonly headers?: Record<string, string> }): PromiseLike<JevResult> };
  readonly image: (bytes: Uint8Array) => unknown;
  readonly model?: string;
  readonly usdPerMTok?: number;
};

const TYPES = ["choice", "noul", "score", "box"];
/** Jev's limits as a fit: PNG or baseline JPEG, upright, each side 280 to 1,568 px, a file under 16 MiB. */
const JEV_FIT: FitLimits = { maxWidth: JEV_MAX_EDGE, maxHeight: JEV_MAX_EDGE, maxBytes: Math.ceil(JEV_IMAGE_BYTES / 3) * 4, minEdge: JEV_MIN_EDGE, formats: ["image/png", "image/jpeg"], baseline: true };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function checked(input: unknown): JudgeRequest {
  const r = (object(input) ? input : {}) as Record<string, unknown>;
  const count = (Array.isArray(r.images) ? r.images.length : 0) + (Array.isArray(r.paths) ? r.paths.length : 0);
  const questions = object(r.questions) ? Object.values(r.questions) : [];
  const said = JSON.stringify(r.questions ?? null);
  if (!namesMedia(r) || !questions.length || !questions.every((q) => object(q) && TYPES.includes(q.type as string) && (q.image === undefined || (Number.isInteger(q.image) && (q.image as number) >= 0 && (q.image as number) < count)))
    || !(r.state === undefined || (object(r.state) && !("images" in r.state))) || !(r.examples === undefined || (object(r.examples) && Object.keys(r.examples).every((ref) => said.includes(ref))))) {
    throw new TypeError("vision.judge takes { questions: { [name]: { type: \"choice\" | \"noul\" | \"score\" | \"box\", instructions?, criteria?, image? } }, paths?, images?, fragments?, examples?: { [reference written in a question]: path or image block }, state?: an object without `images` } with at least one path or image");
  }
  return r as JudgeRequest;
}

type Fitted = { readonly bytes: Uint8Array; readonly data: string; readonly fragment: string; readonly sent: PixelSize; readonly content: PixelSize };
type Box = { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };

/** A box on a fitted image as a region of the image it came from: the padding taken off, and the region the source
 *  names (a crop) put back. Undefined when nothing is left of it. */
function boxFragment(item: Fitted, box: Box): string | undefined {
  const edge = (v: number, scale: number) => Math.min(1, Math.max(0, v * scale));
  const [x0, x1] = [edge(box.left, item.sent.width / item.content.width), edge(box.right, item.sent.width / item.content.width)];
  const [y0, y1] = [edge(box.top, item.sent.height / item.content.height), edge(box.bottom, item.sent.height / item.content.height)];
  const { path, fragment } = parseCitation(item.fragment);
  const outer = fragment?.xywh ?? { x: 0, y: 0, w: 100, h: 100 };
  const cut = (v: number) => Math.floor(v * 1000) / 1000;
  try { return citation(path, { ...fragment, xywh: { x: cut(outer.x + x0 * outer.w), y: cut(outer.y + y0 * outer.h), w: cut((x1 - x0) * outer.w), h: cut((y1 - y0) * outer.h) } }); } catch { return undefined; }
}

/** One `vision.judge` call: the media and examples read and fitted to Jev's limits, one request asked once, filed and told. */
export async function judge(input: unknown, env: VisionEnv | undefined, call: CallContext, setup: CallSetup): Promise<JudgeAnswer> {
  const request = checked(input);
  const jev = setup.jev;
  const model = jev?.model ?? JEV_MODEL;
  const filing: Filing = { conversationId: call.conversationId, label: setup.scope.label, evidence: setup.evidence, onLook: setup.onLook, onMiss: setup.onMiss };
  let items: Fitted[] = [];
  const examples: (readonly [string, Fitted])[] = [];
  // The key names every image sent, the examples' too with their references, so a changed example is another judgment.
  const record = (answered: string, body: string, facts: Partial<LookRecord["facts"]> = {}): LookRecord => {
    const sha256 = blocksSha256([...items, ...examples.map(([, item]) => item)]);
    const key = lookKey({ sha256, fragment: items.map((item) => item.fragment).join("\n"), model, plan: [request.questions, request.state ?? null, examples.map(([ref]) => ref)] });
    return { tool: "look", args: { path: [...new Set(items.map((item) => item.fragment))].join(", "), ask: JSON.stringify(request.questions), model: answered, native: false, via: "jev" }, status: "ok", body, facts: { sha256, kind: "image", fragment: "", key, shown_blocks: items.length + examples.length, ...facts } };
  };
  const fail = (cause: Miss, spent: Partial<LookRecord["facts"]> = { tokens_in: 0, tokens_out: 0, cost_usd: 0 }): Promise<never> =>
    throwMiss(filing, VISION_JUDGE.name, call, cause, record(cause.model ?? "no vision route", "", spent));
  if (!jev) return fail({ code: "no_vision_route", reason: "this host gives vision.judge no Jev client" });

  // Every image within Jev's limits, the examples after the images; a video goes as frames cut from it.
  const fitted = async (media: MediaRequest): Promise<Fitted[]> => {
    const out: Fitted[] = [];
    for (const { bytes, mimeType, fragment } of await gatherMedia(media, env, call, setup, VISION_JUDGE.name, fail)) {
      if (mimeType.startsWith("video/")) return fail({ code: "unsupported", reason: `${fragment} is a video; Jev takes still images: cut frames with ffmpeg and pass them`, model });
      const fit = await fitImage(setup.images ?? AS_IS, bytes, mimeType, JEV_FIT, { tiles: false });
      if (fit.fit === "refused") return fail({ code: setup.images ? fit.code : "needs", reason: `${fragment}: ${fit.limit}, and ${setup.images ? fit.why : "no image processor is installed to fit it (Photon or sharp)"}`, model });
      const [block] = fit.blocks;
      out.push({ bytes: Buffer.from(block!.data, "base64"), data: block!.data, fragment, sent: block!, content: (fit.fit === "resized" && fit.content) || block! });
    }
    return out;
  };
  items = await fitted(request);
  for (const [ref, example] of Object.entries(request.examples ?? {})) examples.push([ref, (await fitted(typeof example === "string" ? { paths: [example] } : { images: [example] }))[0]!]);
  const bytes = [...items, ...examples.map(([, item]) => item)].reduce((sum, item) => sum + item.bytes.length, 0);
  if (bytes > JEV_REQUEST_BYTES) return fail({ code: "over_budget", reason: `its images come to ${bytes} bytes, over the ${JEV_REQUEST_BYTES} one request to Jev carries; split them across calls`, model });

  const at = record(model, "");
  /** The answers, each box with its region as a fragment of its image. */
  const mapped = (result: JevResult) => Object.fromEntries(Object.entries(result.answers as Record<string, Json>).map(([name, answer]) => {
    const box = object(answer) && answer.type === "box" && object(answer.box) ? boxFragment(items[request.questions[name]?.image ?? 0]!, answer.box as Box) : undefined;
    return [name, box ? { ...(answer as Record<string, Json>), fragment: box } : answer];
  }));
  const ask = async (): Promise<JevResult> => {
    const questions = Object.fromEntries(Object.entries(request.questions).map(([name, { image: _image, ...question }]) => [name, question]));
    const state = { ...request.state, images: items.map((item) => ({ source: item.fragment, image: jev.image(item.bytes) })) };
    const assets = Object.fromEntries(examples.map(([ref, item]) => [ref, jev.image(item.bytes)]));
    const result = await jev.client.systemOne({ model, state, questions, ...(examples.length ? { assets } : {}) }, { ...(call.signal ? { signal: call.signal } : {}), headers: { "TypeSafe-Danger-Zone-Images": "true" } });
    return { model: result.model, answers: result.answers, usage: result.usage };
  };
  const { value: { result, readBack, receipt, costUsd }, shared } = await once(call, at.facts.key, async () => {
    let result: JevResult, readBack: boolean;
    try {
      ({ answer: result, readBack } = await keptAnswer<JevResult>(call.memo, at.facts.key, ask));
    } catch (error) {
      if (call.signal?.aborted) throw error;
      // A request that threw may still have been billed: its price is not known, so none is filed.
      return fail({ code: (error as { status?: unknown })?.status === 413 ? "over_budget" : "look_failed", reason: `Jev failed: ${firstLine(error)}`, model }, {});
    }
    const [tokensIn, tokensOut] = [result.usage.input_tokens, result.usage.output_tokens];
    const costUsd = tokensIn === null ? null : (tokensIn * (jev.usdPerMTok ?? JEV_USD_PER_MTOK)) / 1_000_000;
    const usage: Usage = { input: tokensIn ?? 0, output: tokensOut ?? 0, cacheRead: 0, cacheWrite: 0, totalTokens: (tokensIn ?? 0) + (tokensOut ?? 0), cost: { input: costUsd ?? 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd ?? 0 } };
    const facts = { ...(tokensIn !== null ? { tokens_in: tokensIn } : {}), ...(tokensOut !== null ? { tokens_out: tokensOut } : {}), cost_usd: costUsd, ...(readBack ? { kept: true as const } : {}) };
    const filed = { ...at, args: { ...at.args, model: result.model }, body: JSON.stringify(mapped(result)), facts: { ...at.facts, ...facts } };
    const receipt = await fileTold(call.memo, at.facts.key, filing, (to, told) => fileLook(to, VISION_JUDGE.name, filed, { usage, costUsd, ...(told ? { kept: true } : {}) }));
    return { result, readBack, receipt, costUsd };
  });

  return { answers: mapped(result), model: result.model, costUsd, receipts: receipt ? [receipt] : [], ...(readBack || shared ? { kept: true } : {}) };
}
