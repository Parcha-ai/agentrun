// What `vision.see` and `vision.judge` share: the media a code-mode request names (image blocks, then files read through
// the call's environment, each named by its fragment), the miss that is filed, told and thrown, and the work for one
// look key done once at a time per call. Internal: the package's index does not export this module.

import type { MissCode } from "./contract.js";
import { visionContext, type VisionEnv } from "./env.js";
import { blocksSha256, type Filing, type LookRecord } from "./evidence.js";
import { formatFragment, parseCitation } from "./fragments.js";
import type { CallContext, CallSetup, ImageContent } from "./host.js";
import type { ImageProcessor } from "./image.js";
import { sniffKind, SNIFF_BYTES, type Kind } from "./kinds.js";
import { SOURCE_BYTES_IN_PROCESS } from "./limits.js";
import { firstLine, linkSafe, reportMiss, type Miss } from "./misses.js";
import { sha256Hex } from "./primitives.js";
import { pathSafe } from "./paths.js";

/** A look `vision.see` or `vision.judge` could not make, thrown once it is filed and told; the message starts with the code. */
export class SeeMiss extends Error {
  constructor(readonly code: MissCode, reason: string) { super(`${code}: ${reason}`); this.name = "SeeMiss"; }
}

/** A processor that fits nothing: an image within the limits passes as it is, any other is refused. */
export const AS_IS: ImageProcessor = { prepare: async () => undefined };

/** The media fields of a code-mode request: `fragments[i]` names medium `i`, the images first and then the paths. */
export type MediaRequest = { readonly images?: readonly ImageContent[]; readonly paths?: readonly string[]; readonly fragments?: readonly string[] };
export type Medium = { readonly bytes: Uint8Array; readonly mimeType: string; readonly fragment: string };

/** What a miss with no block in a request is about: the medium as the agent named it, the kind it reads as, the hash
 *  of its bytes ("" when none were read), and the window or page its name cites; or the request's media before any is
 *  read. */
export type About = { readonly path: string; readonly kind: Kind; readonly sha256: string; readonly fragment: string };
/** A miss on its way to being filed, with the medium it is about when it is about one. */
export type MediaMiss = Miss & { readonly about?: About };
/** The window or page a medium's name cites (`clip.mp4#t=60,90`), "" when it cites none. */
const citedFragment = (label: string) => {
  const cited = parseCitation(label).fragment;
  try { return cited ? formatFragment(cited) : ""; } catch { return ""; }
};
export const aboutMedium = (label: string, kind: Kind, bytes?: Uint8Array): About => ({ path: label, kind, sha256: bytes ? sha256Hex(bytes) : "", fragment: citedFragment(label) });
/** Each medium's name: an image's fragment or `image <n>`, then a path's fragment or the path. */
const labelsOf = (r: MediaRequest) => [...(r.images ?? []).map((_, i) => r.fragments?.[i] ?? `image ${i + 1}`), ...(r.paths ?? []).map((path, i) => r.fragments?.[(r.images?.length ?? 0) + i] ?? path)];
/** Before any medium is read, a miss is about the request's media as named: their kind and bytes are known only when
 *  every one is a block. */
export function requestedAbout(r: MediaRequest): About {
  const labels = labelsOf(r);
  const blocksOnly = !r.paths?.length && r.images ? r.images : undefined;
  return {
    path: labels.join(", "), kind: blocksOnly ? (blocksOnly.some((b) => b.mimeType.startsWith("video/")) ? "video" : "image") : "unknown",
    sha256: blocksOnly ? blocksSha256(blocksOnly) : "", fragment: labels.length === 1 ? citedFragment(labels[0]!) : "",
  };
}

