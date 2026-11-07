// Enough of PNG for the screen cases: the size from IHDR, and the color of a pixel from 8-bit images, with no
// dependency. Interlaced and 16-bit images give their size and refuse pixels in words.
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Channels per pixel, by color type: gray, RGB, palette, gray and alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface Png {
	width: number;
	height: number;
	/** The pixel's red, green and blue (alpha dropped). Throws in words for an image it cannot decode. */
	rgb(x: number, y: number): [number, number, number];
}

/** Reads a PNG's header, and its pixels when they are asked for; throws in words when bytes are not a PNG. */
export function readPng(bytes: Uint8Array): Png {
	const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (data.length < 33 || !data.subarray(0, 8).equals(SIGNATURE)) throw new Error("the screenshot is not a PNG: it lacks the PNG signature");
	if (data.toString("latin1", 12, 16) !== "IHDR") throw new Error("the screenshot's PNG does not start with IHDR");
	const width = data.readUInt32BE(16);
	const height = data.readUInt32BE(20);
	const depth = data[24] as number;
	const colorType = data[25] as number;
	const interlace = data[28];
	let pixels: Buffer | undefined;
	let palette: Buffer | undefined;
	const decode = (): Buffer => {
		if (pixels !== undefined) return pixels;
		const channels = CHANNELS[colorType];
		if (depth !== 8 || channels === undefined || interlace !== 0) {
			throw new Error(`the screenshot's PNG is bit depth ${depth}, color type ${colorType}, interlace ${interlace}: the suite reads 8-bit, non-interlaced images`);
		}
		const idat: Buffer[] = [];
		for (let at = 8; at + 8 <= data.length; ) {
			const length = data.readUInt32BE(at);
			const type = data.toString("latin1", at + 4, at + 8);
			const body = data.subarray(at + 8, at + 8 + length);
			if (type === "IDAT") idat.push(body);
			else if (type === "PLTE") palette = body;
			else if (type === "IEND") break;
			at += 12 + length;
		}
		const raw = inflateSync(Buffer.concat(idat));
		const stride = width * channels;
		if (raw.length < height * (stride + 1)) throw new Error(`the screenshot's PNG holds ${raw.length} bytes of pixels, short of ${height * (stride + 1)}`);
		const out = Buffer.alloc(height * stride);
		for (let y = 0; y < height; y++) {
			const filter = raw[y * (stride + 1)];
			const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
			const row = out.subarray(y * stride, (y + 1) * stride);
			const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : undefined;
			for (let i = 0; i < stride; i++) {
				const a = i >= channels ? (row[i - channels] as number) : 0;
				const b = up ? (up[i] as number) : 0;
				const c = up && i >= channels ? (up[i - channels] as number) : 0;
				const value = line[i] as number;
				let predicted: number;
				if (filter === 0) predicted = 0;
				else if (filter === 1) predicted = a;
				else if (filter === 2) predicted = b;
				else if (filter === 3) predicted = (a + b) >> 1;
				else if (filter === 4) {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
				} else throw new Error(`the screenshot's PNG has filter ${filter} on row ${y}`);
				row[i] = (value + predicted) & 0xff;
			}
		}
		pixels = out;
		return out;
	};
	return {
		width,
		height,
		rgb(x, y) {
			if (!(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height)) throw new Error(`pixel (${x}, ${y}) is outside the ${width}x${height} screenshot`);
			const all = decode();
			const channels = CHANNELS[colorType] as number;
			const at = (y * width + x) * channels;
			if (colorType === 3) {
				const index = all[at] as number;
				if (palette === undefined || palette.length < (index + 1) * 3) throw new Error(`the screenshot's PNG has no palette entry ${index}`);
				return [palette[index * 3] as number, palette[index * 3 + 1] as number, palette[index * 3 + 2] as number];
			}
			if (channels <= 2) return [all[at] as number, all[at] as number, all[at] as number];
			return [all[at] as number, all[at + 1] as number, all[at + 2] as number];
		},
	};
}
