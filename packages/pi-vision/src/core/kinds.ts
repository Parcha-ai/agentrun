// What a source is: decided from its first bytes, then its extension; a mismatch is an `unsupported` miss that names
// both. Header sizes (PNG, JPEG, GIF, WebP, BMP, TIFF) are read here without decoding, with the EXIF orientation of
// the formats that carry one, and the decode guard refuses a header that claims more than `DECODE_GUARD_PIXELS` before
// any decoder runs.

import { DECODE_GUARD_PIXELS } from "./limits.js";

export const KINDS = Object.freeze(["image", "pdf", "office", "sheet", "video", "recording", "text", "unknown"] as const);
/** `office` is a word processor or slide document, `sheet` a spreadsheet, `recording` a handle such as `session:<id>`,
 *  `text` a file the host's own text read serves. */
export type Kind = (typeof KINDS)[number];

/** Bytes of a file's head that `sniffKind` and `imageHeader` read: a JPEG's size sits after its metadata segments. */
export const SNIFF_BYTES = 1 << 20;
/** A file with no NUL byte in this many leading bytes is text. */
const TEXT_PROBE_BYTES = 8192;
/** Chunks of an extended WebP walked in search of its EXIF chunk, which follows the image data: a still has a handful. */
const WEBP_CHUNKS_MAX = 64;
/** Byte order marks of the Unicode encodings whose text holds NUL bytes. UTF-32 LE (FF FE 00 00) starts with UTF-16 LE's
 *  (FF FE), so it comes first. Text without a mark is not guessed at. */
const NUL_TEXT_BOMS: readonly (readonly number[])[] = [[0xff, 0xfe, 0, 0], [0, 0, 0xfe, 0xff], [0xff, 0xfe], [0xfe, 0xff]];
/** A PDF's signature may follow this many bytes of junk. */
const PDF_SIGNATURE_WINDOW = 1024;
/** Brands of an ISO base media file that make it a HEIF image; any other makes it a video. */
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];

/** What the bytes are: how a message names them, the kind they make on their own, and their MIME type. A zip archive
 *  and an OLE2 container hold many kinds; only the file's name says which. */
const FORMATS = {
  png: ["a PNG image", "image", "image/png"], jpeg: ["a JPEG image", "image", "image/jpeg"], gif: ["a GIF image", "image", "image/gif"],
  webp: ["a WebP image", "image", "image/webp"], bmp: ["a BMP image", "image", "image/bmp"], tiff: ["a TIFF image", "image", "image/tiff"],
  heic: ["a HEIC image", "image", "image/heic"], avif: ["an AVIF image", "image", "image/avif"],
  pdf: ["a PDF document", "pdf", "application/pdf"], rtf: ["an RTF document", "office", null],
  mp4: ["an MP4 video", "video", "video/mp4"], mov: ["a QuickTime video", "video", "video/quicktime"],
  webm: ["a WebM video", "video", "video/webm"], mkv: ["a Matroska video", "video", "video/x-matroska"],
  zip: ["a zip archive", "unknown", null], ole2: ["an OLE2 container (a legacy Office file)", "unknown", null],
  empty: ["an empty file", "text", null], text: ["text", "text", null], binary: ["binary data in no format this package reads", "unknown", null],
} as const satisfies Record<string, readonly [string, Kind, string | null]>;
export type SniffedFormat = keyof typeof FORMATS;

