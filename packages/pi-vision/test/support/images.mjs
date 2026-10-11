// Synthetic images the image suites build for themselves: nothing here is a real picture. Sharp is the oracle that
// decodes what the processors write; the files the package's own readers are checked against are made here.
import { randomBytes } from "node:crypto";
import sharp from "sharp";

export const raw = (width, height, fill) => {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) data.fill(fill(y), y * width * 3, (y + 1) * width * 3);
  return sharp(data, { raw: { width, height, channels: 3 } });
};

/** A PNG with grey bands `bandPx` tall, band b in shade 28 * b, so a picture of any slice says where it is from. */
export const bandedPng = (width, height, bandPx) => {
  const rows = Buffer.alloc(height);
  for (let y = 0; y < height; y++) rows[y] = Math.min(255, 28 * Math.floor(y / bandPx));
  return raw(width, height, (y) => rows[y]).png().toBuffer();
};

/** A PNG whose every row is its own random colour, so a picture of any rows says which rows of the image it holds. */
export function rowsPng(width, height) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) data.fill(randomBytes(3), y * width * 3, (y + 1) * width * 3);
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

export const flat = (width, height, background = "#3366aa") => sharp({ create: { width, height, channels: 3, background } });

/** Four corners in four colours: red top left, green top right, blue bottom left, yellow bottom right. */
export function corners(width, height) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const colour = y < height / 2 ? (x < width / 2 ? [255, 0, 0] : [0, 255, 0]) : x < width / 2 ? [0, 0, 255] : [255, 255, 0];
    data.set(colour, (y * width + x) * 3);
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

/** A 24-bit BMP of one colour, `height` negative-signed when `topDown`. */
export function bmp(width, height, { topDown = false } = {}) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const b = Buffer.alloc(54 + row * height);
  b.write("BM", 0, "latin1");
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(topDown ? -height : height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) b.set([40, 120, 200], 54 + y * row + x * 3);
  return b;
}

/** The first bytes of a PNG that claims `width` x `height` pixels: all a header-based refusal reads. */
export function pngClaiming(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

/** An ISO base media file's first box: `ftyp` with a major brand and compatible brands. */
export function ftyp(major, ...compatible) {
  const body = Buffer.concat([Buffer.from(major, "latin1"), Buffer.alloc(4), ...compatible.map((brand) => Buffer.from(brand, "latin1"))]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write("ftyp", 4, "latin1");
  return Buffer.concat([head, body, Buffer.alloc(32)]);
}

/** A WebP of `width` x `height`: lossy, lossless, or extended (an alpha channel gives the VP8X header). */
export const webp = (width, height, kind = "lossy") => sharp({ create: { width, height, channels: kind === "extended" ? 4 : 3, background: kind === "extended" ? { r: 10, g: 80, b: 160, alpha: 0.5 } : "#336699" } }).webp(kind === "lossless" ? { lossless: true } : {}).toBuffer();

/** A decoded block's size and the shade (first channel) of the pixel at (x, y). */
export const sizeOf = async (block) => { const { width, height } = await sharp(Buffer.from(block.data, "base64")).metadata(); return { width, height }; };
export async function shadeAt(block, x, y) {
  const { data, info } = await sharp(Buffer.from(block.data, "base64")).raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels];
}
export async function pixelAt(block, x, y) {
  const { data, info } = await sharp(Buffer.from(block.data, "base64")).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}