const strings = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((s) => typeof s === "string"));
const blocks = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((b) => b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string"));

/** Whether `r` names at least one image block or path, each well formed. */
export const namesMedia = (r: Record<string, unknown>): boolean =>
  blocks(r.images) && strings(r.paths) && strings(r.fragments) && (Array.isArray(r.images) ? r.images.length : 0) + (Array.isArray(r.paths) ? r.paths.length : 0) > 0;

/** A miss filed as a failed look and told, then thrown. A stopped call files none: what failed was the stop (a
 *  cancelled read, say), not the source or the model; it rejects with the stop's reason. */
export async function throwMiss(filing: Filing, tool: string, call: CallContext, cause: Miss, record: LookRecord): Promise<never> {
  if (call.signal?.aborted) throw call.signal.reason;
  const reason = pathSafe(linkSafe(cause.reason));
  await reportMiss(filing, tool, record, { ...cause, reason });
  throw new SeeMiss(cause.code, reason);
}

/** The request's media: its image blocks, then its files read through `env`, each checked as an image or a video and
 *  against the host's policy. `fail` files and throws the miss for a file that cannot be used. */
export async function gatherMedia(request: MediaRequest, env: VisionEnv | undefined, call: CallContext, setup: CallSetup, tool: "vision.see" | "vision.judge", fail: (cause: MediaMiss) => Promise<never>): Promise<Medium[]> {
  const ctx = visionContext(call.signal);
  const labels = labelsOf(request);
  const readPath = async (path: string, label: string): Promise<Omit<Medium, "fragment">> => {
    const unread = aboutMedium(label, "unknown");
    if (!env) return fail({ code: "refused", reason: `${path} cannot be read: this host gives ${tool} no environment; pass the image as a block`, about: unread });
    const info = await env.fileInfo(path, ctx);
    if (!info.ok || info.value.kind !== "file") return fail({ code: "unreadable", reason: `${path} is not a file that opens${info.ok ? "" : ` (${firstLine(info.error)})`}`, about: unread });
    if (info.value.size > SOURCE_BYTES_IN_PROCESS) return fail({ code: "over_budget", reason: `${path} is ${info.value.size} bytes, over the ${SOURCE_BYTES_IN_PROCESS} read into this process; cut it smaller first`, about: unread });
    const read = await env.readBinaryFile(path, ctx);
    if (!read.ok) return fail({ code: "unreadable", reason: `${path} could not be read (${firstLine(read.error)})`, about: unread });
    const sniffed = sniffKind(read.value.subarray(0, SNIFF_BYTES), path);
    if (!sniffed.ok) return fail({ ...sniffed, about: aboutMedium(label, "unknown", read.value) });
    if (sniffed.kind !== "image" && sniffed.kind !== "video") return fail({ code: "unsupported", reason: `${path} reads as ${sniffed.kind}, not an image or a video; render its pages or cut its frames to images first`, about: aboutMedium(label, sniffed.kind, read.value) });
    const allowed = setup.allow?.({ path, kind: sniffed.kind, tool }) ?? true;
    if (allowed !== true) return fail({ code: "refused", reason: allowed, about: aboutMedium(label, sniffed.kind, read.value) });
    return { bytes: read.value, mimeType: sniffed.mimeType ?? "application/octet-stream" };
  };
  const media: Medium[] = (request.images ?? []).map((image, i) => ({ bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType, fragment: labels[i]! }));
  for (const path of request.paths ?? []) { const label = labels[media.length]!; media.push({ ...(await readPath(path, label)), fragment: label }); }
  return media;
}

/** The work each call (by its memo port) has in flight, by key. */
const inFlight = new WeakMap<object, Map<string, Promise<unknown>>>();

/** `work` for `key`, once at a time per call: a second ask while the first runs waits for it, alone paying, filing and
 *  telling, and is told it `shared`. */
export async function once<T>(call: CallContext, key: string, work: () => Promise<T>): Promise<{ readonly value: T; readonly shared: boolean }> {
  const flying = (call.memo && inFlight.get(call.memo)) || new Map<string, Promise<unknown>>();
  if (call.memo) inFlight.set(call.memo, flying);
  const running = flying.get(key) as Promise<T> | undefined;
  if (running) return { value: await running, shared: true };
  const started = work();
  const done = () => flying.delete(key);
  flying.set(key, started);
  started.then(done, done);
  return { value: await started, shared: false };
}
