// A miss is text the model can act on (`isError: false`), a failed receipt and an event for the host: what could not
// be done, why, and what still works or how to narrow the request. A refusal of the arguments themselves is an error.

import type { MissCode } from "./contract.js";
import { fileLook, quietly, type Filing, type LookRecord } from "./evidence.js";
import type { ToolResult } from "./host.js";

/** One read or look that could not give the model what it asked for, for the host's rows. */
export type MissEvent = {
  readonly conversationId: string;
  /** `read` or `vision.see`, or the tool whose result held the image (`CallContext.tool`). */
  readonly tool: string;
  readonly source: string;
  readonly ask?: string;
  readonly code: MissCode;
  /** The first line of the cause, as the model reads it. */
  readonly reason: string;
  /** The eyes' model, when eyes were asked. */
  readonly model?: string;
  readonly receipt: string | null;
};

/** Why a look did not happen: the code, the cause in one line, and the eyes' model when eyes were asked. */
export type Miss = { readonly code: MissCode; readonly reason: string; readonly model?: string };

/** What the model can do about each miss. */
export const MISS_ACTION: Readonly<Record<MissCode, string>> = Object.freeze({
  no_vision_route: "The operator's fix is to give this host eyes (a vision model that accepts images), or to run a model that accepts images. Until then, work from the saved file with bash (OCR, pixel statistics, metadata).",
  look_failed: "Read it again to retry the look, or work from the saved file with bash (OCR, pixel statistics, metadata).",
  video_unseeable: "Read a shorter from_s..to_s window, or extract frames with bash (ffmpeg) and read them as images.",
  over_budget: "Read a smaller part of it (one page with page, a shorter from_s..to_s window), or crop or scale it with bash and read the result.",
  needs: "What does not need it still reads; to have the rest, install it where the shell runs, or work from the saved file with bash.",
  unsupported: "Work from the saved file with bash (file, a converter to a kind read takes), then read the result.",
  unreadable: "The file is damaged or protected; check it with bash (file, its own tools) before reading it again.",
  not_ready: "Read it again in a minute.",
  refused: "This host does not allow it; go on without it.",
});

/** Characters that may close around a link inside a word: quotes, brackets, and the punctuation after it. */
const LINK_TAIL = "\"'`)]}>,.;:!?";

/** The schemes of a link that is cut: web pages and web sockets. */
const LINK_SCHEMES = ["https://", "http://", "wss://", "ws://"];

/** A line with every http(s) and ws(s) link in it cut to its origin and path: a link's query, fragment and credentials
 *  (a signed link's signature, a token) never reach a result, a receipt or an event. A link may stand inside a word,
 *  quoted or bracketed or after `url=`, and its slashes may be escaped as JSON writes them (`https:\/\/`): it starts at
 *  its scheme and ends before the quotes and punctuation that close it, and it is parsed as a URL, never matched. */
export const linkSafe = (line: string): string => line.split(/(\s+)/).map((escaped) => {
  const word = escaped.split("\\/").join("/");
  const lower = word.toLowerCase();
  const at = LINK_SCHEMES.map((scheme) => lower.indexOf(scheme)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return escaped;
  let end = word.length;
  while (end > at && LINK_TAIL.includes(word[end - 1]!)) end--;
  const link = word.slice(at, end);
  // A link that does not parse cannot be cut safely, so none of it is kept.
  if (!URL.canParse(link)) return `${word.slice(0, at)}(a link)${word.slice(end)}`;
  const url = new URL(link);
  return `${word.slice(0, at)}${url.origin}${url.pathname}${word.slice(end)}`;
}).join("");

/** The first line of an error's message, its links cut to origin and path, bounded. */
export const firstLine = (error: unknown, max = 300): string => linkSafe(String((error as Error)?.message || error).split("\n")[0]!).slice(0, max);

/** A refusal of the arguments: one line, `isError: true`. */
export const refusal = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** File a miss as a failed look and tell the host. The receipt path, or null. */
export async function reportMiss(filing: Filing, tool: string, record: LookRecord, miss: Miss): Promise<string | null> {
  const receipt = await fileLook(filing, tool, { ...record, status: "failed", body: `not seen: ${miss.reason}` });
  await quietly(filing.onMiss, {
    conversationId: filing.conversationId, tool, source: record.args.path, ...(record.args.ask ? { ask: record.args.ask } : {}),
    code: miss.code, reason: miss.reason, ...(miss.model ? { model: miss.model } : {}), receipt,
  });
  return receipt;
}
