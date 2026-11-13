// A screen is encoded as PNG with the host's event loop free. A provider that takes its own screenshots runs in the
// server's process, and a synchronous deflate of a whole screen (about 170 ms of a 1080x2400 one) held every request and
// open store transaction of the server waiting on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { encodePng } from "../dist/png.js";

/** A 1080x2400 RGBA screen: flat bands of a UI with a photo's noise in the middle. */
function screen(width = 1080, height = 2400) {
	const rgba = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4;
			const photo = y > 600 && y < 1400;
			rgba[at] = photo ? (x * 7919 + y * 104729) % 251 : (y >> 5) * 7;
			rgba[at + 1] = photo ? (x * 31 + y * 17) % 253 : x >> 3;
			rgba[at + 2] = 200;
			rgba[at + 3] = 255;
		}
	}
	return { rgba, width, height };
}

test("a screen is encoded with the event loop free: a callback queued before the encode runs while it deflates", async () => {
	const { rgba, width, height } = screen();
	let ran = false;
	setImmediate(() => {
		ran = true;
	});
	const png = await encodePng(rgba, width, [0, 0, width, height]);
	assert.ok(ran, "the event loop ran a callback while the screen was deflated");
	// Still the PNG it was: the signature, then IHDR with the rect's size, and IDAT that inflates to the filtered rows.
	assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	assert.equal(png.toString("latin1", 12, 16), "IHDR");
	assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, height]);
	const idatLength = png.readUInt32BE(33);
	assert.equal(png.toString("latin1", 37, 41), "IDAT");
	const rows = inflateSync(png.subarray(41, 41 + idatLength));
	assert.equal(rows.length, (width * 4 + 1) * height);
	assert.ok(rows.subarray(1, 1 + width * 4).equals(rgba.subarray(0, width * 4)), "the first row, after its filter byte");
});

test("a region of the screen is encoded as its own PNG", async () => {
	const { rgba, width } = screen(64, 48);
	const png = await encodePng(rgba, width, [8, 4, 16, 10]);
	assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [16, 10]);
	const rows = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
	assert.ok(rows.subarray(1, 1 + 16 * 4).equals(rgba.subarray((4 * width + 8) * 4, (4 * width + 8 + 16) * 4)));
});
