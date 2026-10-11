// The model contract: every word the model reads from this package lives in this file. `read` keeps its name, its eight
// arguments and their descriptions exactly as hosts already ship them (a snapshot test holds every string); `look` is
// defined here and registered by no adapter yet; the static section and the miss codes are the rest of the contract.
// A host adds its own words around these (a wrapped description, a section addendum), never inside them.

export type JsonSchema = { readonly [key: string]: unknown };

/** The contract's version. It is part of every look's memo key, so a changed contract never reuses an old answer. */
export const CONTRACT_VERSION = 1;

/** The `read` arguments beyond the file tool's own (`path`, `offset`, `limit`): the question to answer about media,
 *  the window of a video, the page of a document, and the character offset into a long line. */
export const READ_MEDIA_PARAMETERS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  ask: { type: "string", description: "A question about what the image, video, video window or document page shows. The answer comes back with the media; a route that cannot see the media is answered by the harness's eyes." },
  from_s: { type: "number", description: "Video only: start of the window to look at, in seconds." },
  to_s: { type: "number", description: "Video only: end of the window to look at, in seconds (must be greater than from_s)." },
  page: { type: "integer", minimum: 1, description: "PDF or office document only: the page to read (1-based). Its text comes back; a page with no text layer, or a page read with ask, is rendered and looked at." },
  char_offset: { type: "integer", minimum: 0, description: "Characters to skip at the start of the `offset` line (0-based). A line longer than the read limit comes back in consecutive windows; continue with the offset and char_offset each window names." },
});

/** What `read` says about media, appended to the file tool's own description. */
export const READ_MEDIA_DESCRIPTION =
  " Video files (mp4, webm, mov, mkv) come back as the video, or as the from_s..to_s window of it; pass `ask` with any image, video or PDF page to have a question about it answered." +
  " A browser session's recording listed as `session:<id>` is read the same way: `ask` (and a from_s..to_s window) is answered from what the recording shows." +
  " PDFs and office documents (docx, pptx, odt and the like) read as their extracted text, paged like any file; `page` reads one page." +
  " A page with no text layer (a scan), or a read with `ask`, renders the page (default 1) and looks at it. Spreadsheets are read with bash (the read says how)." +
  " Every look is filed under evidence/ and is citable. A directory reads as a listing of its entries.";

/** The `read` arguments this contract adds, in the order a host lists them. */
export const READ_MEDIA_ARGUMENTS = Object.freeze(Object.keys(READ_MEDIA_PARAMETERS));

/** A file tool's definition with the media arguments and description added: its own description, then the media
 *  text; its own properties, then the media ones. Nothing else of the tool changes. */
export function withReadMedia<T extends { description: string; parameters?: { properties?: Record<string, unknown> } }>(tool: T): T {
  return {
    ...tool,
    description: `${tool.description}${READ_MEDIA_DESCRIPTION}`,
    parameters: { ...tool.parameters, properties: { ...(tool.parameters?.properties ?? {}), ...READ_MEDIA_PARAMETERS } },
  };
}

export type ToolContract = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** pi-durable's replay class: a `safe` call cut by a crash runs again with the same arguments. */
  readonly replay: "safe" | "unsafe";
};

/** `look`: a vision model answers a question about a file or a recording; only its words, where it looked and the
 *  price enter the caller's context. */
export const LOOK_TOOL: ToolContract = Object.freeze({
  name: "look",
  label: "Look",
  description: "Ask a vision model a question about a file or a recording and get its answer as text, with where it looked and what it cost. Use it for many pages, a long video, or one fact you need without the pixels; use read to see a file yourself. The answer marks pages as [p3] and times as [t=62]. Every look is filed under evidence/ and is citable.",
  parameters: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      source: { type: "string", description: "A workspace path, or a handle such as session:<id>." },
      ask: { type: "string", description: "The question to answer about what the file shows." },
      pages: { type: "string", description: "PDF or office document only: the pages to look at, as \"3\", \"1-5\" or \"7-\" (page 7 to the end). Without it, the document from its first page, up to the look's page limit." },
      from_s: { type: "number", description: "Video or recording only: start of the window to look at, in seconds." },
      to_s: { type: "number", description: "Video or recording only: end of the window to look at, in seconds (must be greater than from_s)." },
      region: { type: "string", description: "\"x,y,w,h\" in percent of the page, image or frame: look closer at that part of it." },
    },
    required: ["source", "ask"],
  }),
  replay: "safe",
});

/** The static section a host renders once in the system prompt. Nothing live enters it. */
export const VISION_SECTION_HEADING = "LOOKING AT FILES";
export const VISION_SECTION_TEXT = "read shows you a file: text for documents and spreadsheets, the image itself for pictures and scans, frames for video. look(source, ask) has a vision model answer a question about a file and gives you its words and what it cost: use it for many pages, long video, or when you need one fact and not the pixels. Every look is filed under evidence/ and is citable: cite the receipt, and the place as file#page=N or file#t=seconds.";

/** The section, with the host's addendum after it when there is one. */
export function visionSection(addendum?: string): string {
  const base = `${VISION_SECTION_HEADING}\n${VISION_SECTION_TEXT}`;
  return addendum?.trim() ? `${base}\n${addendum.trim()}` : base;
}

/** Why a look or a read could not give the model what it asked for. The first three are the codes hosts already write
 *  on their rows; a miss is text the model can act on, a refusal of arguments is an error. */
export const MISS_CODES = Object.freeze([
  "no_vision_route", "look_failed", "video_unseeable",
  "over_budget", "needs", "unsupported", "unreadable", "not_ready", "refused",
] as const);
export type MissCode = (typeof MISS_CODES)[number];
