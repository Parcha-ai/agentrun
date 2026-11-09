// Enough of PNG for the screen cases and the phone providers, with no dependency. The reader: the size from IHDR and
// every pixel, decoded when the bytes are read, so a shot whose pixels do not decode is refused at once, not when a
// pixel is first asked for. It reads 8-bit, non-interlaced images (gray, RGB, palette, gray and alpha, RGBA) and refuses
// any other in words. What it inflates is held to the exact size IHDR gives, and IHDR to the bounds below, so a hostile
// PNG is refused, never inflated. The writer: an 8-bit RGBA PNG of a rectangle of RGBA pixels.
import { crc32, deflateSync, inflateSync } from "node:zlib";
import type { Rect } from "./protocol.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels per pixel, by color type: gray, RGB, palette, gray and alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/**
 * The largest image read: 16384 pixels a side (the largest texture or canvas a screen is drawn to on common GPUs and
 * browsers) and 2^25 pixels in all (an 8K display, 7680x4320, fits). At most 128 MiB of RGBA pixels, plus a filter byte
 * per row: a screenshot is never larger, and a larger IHDR is refused before anything is inflated.
 */
const MAX_SIDE = 16_384;
const MAX_PIXELS = 2 ** 25;
/**
 * The most bytes a PNG this reader accepts may take: every pixel as RGBA with a filter byte per row, stored with no
 * compression, plus 4 MiB for zlib's and the chunks' framing. A reader of a shot stops there.
 */
export const MAX_PNG_BYTES = MAX_PIXELS * 4 + MAX_SIDE + 4 * 1024 * 1024;

export interface Png {
	width: number;
	height: number;
	/** The pixel's red, green and blue (alpha dropped). */
	rgb(x: number, y: number): [number, number, number];
}

/** Undoes each row's filter: raw is height rows of a filter byte and stride bytes; bpp is bytes per pixel. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
	const stride = width * bpp;
	const out = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const row = out.subarray(y * stride, (y + 1) * stride);
		const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : undefined;
		if (filter === undefined || filter > 4) throw new Error(`the screenshot's PNG has filter ${filter} on row ${y}`);
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? (row[i - bpp] as number) : 0;
			const b = up ? (up[i] as number) : 0;
			const c = up && i >= bpp ? (up[i - bpp] as number) : 0;
			let predicted: number;
			if (filter === 0) predicted = 0;
			else if (filter === 1) predicted = a;
			else if (filter === 2) predicted = b;
			else if (filter === 3) predicted = (a + b) >> 1;
			else {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			row[i] = ((line[i] as number) + predicted) & 0xff;
		}
	}
	return out;
}

/**
 * Reads a PNG whole: its header, then every pixel. Throws in words when the bytes are not a PNG, when IHDR is out of
 * bounds or a format it does not read, and when the pixels do not inflate to exactly the size IHDR gives or do not decode.
 */
export function readPng(bytes: Uint8Array): Png {
	const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (data.length < 33 || !data.subarray(0, 8).equals(SIGNATURE)) throw new Error("the screenshot is not a PNG: it lacks the PNG signature");
	if (data.toString("latin1", 12, 16) !== "IHDR") throw new Error("the screenshot's PNG does not start with IHDR");
	const width = data.readUInt32BE(16);
	const height = data.readUInt32BE(20);
	const depth = data[24] as number;
	const colorType = data[25] as number;
	const interlace = data[28];
	if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
		throw new Error(`the screenshot's PNG is ${width}x${height}: the suite reads 1 to ${MAX_SIDE} pixels a side and at most ${MAX_PIXELS} pixels`);
	}
	const channels = CHANNELS[colorType];
	if (depth !== 8 || channels === undefined || interlace !== 0) {
		throw new Error(`the screenshot's PNG is bit depth ${depth}, color type ${colorType}, interlace ${interlace}: the suite reads 8-bit, non-interlaced images`);
	}
	const idat: Buffer[] = [];
	let palette: Buffer | undefined;
	for (let at = 8; at + 8 <= data.length; ) {
		const length = data.readUInt32BE(at);
		const type = data.toString("latin1", at + 4, at + 8);
		const body = data.subarray(at + 8, at + 8 + length);
		if (type === "IDAT") idat.push(body);
		else if (type === "PLTE") palette = body;
		else if (type === "IEND") break;
		at += 12 + length;
	}
	if (idat.length === 0) throw new Error("the screenshot's PNG has no IDAT");
	// The exact size of the filtered pixels: a filter byte and width * channels bytes per row, at 8 bits a channel.
	const expected = height * (width * channels + 1);
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
	} catch (error) {
		if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") throw new Error(`the screenshot's PNG inflates past the ${expected} bytes its IHDR gives`);
		throw new Error(`the screenshot's PNG does not inflate: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (raw.length !== expected) throw new Error(`the screenshot's PNG holds ${raw.length} bytes of pixels, not the ${expected} its IHDR gives`);
	const pixels = unfilter(raw, width, height, channels);
	if (colorType === 3) {
		const entries = palette === undefined ? 0 : Math.floor(palette.length / 3);
		const highest = pixels.reduce((max, index) => Math.max(max, index), 0);
		if (highest >= entries) throw new Error(`the screenshot's PNG has no palette entry ${highest}: its palette has ${entries}`);
	}
	return {
		width,
		height,
		rgb(x, y) {
			if (!(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height)) throw new Error(`pixel (${x}, ${y}) is outside the ${width}x${height} screenshot`);
			const at = (y * width + x) * channels;
			if (colorType === 3) {
				const index = (pixels[at] as number) * 3;
				const entry = palette as Buffer;
				return [entry[index] as number, entry[index + 1] as number, entry[index + 2] as number];
			}
			if (channels <= 2) return [pixels[at] as number, pixels[at] as number, pixels[at] as number];
			return [pixels[at] as number, pixels[at + 1] as number, pixels[at + 2] as number];
		},
	};
}

/** An 8-bit RGBA PNG, non-interlaced, of rect of a width-wide RGBA frame. */
export function encodePng(rgba: Buffer, width: number, [x, y, w, h]: Rect): Buffer {
	const rows = Buffer.alloc((w * 4 + 1) * h);
	for (let row = 0; row < h; row++) {
		const from = ((y + row) * width + x) * 4;
		rgba.copy(rows, row * (w * 4 + 1) + 1, from, from + w * 4);
	}
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typed) >>> 0);
		return Buffer.concat([length, typed, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 6, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** rect of a read PNG, as an RGBA PNG of its own, every pixel opaque. */
export function cropPng(png: Png, [x, y, w, h]: Rect): Buffer {
	const rgba = Buffer.alloc(w * h * 4);
	for (let row = 0; row < h; row++) {
		for (let column = 0; column < w; column++) rgba.set([...png.rgb(x + column, y + row), 255], (row * w + column) * 4);
	}
	return encodePng(rgba, w, [0, 0, w, h]);
}
