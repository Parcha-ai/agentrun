// `vision.judge`, a code-mode global beside `vision.see`: Jev, TypeSafe's System One model, answers typed questions
// (choice, noul, score, box) about images the agent's code made or holds, in one request through the host's Jev port.
// The images go in `state.images`, each fitted to Jev's limits and named by its fragment; example images go in the
// questions' instructions or criteria by reference. A request with no image at all is a text judgment: its text goes in
// `state`, and it asks choice, noul or score, never a box (a box finds a thing in an image). The answer is kept as the
// call's memo before it is filed and told,
// so a call run again pays and tells once. A box answer also names its region as a fragment of its image
// (`#xywh=percent:`), mapped back through the fit and through the region the image itself was cut from.

import { VISION_JUDGE } from "./contract.js";
import type { VisionEnv } from "./env.js";
import { blocksSha256, fileLook, fileTold, keptAnswer, lookKey, type Filing, type LookRecord } from "./evidence.js";
import { citation, parseCitation } from "./fragments.js";
import type { CallContext, CallSetup, ImageContent, Json, Usage } from "./host.js";
import { fitImage, type FitLimits, type PixelSize } from "./image.js";
import { JEV_IMAGE_BYTES, JEV_MAX_EDGE, JEV_MIN_EDGE, JEV_MODEL, JEV_REQUEST_BYTES } from "./limits.js";
import { aboutMedium, AS_IS, gatherMedia, namesMedia, once, requestedAbout, throwMiss, type About, type MediaMiss, type MediaRequest } from "./media.js";
import { firstLine } from "./misses.js";
import { base64Chars } from "./primitives.js";
import { lookTiming } from "./timing.js";
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
/** Jev's answers as it gives them (a box answer with `fragment` too), its model, the price (null when the port does not
 *  know it), the receipt filed, and `kept` when this request asked nothing. */
export type JudgeAnswer = { readonly answers: Readonly<Record<string, Json>>; readonly model: string; readonly costUsd: number | null; readonly receipts: readonly string[]; readonly kept?: true };
/** `vision.judge` as a code-mode global: the contract's words and `execute`, which asks Jev typed questions about images. */
export type JudgeGlobal = CodeGlobal<typeof VISION_JUDGE, JudgeAnswer>;

/** One image a request carries: PNG or JPEG file bytes and their type. */
export type JevImage = { readonly bytes: Uint8Array; readonly mime: "image/png" | "image/jpeg" };
/** Jev's answer to one request as the port gives it: the typed answers, the model, its tokens, and its price, null when
 *  the port does not know it. */
export type JevResult = { readonly answers: unknown; readonly model?: string | null; readonly usage?: { readonly input_tokens: number; readonly output_tokens: number } | null; readonly cost_usd?: number | null };
/** Jev as the host reaches it: `judge` is the port `@parcha/agentrun-jev`'s `createJevRunner` returns, which owns the
 *  transport, the images header and the price; `assets` maps each reference written in the state or a question to its
 *  image. `model` is the one to ask (default `JEV_MODEL`). */
export type JevPort = {
  judge(params: { readonly label: string; readonly kind: string; readonly state: unknown; readonly questions: Readonly<Record<string, unknown>>; readonly assets?: Readonly<Record<string, JevImage>>; readonly model?: string; readonly signal?: AbortSignal }): Promise<JevResult>;
  readonly model?: string;
};

