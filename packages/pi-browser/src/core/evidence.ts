export type EvidenceTool = "browser_read" | "web_fetch" | "screenshot" | "browser_downloads";

export type EvidenceRecord = {
  tool: EvidenceTool;
  args: Record<string, unknown>;
  status: "ok" | "failed";
  facts: {
    requested_url?: string;
    final_url?: string;
    title?: string;
    status_code?: number;
    content_type?: string;
    /** Of the filed body bytes. */
    sha256: string;
    extractor?: "readability-md" | "inner-text" | "provider-markdown" | "raw" | "pdf-text";
    /** `browserbase_fetch`, `browser` or `backup:<tool>`. */
    via?: string;
    session?: string;
    /** From the session's start, to find the read in the session recording. */
    recording_at_s?: number;
    page_guard?: string;
  };
  body: string | Uint8Array;
  ext?: string;
};

export type EvidenceSink = {
  /** `path` is what the model cites; `bodyLine` is the 1-indexed line where the body starts; `bodyPath` is where a binary body (a capture) was
   *  written, relative to the same root as `path`. Null: nothing was filed. */
  file(label: string, record: EvidenceRecord): Promise<{ path: string; bodyLine?: number; bodyPath?: string } | null>;
  /** The model's whole result for a filed body; absent, a head under DEFAULT_INLINE_CHARS and the file's path. */
  inline?(body: string, at: { path: string | null; bodyLine: number | null; prefix: string; filed: string }): string;
};

export const DEFAULT_INLINE_CHARS = 8_000;

export function defaultInline(body: string, at: { path: string | null; prefix: string }): string {
  const cap = Math.max(0, DEFAULT_INLINE_CHARS - at.prefix.length);
  const where = at.path ? `the complete body is filed at ${at.path}` : "the complete body could not be filed";
  return at.prefix + (body.length <= cap ? `${body}${at.path ? `\n\n(receipt: ${at.path})` : ""}` : `${body.slice(0, cap)}\n\n(shown ${cap} of ${body.length} characters; ${where})`);
}
