// web_save: one file from a public host saved into the run's folder, so a URL that expires (a generation service's CDN
// link) becomes a file the run keeps and the console's Files tab shows and plays. It downloads through the public-host
// guard's bytes variant (pi-browser publicDownload): every hop's name resolved, checked public and dialled at the address
// checked, ports 80 and 443 only, at most SAVE_MAX_BYTES, under one deadline for the whole file.
//
// The path is the run's Workspace's (host.workspace, else the local folder at where.work), so its refusals hold: no `..`,
// no absolute path, no link followed on the way or as the file. A bare name goes under media/. A path that already holds
// anything is refused, never overwritten, checked before the download and again before the write.
//
// The whole file is held in memory and written once, through Workspace.write (a temporary name in the same folder,
// renamed over the path on the local disk; one put on Archil's), so a download that fails, or goes past the cap, leaves
// nothing at the path. So at most SAVE_CONCURRENCY downloads run at once per runner, across its runs (SERVER_SLOTS); the
// rest wait, under their own deadline. A download holds its file's size when its host states its length, about twice that
// at its peak when it does not (publicDownload). In a Mode 2 run's own process the write crosses to the runner in pieces
// and the runner writes it (runner/big-writes.ts), under a gate of its own.
//
// The type is checked against the bytes: a media type the server plays (file-types.ts) is saved only when its bytes
// carry that type's signature (MEDIA), and the path's extension must name a type that agrees: the type is not stored, the
// console and the file route take it from the extension. Anything else (a page, a PDF, text) is saved only to a path
// whose extension names exactly the type the host declared.
import { extname } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import type { TSchema } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PublicFetchOptions } from "@parcha/pi-browser";
import { extensionOf, typeOf } from "./file-types.js";
import { clip, URL_MAX } from "./web-fetch-direct.js";
import { forModel } from "./result.js";
import { isWorkspaceError, type Workspace, workspaceErrorWords } from "./workspace/index.js";

export const WEB_SAVE_TOOL = "web_save";
/** The most bytes a saved file may have. */
export const SAVE_MAX_BYTES = 200 * 1024 * 1024;
/** One deadline for a whole download: a 200 MiB file at about 350 KB/s. A page's 30 s (web-fetch-direct.ts) would cut a
 *  large file on any link under about 7 MB/s. */
export const SAVE_TIMEOUT_MS = 600_000;
/** The folder a bare name is saved in. */
export const MEDIA_DIR = "media";
/** The longest path web_save takes, and the most characters of a declared type and of a failure's words an answer
 *  carries: with the URL's URL_MAX, they bound every answer (host-bounds.test.mjs). */
export const PATH_MAX_CHARS = 1_024;
export const TYPE_MAX_CHARS = 255;
export const WORDS_MAX_CHARS = 2_000;

export type Saved = { ok: true; path: string; bytes: number; content_type: string; url: string };
export type Unsaved = { ok: false; url: string; path?: string; refused: string } | { ok: false; url: string; path?: string; error: string };
/** The guard's resolver and fetch (a test's, or the fakes'), the caller's signal, a lower cap, and other slots than the
 *  server's (a test's). */
export type SaveOptions = Omit<PublicFetchOptions, "maxBytes"> & { maxBytes?: number; timeoutMs?: number; slots?: SaveSlots };

/** The most web_save downloads held in memory at once (at most SAVE_MAX_BYTES each). */
export const SAVE_CONCURRENCY = 4;
/** Slots for downloads, handed out first come first served. `take` answers the slot's release (once), or rejects with
 *  the signal's reason if it aborts first, leaving the queue. */