const TYPES = ["choice", "noul", "score", "box"];
/** Jev's limits as a fit: PNG or baseline JPEG, upright, each side 280 to 1,568 px, a file under 16 MiB. */
const JEV_FIT: FitLimits = { maxWidth: JEV_MAX_EDGE, maxHeight: JEV_MAX_EDGE, maxBytes: base64Chars(JEV_IMAGE_BYTES), minEdge: JEV_MIN_EDGE, formats: ["image/png", "image/jpeg"], baseline: true };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function checked(input: unknown): JudgeRequest {
  const r = (object(input) ? input : {}) as Record<string, unknown>;
  const count = (Array.isArray(r.images) ? r.images.length : 0) + (Array.isArray(r.paths) ? r.paths.length : 0);
  const questions = object(r.questions) ? Object.values(r.questions) : [];
  const said = JSON.stringify(r.questions ?? null);
  // A text judgment: no path, image, fragment or example, no box question, and a state that carries the text.
  const bare = [r.images, r.paths, r.fragments].every((v) => v === undefined || (Array.isArray(v) && v.length === 0)) && (r.examples === undefined || (object(r.examples) && Object.keys(r.examples).length === 0));
  const text = bare && object(r.state) && Object.keys(r.state).length > 0 && questions.every((q) => object(q) && q.type !== "box" && q.image === undefined);
  if (!(namesMedia(r) || text) || !questions.length || !questions.every((q) => object(q) && TYPES.includes(q.type as string) && (q.image === undefined || (Number.isInteger(q.image) && (q.image as number) >= 0 && (q.image as number) < count)))
    || !(r.state === undefined || (object(r.state) && !("images" in r.state))) || !(r.examples === undefined || (object(r.examples) && Object.keys(r.examples).every((ref) => said.includes(ref))))) {
    throw new TypeError("vision.judge takes { questions: { [name]: { type: \"choice\" | \"noul\" | \"score\" | \"box\", instructions?, criteria?, image? } }, paths?, images?, fragments?, examples?: { [reference written in a question]: path or image block }, state?: an object without `images` } with at least one path or image, or, for a text judgment with none, a non-empty state and no box question");
  }
  return r as JudgeRequest;
}