/** The kind a file name's extension claims. Text has no entry: any content can be named anything. */
const EXTENSION_KINDS = new Map<string, Kind>(Object.entries({
  image: "png jpg jpeg gif webp bmp tif tiff heic heif avif", pdf: "pdf", office: "doc docx odt rtf ppt pptx odp",
  sheet: "xls xlsx xlsm ods", video: "mp4 m4v mov webm mkv",
}).flatMap(([kind, extensions]) => extensions.split(" ").map((extension): [string, Kind] => [extension, kind as Kind])));

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => bytes.length >= at + text.length && [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
const latin1 = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
const hex = (bytes: Uint8Array): string => Array.from(bytes.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join(" ");

/** The pixels a header states, the EXIF orientation (1 to 8; 1 when the file states none) and the MIME type. `width`
 *  and `height` are the stored ones: a quarter-turn orientation (5 to 8) shows the image the other way round. */
export type ImageHeader = { readonly mimeType: string; readonly width: number; readonly height: number; readonly orientation: number };

const shape = (mimeType: string, width: number, height: number, orientation = 1): ImageHeader | null => (width > 0 && height > 0 ? { mimeType, width, height, orientation } : null);

/** The SHORT and LONG values of the tags asked for, from the first IFD of a TIFF block at `base`. */
function tiffTags(view: DataView, base: number, want: readonly number[]): Map<number, number> {
  const little = view.getUint16(base) === 0x4949;
  const tags = new Map<number, number>();
  const ifd = base + view.getUint32(base + 4, little);
  for (let i = 0, count = view.getUint16(ifd, little); i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = view.getUint16(entry, little);
    if (want.includes(tag)) tags.set(tag, view.getUint16(entry + 2, little) === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little));
  }
  return tags;
}
const orientationOf = (value: number | undefined): number => (value !== undefined && value >= 1 && value <= 8 ? value : 1);

function jpegHeader(bytes: Uint8Array, view: DataView): ImageHeader | null {
  let orientation = 1;
  for (let i = 2; i + 9 < bytes.length; ) {
    const marker = bytes[i + 1]!;
    if (bytes[i] !== 0xff || marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    // A start-of-frame segment (C0 to CF, except the DHT, JPG and DAC markers) holds the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return shape("image/jpeg", view.getUint16(i + 7), view.getUint16(i + 5), orientation);
    if (marker === 0xe1 && ascii(bytes, i + 4, "Exif\0\0")) orientation = orientationOf(tiffTags(view, i + 10, [274]).get(274));
    i += 2 + view.getUint16(i + 2);
  }
  return null;
}

function webpHeader(bytes: Uint8Array, view: DataView, whole: Uint8Array): ImageHeader | null {
  const chunk = latin1(bytes, 12, 4);
  const u24 = (at: number) => view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
  // Lossy: a 14-bit width and height after the frame start code. Lossless: both packed, less one. Extended: the canvas,
  // each side less one in 3 bytes.
  let size: [number, number];
  if (chunk === "VP8 " && bytes[23] === 0x9d) size = [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  else if (chunk === "VP8L" && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); size = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]; }
  else if (chunk === "VP8X") size = [u24(24) + 1, u24(27) + 1];
  else return null;
  let orientation = 1;
  // An extended file keeps its EXIF in a chunk of its own, after the image data; chunks are padded to an even length. The
  // walk jumps from chunk to chunk over the whole file, so it costs by chunks and not by bytes.
  const all = new DataView(whole.buffer, whole.byteOffset, whole.byteLength);
  for (let at = 12, walked = 0; chunk === "VP8X" && at + 8 <= whole.length && walked < WEBP_CHUNKS_MAX; walked++) {
    const length = all.getUint32(at + 4, true);
    if (latin1(whole, at, 4) === "EXIF") { orientation = orientationOf(tiffTags(all, at + 8 + (ascii(whole, at + 8, "Exif\0\0") ? 6 : 0), [274]).get(274)); break; }
    at += 8 + length + (length & 1);
  }
  return shape("image/webp", size[0], size[1], orientation);
}

function bmpHeader(view: DataView): ImageHeader | null {
  // The DIB header's own size is its first field: 12 for the OS/2 form (16-bit sizes), 40 to 124 for the Windows forms.
  const dib = view.getUint32(14, true);
  const os2 = dib === 12;
  if (!(os2 || (dib >= 40 && dib <= 124)) || view.getUint16(os2 ? 22 : 26, true) !== 1 || ![1, 4, 8, 16, 24, 32].includes(view.getUint16(os2 ? 24 : 28, true))) return null;
  return os2 ? shape("image/bmp", view.getUint16(18, true), view.getUint16(20, true)) : shape("image/bmp", view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
}

/** The size, orientation and MIME type a PNG, JPEG, GIF, WebP, BMP or TIFF states in its first bytes, from at most
 *  `SNIFF_BYTES` of the file (an extended WebP's EXIF chunk is looked for by chunks, past them); null when the bytes are
 *  another format or the header is cut short or states no size. */
export function imageHeader(whole: Uint8Array): ImageHeader | null {
  const bytes = whole.subarray(0, SNIFF_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n") && ascii(bytes, 12, "IHDR")) return shape("image/png", view.getUint32(16), view.getUint32(20));
    if (ascii(bytes, 0, "GIF8")) return shape("image/gif", view.getUint16(6, true), view.getUint16(8, true));
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegHeader(bytes, view);
    if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return webpHeader(bytes, view, whole);
    if (ascii(bytes, 0, "BM")) return bmpHeader(view);
    if (ascii(bytes, 0, "II*\0") || ascii(bytes, 0, "MM\0*")) {
      const tags = tiffTags(view, 0, [256, 257, 274]);
      return shape("image/tiff", tags.get(256) ?? 0, tags.get(257) ?? 0, orientationOf(tags.get(274)));
    }
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return null;
}

/** Whether a header's pixels are over what any decoder here is asked to open: a decompression bomb is refused before a
 *  decoder allocates for it. */
export const exceedsDecodeGuard = (size: { readonly width: number; readonly height: number }): boolean => size.width * size.height > DECODE_GUARD_PIXELS;

/** An ISO base media file is a HEIF image or a video by its brands: the major brand, then the compatible ones. */
function isoFormat(bytes: Uint8Array): SniffedFormat {
  const end = Math.min(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0), bytes.length, 64);
  const brands: string[] = [];
  for (let at = 8; at + 4 <= end; at += at === 8 ? 8 : 4) brands.push(latin1(bytes, at, 4));
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return "avif";
  if (brands.some((brand) => HEIC_BRANDS.includes(brand))) return "heic";
  return brands.includes("qt  ") ? "mov" : "mp4";
}

function identify(bytes: Uint8Array): SniffedFormat {
  if (bytes.length === 0) return "empty";
  if (bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n")) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "gif";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "webp";
  if (ascii(bytes, 0, "BM") && imageHeader(bytes)) return "bmp";
  if (ascii(bytes, 0, "II*\0") || ascii(bytes, 0, "MM\0*")) return "tiff";
  if (ascii(bytes, 4, "ftyp")) return isoFormat(bytes);
  if (ascii(bytes, 0, "\x1a\x45\xdf\xa3")) return latin1(bytes, 0, 64).includes("webm") ? "webm" : "mkv";
  if (ascii(bytes, 0, "PK\x03\x04") || ascii(bytes, 0, "PK\x05\x06")) return "zip";
  if (ascii(bytes, 0, "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")) return "ole2";
  if (ascii(bytes, 0, "{\\rtf")) return "rtf";
  if (latin1(bytes, 0, PDF_SIGNATURE_WINDOW + 5).includes("%PDF-")) return "pdf";
  if (NUL_TEXT_BOMS.some((bom) => bom.every((byte, i) => bytes[i] === byte))) return "text";
  return bytes.subarray(0, TEXT_PROBE_BYTES).includes(0) ? "binary" : "text";
}

/** What a source is, or why the two ways of telling disagree. `format` and `signature` (the first bytes in hex) are for
 *  a message; `kind` `unknown` is bytes in no format this package reads, which the caller reports as `unsupported`. */
export type Sniffed =
  | { readonly ok: true; readonly kind: Kind; readonly format: SniffedFormat; readonly mimeType: string | null; readonly signature: string }
  | { readonly ok: false; readonly code: "unsupported"; readonly reason: string };

/** The kind of a file from the first `SNIFF_BYTES` of it and its name. The bytes decide; the name decides only what a
 *  container (zip, OLE2) holds, by its last segment cut at the first `?` or `#`, as a name taken from a link carries a
 *  query or a fragment after its extension. A name that claims one kind over bytes of another is a miss naming both. A
 *  recording is a handle, not bytes: the host's source table decides that, never this function. */
export function sniffKind(head: Uint8Array, name: string): Sniffed {
  const format = identify(head);
  const [label, own, mimeType] = FORMATS[format];
  const base = name.split(/[\\/]/).pop()!.split(/[?#]/)[0]!;
  const extension = /\.([^.]+)$/.exec(base)?.[1]?.toLowerCase();
  const named = extension === undefined ? undefined : EXTENSION_KINDS.get(extension);
  const kind = (format === "zip" || format === "ole2") && (named === "office" || named === "sheet") ? named : own;
  if (named && named !== kind) return { ok: false, code: "unsupported", reason: `${base} has a .${extension} extension but its bytes are ${label} (first bytes ${hex(head)})` };
  return { ok: true, kind, format, mimeType, signature: hex(head) };
}
