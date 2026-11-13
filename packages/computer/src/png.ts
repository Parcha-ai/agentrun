// PNG encoding for providers that take their own screenshots as raw pixels (Orgo's desktop).
import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";
import type { Rect } from "./protocol.js";

/** zlib's deflate on its thread pool: a screen's deflate never holds this process's event loop. */
const deflateAsync = promisify(deflate);

/** An 8-bit RGBA PNG, non-interlaced, of rect of a width-wide RGBA frame. The rows are deflated off the event loop: a
 *  1080x2400 screen took about 170 ms, every request of the server this harness runs in waiting on it. */
export async function encodePng(rgba: Buffer, width: number, [x, y, w, h]: Rect): Promise<Buffer> {
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
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", await deflateAsync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