export type SaveSlots = { readonly size: number; readonly busy: number; readonly waiting: number; take(signal: AbortSignal): Promise<() => void> };
export function saveSlots(size: number): SaveSlots {
  let busy = 0;
  const queue: Array<() => void> = [];
  const releaser = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      // The slot goes straight to the next waiter, so busy only drops when no one waits.
      const next = queue.shift();
      if (next) next();
      else busy--;
    };
  };
  return {
    size,
    get busy() { return busy; },
    get waiting() { return queue.length; },
    take(signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (busy < size) {
        busy++;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve, reject) => {
        const leave = () => {
          queue.splice(queue.indexOf(grant), 1);
          reject(signal.reason);
        };
        const grant = () => {
          signal.removeEventListener("abort", leave);
          resolve(releaser());
        };
        queue.push(grant);
        signal.addEventListener("abort", leave, { once: true });
      });
    },
  };
}
/** The runner's one gate: at most SAVE_CONCURRENCY downloads at once per runner, across its runs. A run in the runner's
 *  own process takes it here; a run in a process of its own takes it over its channel (runner/save-slots.ts). */
export const SERVER_SLOTS = saveSlots(SAVE_CONCURRENCY);

/** A media type the server plays, by its signature: `types`, the types those bytes may be declared or named as, the first
 *  the one they are answered as. */