type Fitted = { readonly bytes: Uint8Array; readonly data: string; readonly mime: JevImage["mime"]; readonly fragment: string; readonly sent: PixelSize; readonly content: PixelSize };
/** The reference an image of the state goes under: a string no script writes by chance. */
const reference = (i: number) => `<vision.judge image ${i + 1}>`;
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
  // A miss before any image is fitted is filed as the medium it was about, never as an empty image.
  const record = (answered: string, body: string, facts: Partial<LookRecord["facts"]> = {}, about?: About): LookRecord => {
    const on = items.length ? undefined : about;
    const sha256 = on ? on.sha256 : blocksSha256([...items, ...examples.map(([, item]) => item)]);
    const key = lookKey({ sha256, fragment: on ? on.fragment : items.map((item) => item.fragment).join("\n"), model, plan: [request.questions, request.state ?? null, examples.map(([ref]) => ref)] });
    return { tool: "look", args: { path: on ? on.path : [...new Set(items.map((item) => item.fragment))].join(", "), ask: JSON.stringify(request.questions), model: answered, native: false, via: "jev" }, status: "ok", body, facts: { sha256, kind: on ? on.kind : items.length ? "image" : "text", fragment: on ? on.fragment : "", key, shown_blocks: items.length + examples.length, ...lookTiming(call), ...facts } };
  };
  const fail = ({ about, ...cause }: MediaMiss, spent: Partial<LookRecord["facts"]> = { tokens_in: 0, tokens_out: 0, cost_usd: 0 }): Promise<never> =>
    throwMiss(filing, VISION_JUDGE.name, call, cause, record(cause.model ?? "no vision route", "", spent, about));
  if (!jev) return fail({ code: "no_vision_route", reason: "this host gives vision.judge no Jev port", about: requestedAbout(request) });

  // Every image within Jev's limits, the examples after the images; a video goes as frames cut from it.
  const fitted = async (media: MediaRequest): Promise<Fitted[]> => {
    const out: Fitted[] = [];
    for (const { bytes, mimeType, fragment } of await gatherMedia(media, env, call, setup, VISION_JUDGE.name, fail)) {
      if (mimeType.startsWith("video/")) return fail({ code: "unsupported", reason: `${fragment} is a video; Jev takes still images: cut frames with ffmpeg and pass them`, model, about: aboutMedium(fragment, "video", bytes) });
      const fit = await fitImage(setup.images ?? AS_IS, bytes, mimeType, JEV_FIT, { tiles: false });
      if (fit.fit === "refused") return fail({ code: setup.images ? fit.code : "needs", reason: `${fragment}: ${fit.limit}, and ${setup.images ? fit.why : "no image processor is installed to fit it (Photon or sharp)"}`, model, about: aboutMedium(fragment, "image", bytes) });
      const [block] = fit.blocks;
      out.push({ bytes: Buffer.from(block!.data, "base64"), data: block!.data, mime: block!.mimeType as JevImage["mime"], fragment, sent: block!, content: (fit.fit === "resized" && fit.content) || block! });
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
  // When this call's request to Jev began; none when the answer is read back.
  let startedAt: number | undefined;
  const ask = async (): Promise<JevResult> => {
    const questions = Object.fromEntries(Object.entries(request.questions).map(([name, { image: _image, ...question }]) => [name, question]));
    const state = items.length ? { ...request.state, images: items.map((item, i) => ({ source: item.fragment, image: reference(i) })) } : { ...request.state };
    const assets = Object.fromEntries([...items.map((item, i) => [reference(i), item] as const), ...examples].map(([ref, item]) => [ref, { bytes: item.bytes, mime: item.mime }]));
    startedAt = Date.now();
    const result = await jev.judge({ label: VISION_JUDGE.name, kind: "judge", state, questions, assets, model, ...(call.signal ? { signal: call.signal } : {}) });
    return { answers: result.answers, model: result.model ?? null, usage: result.usage ?? null, cost_usd: result.cost_usd ?? null };
  };
  const { value: { result, readBack, receipt, costUsd }, shared } = await once(call, at.facts.key, async () => {
    let result: JevResult, readBack: boolean;
    try {
      ({ answer: result, readBack } = await keptAnswer<JevResult>(call.memo, at.facts.key, ask));
    } catch (error) {
      if (call.signal?.aborted) throw error;
      // A request that threw may still have been billed: its price is not known, so none is filed. A request the port
      // refused before it sent anything (a box asked of a model that has none, a state over the host's limit, an image it
      // does not take) is marked by its request diagnostic: it cost nothing and began no call.
      const { status, requestDiagnostic } = (error ?? {}) as { status?: unknown; requestDiagnostic?: { reason?: unknown } };
      const refused = typeof requestDiagnostic?.reason === "string";
      const code = requestDiagnostic?.reason === "unsupported_model" ? "unsupported" : status === 413 ? "over_budget" : "look_failed";
      return fail({ code, reason: `Jev failed: ${firstLine(error)}`, model }, code === "unsupported" || refused ? undefined : lookTiming(call, startedAt));
    }
    const costUsd = result.cost_usd ?? null;
    const usage: Usage | null = result.usage ? { input: result.usage.input_tokens, output: result.usage.output_tokens, cacheRead: 0, cacheWrite: 0, totalTokens: result.usage.input_tokens + result.usage.output_tokens, cost: { input: costUsd ?? 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd ?? 0 } } : null;
    const facts = { ...(result.usage ? { tokens_in: result.usage.input_tokens, tokens_out: result.usage.output_tokens } : {}), cost_usd: costUsd, ...(readBack ? { kept: true as const } : {}), ...lookTiming(call, startedAt) };
    const filed = { ...at, args: { ...at.args, model: result.model ?? model }, body: JSON.stringify(mapped(result)), facts: { ...at.facts, ...facts } };
    const receipt = await fileTold(call.memo, at.facts.key, filing, (to, told) => fileLook(to, VISION_JUDGE.name, filed, { usage, costUsd, ...(told ? { kept: true } : {}) }));
    return { result, readBack, receipt, costUsd };
  });

  return { answers: mapped(result), model: result.model ?? model, costUsd, receipts: receipt ? [receipt] : [], ...(readBack || shared ? { kept: true } : {}) };
}
