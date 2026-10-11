// What a source is: decided from its first bytes, then its extension; a mismatch is an `unsupported` miss that names
// both. Header sizes (PNG, JPEG, GIF, WebP, BMP, TIFF) are read here without decoding, and the decode guard refuses a
// header that claims more than `DECODE_GUARD_PIXELS` before any decoder runs.

export const KINDS = Object.freeze(["image", "pdf", "office", "sheet", "video", "recording", "text", "unknown"] as const);
/** `office` is a word processor or slide document, `sheet` a spreadsheet, `recording` a handle such as `session:<id>`,
 *  `text` a file the host's own text read serves. */
export type Kind = (typeof KINDS)[number];
