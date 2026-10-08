// One record for every citable read: what the model asked for, where the page ended, when, which bytes (SHA-256 of
// the filed body), by which extractor, in which session. The host's sink files it; a page the host judges not to be
// content is filed `failed` and never cited.

export type EvidenceTool = "browser_read" | "web_fetch" | "screenshot" | "browser_downloads";

export type EvidenceRecord = {
  tool: EvidenceTool;
  /** The call's arguments, as the receipt header's `args:` line shows them. */
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
    /** browserbase_fetch, browser, backup:<tool>. */
    via?: string;
    session?: string;
    /** Seconds from the session's start to the read, so a claim can be found in the session recording. */
    recording_at_s?: number;
    /** The host's verdict on the page. */
    page_guard?: string;
  };
  body: string | Uint8Array;
  /** The filed body's extension: md, txt, html, png, jpg, pdf. */
  ext?: string;
};

export type EvidenceSink = {
  /** File `record` under the conversation's `label`. `path` is what the model is told to cite; `bodyLine` is the
   *  1-indexed line of the filed file where the body starts, when the host knows it. Null when the host files nothing. */
  file(label: string, record: EvidenceRecord): Promise<{ path: string; bodyLine?: number } | null>;
  /** The model's whole result for a filed body: `prefix` (the `url:`, `via:`, `evidence:` lines and `---`) then the
   *  body or its head. `filed` is the body as the sink stored it. Absent, the package shows a head under a character
   *  cap and one line naming the file. */
  inline?(body: string, at: { path: string | null; bodyLine: number | null; prefix: string; filed: string }): string;
};

/** Characters of a filed body shown inline when the sink has no `inline`. */
export const DEFAULT_INLINE_CHARS = 8_000;

/** The default result: `prefix`, then the whole body under the cap, else its head and one line naming the file. */
export function defaultInline(body: string, at: { path: string | null; prefix: string }): string {
  const cap = Math.max(0, DEFAULT_INLINE_CHARS - at.prefix.length);
  const where = at.path ? `the complete body is filed at ${at.path}` : "the complete body could not be filed";
  return at.prefix + (body.length <= cap ? `${body}${at.path ? `\n\n(receipt: ${at.path})` : ""}` : `${body.slice(0, cap)}\n\n(shown ${cap} of ${body.length} characters; ${where})`);
}