type Kind = { types: readonly string[]; test: (b: Uint8Array) => boolean };
const ascii = (b: Uint8Array, at: number, text: string) => b.length >= at + text.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
const MEDIA: readonly Kind[] = [
  { types: ["image/png"], test: (b) => b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x) },
  { types: ["image/jpeg"], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { types: ["image/gif"], test: (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a") },
  { types: ["image/webp"], test: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") },
  { types: ["audio/wav"], test: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE") },
  // An ID3 tag, or an MPEG audio frame's sync: eleven set bits, then a layer that is not the reserved 00 (which is AAC's).
  { types: ["audio/mpeg"], test: (b) => ascii(b, 0, "ID3") || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) },
  { types: ["audio/ogg"], test: (b) => ascii(b, 0, "OggS") },
  // ISO media: an ftyp box first. Its brand says audio (M4A, M4B) or not; either type may be declared or named.
  { types: ["video/mp4", "audio/mp4"], test: (b) => ascii(b, 4, "ftyp") && !(ascii(b, 8, "M4A ") || ascii(b, 8, "M4B ")) },
  { types: ["audio/mp4", "video/mp4"], test: (b) => ascii(b, 4, "ftyp") },
  // EBML: WebM (and Matroska).
  { types: ["video/webm", "audio/webm"], test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];
/** Every type MEDIA checks: one of these declared must carry its signature. */
const MEDIA_TYPES = new Set(MEDIA.flatMap((kind) => kind.types));
/** Names hosts give some of those types besides the one file-types.ts serves. */
const ALIASES: ReadonlyMap<string, string> = new Map([["image/jpg", "image/jpeg"], ["image/pjpeg", "image/jpeg"], ["audio/mp3", "audio/mpeg"], ["audio/x-wav", "audio/wav"], ["audio/wave", "audio/wav"], ["audio/vnd.wave", "audio/wav"], ["audio/x-m4a", "audio/mp4"], ["audio/m4a", "audio/mp4"]]);
/** Declared types that say nothing about the bytes. */
const UNTYPED = new Set(["", "application/octet-stream", "binary/octet-stream", "application/binary"]);
/** A Content-Type as its bare type, lower case, its parameters dropped and its aliases resolved. */
const bare = (type: string | undefined): string => {
  const plain = (type ?? "").split(";")[0]!.trim().toLowerCase();
  return ALIASES.get(plain) ?? plain;
};

/** The type `bytes` are saved as at `path`, the host having declared `declared`, or why they are refused. */
export function typeFor(bytes: Uint8Array, declared: string, path: string): { type: string } | { refused: string } {
  if (declared.length > TYPE_MAX_CHARS) return { refused: `refused: the host's Content-Type is longer than ${TYPE_MAX_CHARS} characters` };
  const said = bare(declared);
  const named = typeOf(path) === undefined ? undefined : bare(typeOf(path));
  const ext = path.slice(path.lastIndexOf("/") + 1).includes(".") ? path.slice(path.lastIndexOf(".")) : "";
  const kind = MEDIA.find((one) => one.test(bytes));
  if (kind) {
    const sniffed = kind.types[0]!;
    if (!UNTYPED.has(said) && !kind.types.includes(said)) return { refused: `refused: the host says ${said}, but the bytes are ${sniffed}` };
    if (named && !kind.types.includes(named)) return { refused: `refused: the path's extension ${ext} is ${named}, but the bytes are ${sniffed}; save it under an extension of that type` };
    if (!named) {
      const type = kind.types.includes(said) ? said : sniffed;
      // audio/webm has no extension of its own; .webm (video/webm) holds it.
      return { refused: `refused: ${path} has no extension of ${type}; save it as ${path.slice(0, path.length - extname(path).length)}.${extensionOf(type) ?? extensionOf(sniffed)}` };
    }
    return { type: named };
  }
  if (MEDIA_TYPES.has(said)) return { refused: `refused: the host says ${said}, but the bytes are not ${said}` };
  if (named !== undefined && named === said) return { type: said };
  return { refused: `refused: ${said ? `${said} is` : "a file with no type is"} not a media type this server plays${named ? `, and the path's extension ${ext} says ${named}` : ", and the path's extension does not say it is"}` };
}

/** A failure's words, at most WORDS_MAX_CHARS. */
const wordsOf = (error: unknown): string => clip(String((error as Error)?.message ?? error), WORDS_MAX_CHARS);

/** Where `path` is saved: as given, or under media/ when it names no folder. */
export const savePath = (path: string): string => (path.includes("/") ? path : `${MEDIA_DIR}/${path}`);

/** `args.url` downloaded and saved at `args.path` in `work`: what was saved, or why nothing was. Never throws. */
export async function webSave(args: unknown, work: Workspace, options: SaveOptions = {}): Promise<Saved | Unsaved> {
  const { url, path } = (args && typeof args === "object" ? args : {}) as { url?: unknown; path?: unknown };
  const shown = typeof url === "string" ? clip(url, URL_MAX) : "";
  if (typeof url !== "string" || !URL.canParse(url)) return { ok: false, url: shown, error: "url is not an absolute URL" };
  if (url.length > URL_MAX) return { ok: false, url: shown, error: `url is longer than ${URL_MAX.toLocaleString("en-US")} characters` };
  if (typeof path !== "string" || path === "") return { ok: false, url: shown, error: "path is required: where in the run's folder to save the file (a bare name goes under media/)" };
  if (path.length > PATH_MAX_CHARS) return { ok: false, url: shown, error: `path is longer than ${PATH_MAX_CHARS.toLocaleString("en-US")} characters` };
  const at = savePath(path);
  const failed = (error: unknown): Unsaved => {
    const words = workspaceErrorWords(error);
    if (words) return isWorkspaceError(error, "ESCAPE") || isWorkspaceError(error, "REFUSED") || isWorkspaceError(error, "EXISTS") ? { ok: false, url: shown, path: at, refused: clip(`refused: ${words}`, WORDS_MAX_CHARS) } : { ok: false, url: shown, path: at, error: clip(words, WORDS_MAX_CHARS) };
    return { ok: false, url: shown, path: at, error: wordsOf(error) };
  };
  const taken = async (): Promise<Unsaved | undefined> => {
    const there = await work.stat(at);
    return there ? { ok: false, url: shown, path: at, refused: `refused: ${at} already holds a ${there.kind === "dir" ? "folder" : there.kind === "link" ? "link" : "file"}; web_save never overwrites, so pick another path` } : undefined;
  };
  try {
    const before = await taken();
    if (before) return before;
  } catch (error) {
    return failed(error);
  }
  const { BrowserFailureError, publicDownload } = await import("@parcha/pi-browser");
  const { timeoutMs = SAVE_TIMEOUT_MS, maxBytes = SAVE_MAX_BYTES, slots = SERVER_SLOTS, ...guard } = options;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(guard.signal ? [guard.signal] : [])]);
  const cut = (error: unknown, waited: string): Unsaved => {
    const name = (error as Error)?.name;
    if (name === "TimeoutError" && !guard.signal?.aborted) return { ok: false, url: shown, path: at, error: `the download did not finish in ${timeoutMs / 1000} s${waited}` };
    return { ok: false, url: shown, path: at, error: wordsOf(error) };
  };
  let release: () => void;
  try {
    release = await slots.take(signal);
  } catch (error) {
    return cut(error, `: it waited all that time for a free download slot (at most ${slots.size} at once)`);
  }
  // The slot is held while the bytes are in memory: through the download, the type check and the write.
  try {
    let file: Awaited<ReturnType<typeof publicDownload>>;
    try {
      file = await publicDownload(url, { ...guard, maxBytes, signal });
    } catch (error) {
      if (error instanceof BrowserFailureError && error.failure.code === "refused") return { ok: false, url: shown, path: at, refused: clip(error.message, WORDS_MAX_CHARS) };
      return cut(error, "");
    }
    const final = clip(file.url, URL_MAX);
    if (file.bytes === null) return { ok: false, url: final, path: at, error: `the host answered ${file.status}` };
    const typed = typeFor(file.bytes, file.contentType, at);
    if ("refused" in typed) return { ok: false, url: final, path: at, refused: clip(typed.refused, WORDS_MAX_CHARS) };
    try {
      // Again just before the write: a file made at the path while the download ran is kept, not replaced.
      const after = await taken();
      if (after) return { ...after, url: final };
      await work.write(at, file.bytes);
    } catch (error) {
      return { ...failed(error), url: final };
    }
    return { ok: true, path: at, bytes: file.bytes.length, content_type: typed.type, url: final };
  } finally {
    release();
  }
}

/** The words the model reads: the answer's JSON. */
export const savedText = (answer: Saved | Unsaved): string => JSON.stringify(answer);

/** web_save on `work`, its download through `guard` (a test's or the fakes' resolver and fetch, none for the network), its
 *  slots `slots` (none: SERVER_SLOTS). */
export function webSaveTool(work: () => Promise<Workspace> | Workspace, guard: () => Promise<Omit<PublicFetchOptions, "maxBytes" | "signal">> | Omit<PublicFetchOptions, "maxBytes" | "signal">, slots?: SaveSlots): ToolRegistration<TSchema, JsonValue> {
  return defineTool({
    name: WEB_SAVE_TOOL,
    description: `Download one file from a public URL into this run's folder, where it stays (the run's Files show and play it): use it for a generated image, audio or video a service answered with a link that expires. path is where to save it, relative to the run's folder; a bare name (cat.png) goes under ${MEDIA_DIR}/. A path that already holds a file is refused, never overwritten. The file must be a type its bytes show: an image (png, jpeg, gif, webp), audio (mp3, wav, ogg, m4a) or video (mp4, webm), and the path must have an extension of that type (cat.png, not cat or cat.bin); any other type (a page, a PDF, text) is saved only to a path whose extension names the type the host declares. At most ${SAVE_MAX_BYTES / (1024 * 1024)} MiB and ${SAVE_TIMEOUT_MS / 60_000} minutes. A private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused, at every redirect too. Answers JSON: { ok: true, path, bytes, content_type, url } (url the final one, after redirects), or { ok: false, url, refused } when it was refused, { ok: false, url, error } when it failed; nothing is left at the path when it does not save.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "The file's absolute http(s) URL." },
        path: { type: "string", description: `Where to save it in the run's folder, e.g. ${MEDIA_DIR}/cat.png; a bare name goes under ${MEDIA_DIR}/.` },
      },
      required: ["url", "path"],
    } as unknown as TSchema,
    replay: "unsafe",
    execute: async (args, _api, context) => {
      const answer = await webSave(args, await work(), { ...(await guard()), ...(context?.abortSignal ? { signal: context.abortSignal } : {}), ...(slots ? { slots } : {}) });
      return forModel(savedText(answer), { details: answer as unknown as JsonValue });
    },
  });
}
