// A miss is text the model can act on (`isError: false`), a failed receipt and an event for the host: what could not
// be done, why, and what still works or how to narrow the request. A refusal of the arguments themselves is an error.

import type { MissCode } from "./contract.js";
import { fileLook, quietly, type Filing, type LookRecord } from "./evidence.js";
import type { ToolResult } from "./host.js";

/** One read or look that could not give the model what it asked for, for the host's rows. */
export type MissEvent = {
  readonly conversationId: string;
  readonly tool: "read" | "look";
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

/** The first line of an error's message, bounded. */
export const firstLine = (error: unknown, max = 300): string => String((error as Error)?.message || error).split("\n")[0]!.slice(0, max);

/** A refusal of the arguments: one line, `isError: true`. */
export const refusal = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** File a miss as a failed look and tell the host. The receipt path, or null. */
export async function reportMiss(filing: Filing, tool: "read" | "look", record: LookRecord, miss: Miss): Promise<string | null> {
  const receipt = await fileLook(filing, tool, { ...record, status: "failed", body: `not seen: ${miss.reason}` });
  await quietly(filing.onMiss, {
    conversationId: filing.conversationId, tool, source: record.args.path, ...(record.args.ask ? { ask: record.args.ask } : {}),
    code: miss.code, reason: miss.reason, ...(miss.model ? { model: miss.model } : {}), receipt,
  });
  return receipt;
}
