// The screen: a shot is a PNG of the size it says, read whole through screen.read, and every pixel of it decodes; a
// region shot has the region's size and decodes too; on a desktop the fixture's colors are where the fixture paints them.
// The live view (provider.watch, screen.watch underneath): the first frame decodes to the size it says, of the screen
// screen.shot reads, and a pointer move is a new frame with the cursor where it went.
import { MAX_CHUNK_BYTES, type Point, type Rect, type ScreenShotResult } from "../../protocol.js";
import type { ComputerError } from "../../result.js";
import type { ScreenFrame, ScreenWatchHandlers } from "../../screen-watch.js";
import { FIXTURE_COLORS } from "../fixture.js";
import { MAX_PNG_BYTES, type Png, readPng } from "../png.js";
import type { Case, CaseContext } from "../types.js";

/** A whole screenshot: screen.shot, then screen.read from each offset until eof, then every pixel decoded. */
export async function shoot(t: CaseContext, region?: Rect): Promise<{ shot: ScreenShotResult; image: Png }> {
	const what = region ? `the shot of region ${JSON.stringify(region)}` : "the shot";
	const shot = await t.call("screen.shot", region ? { region } : {});
	// No accepted PNG is larger than MAX_PNG_BYTES: a shot that says it is is refused before it is read, and the loop below
	// reads no further than the size it says, so no more than MAX_PNG_BYTES is ever held.
	t.assert(shot.size <= MAX_PNG_BYTES, `${what}: screen.shot says ${shot.size} bytes, more than ${MAX_PNG_BYTES} bytes, the largest PNG the suite reads`);
	const first = Buffer.from(shot.data, "base64");
	t.assert(first.length <= MAX_CHUNK_BYTES, `${what}: screen.shot gave ${first.length} bytes, over MAX_CHUNK_BYTES`);
	const parts = [first];
	let offset = first.length;
	let eof = shot.eof;
	while (!eof) {
		t.assert(offset < shot.size, `${what}: ${offset} bytes read of ${shot.size}, and still no eof`);
		const read = await t.call("screen.read", { id: shot.id, offset });
		const data = Buffer.from(read.data, "base64");
		t.assert(data.length > 0 || read.eof, `${what}: screen.read at ${offset} gave no bytes and no eof`);
		t.assert(data.length <= MAX_CHUNK_BYTES, `${what}: screen.read gave ${data.length} bytes, over MAX_CHUNK_BYTES`);
		parts.push(data);
		offset += data.length;
		eof = read.eof;
	}
	const png = Buffer.concat(parts);
	t.equal(png.length, shot.size, `${what}: the bytes read, against its size`);
	let image: Png;
	try {
		image = readPng(png);
	} catch (error) {
		throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { shot, image };
}

const QUADRANTS = ["top left", "top right", "bottom left", "bottom right"];

export const screenCases: Case[] = [
	{
		id: "screen.screenshot-size",
		level: "core",
		group: "screen",
		needs: ["screen"],
		async run(t) {
			const { shot, image } = await shoot(t);
			t.assert(shot.width > 0 && shot.height > 0, `the shot is ${shot.width}x${shot.height}`);
			t.deepEqual([image.width, image.height], [shot.width, shot.height], "the PNG's size (IHDR), against the shot's width and height");
			t.assert(typeof shot.scale === "number" && shot.scale > 0, `scale is a number above 0, not ${JSON.stringify(shot.scale)}`);
			const region: Rect = [Math.floor(shot.width / 4), Math.floor(shot.height / 4), Math.max(1, Math.floor(shot.width / 2)), Math.max(1, Math.floor(shot.height / 2))];
			const part = await shoot(t, region);
			t.deepEqual([part.image.width, part.image.height], [region[2], region[3]], `the PNG of region ${JSON.stringify(region)}: its size (IHDR)`);
			t.deepEqual([part.shot.width, part.shot.height], [region[2], region[3]], `the shot of region ${JSON.stringify(region)}: its width and height`);
			if (t.provider.capabilities().kind !== "desktop") return;
			const fixture = await t.fixture();
			const [x, y, w, h] = fixture.bounds;
			const painted = (await shoot(t)).image;
			for (const [i, [fx, fy]] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].entries()) {
				const px = Math.floor(x + (fx as number) * w);
				const py = Math.floor(y + (fy as number) * h);
				t.deepEqual(painted.rgb(px, py), FIXTURE_COLORS[i], `the fixture's ${QUADRANTS[i]} quadrant, at (${px}, ${py})`);
			}
		},
	},
	{
		id: "screen.watch",
		level: "core",
		group: "screen",
		needs: ["screen"],
		async run(t) {
			const { shot } = await shoot(t);
			const watcher = t.provider.watch;
			t.assert(watcher !== undefined, "the provider has no watch(): a computer with a screen gives its live view through it");
			// The live view, as the runner's viewer opens it: frames to a handler, each acked before the next.
			const frames: ScreenFrame[] = [];
			let ack: (() => void) | undefined;
			let ended: ComputerError | undefined;
			let wake: (() => void) | undefined;
			const handlers: ScreenWatchHandlers = {
				frame(frame, given) {
					frames.push(frame);
					ack = given;
					wake?.();
				},
				ended(error) {
					ended = error;
					wake?.();
				},
			};
			const watch = t.ok(await (watcher as NonNullable<typeof watcher>).call(t.provider, t.ref, handlers, { signal: t.signal }), "watch");
			try {
				let taken = 0;
				/** The next frame not yet taken, acking the one taken before it: within ms, or undefined. */
				const nextWithin = async (ms: number): Promise<ScreenFrame | undefined> => {
					if (frames.length === taken) {
						const arrived = new Promise<void>((resolve) => (wake = resolve));
						// The frame taken last is drawn: ack it, and the next is asked for.
						const given = ack;
						ack = undefined;
						given?.();
						if (frames.length === taken && ended === undefined) await within(arrived, ms, "a frame");
					}
					t.assert(ended === undefined, `the watch ended: ${ended?.code}: ${ended?.message}`);
					return frames.length > taken ? frames[taken++] : undefined;
				};
				const next = async (what: string): Promise<ScreenFrame> => {
					const got = await nextWithin(t.patience);
					t.assert(got !== undefined, `${what}: no frame within ${t.patience} ms`);
					return got as ScreenFrame;
				};
				const first = await next("the first frame");
				t.assert(first.seq >= 1, `the first frame's seq is ${first.seq}, not 1 or more`);
				t.assert(first.format === "jpeg" || first.format === "png", `the first frame's format is ${JSON.stringify(first.format)}, not jpeg or png`);
				let w: number;
				let h: number;
				try {
					[w, h] = decodedSize(first.bytes, first.format);
				} catch (error) {
					throw new Error(`the first frame's ${first.format.toUpperCase()} does not decode: ${error instanceof Error ? error.message : String(error)}`);
				}
				t.assert(w === first.frameWidth && h === first.frameHeight, `the first frame's ${first.format.toUpperCase()} is ${w}x${h}, not the ${first.frameWidth}x${first.frameHeight} it says`);
				t.deepEqual([first.width, first.height], [shot.width, shot.height], "the frame's screen size (the input space), against screen.shot's");
				t.assert(first.frameWidth <= first.width, `the frame is ${first.frameWidth} wide, wider than the ${first.width}-pixel screen`);
				// A pointer move is a new frame (the cursor is part of what a frame shows), with the cursor where it went.
				if (!t.hello.groups.includes("input.pointer")) return;
				const at: Point = first.cursor?.[0] === Math.floor(first.width / 3) ? [Math.floor(first.width / 3) + 1, Math.floor(first.height / 3)] : [Math.floor(first.width / 3), Math.floor(first.height / 3)];
				t.deepEqual(t.ok(await watch.input([{ type: "move", at }]), `input: a pointer move to ${at}`), { done: 1 }, `input: a pointer move to ${at}`);
				let moved: ScreenFrame | undefined;
				const until = t.clock.now() + t.patience;
				// A desktop may change on its own (a clock): the frame the move made is the first with the cursor there, and a
				// frame with no cursor, or with it elsewhere, is not it.
				const there = (frame: ScreenFrame) => frame.cursor?.[0] === at[0] && frame.cursor?.[1] === at[1];
				while (moved === undefined || !there(moved)) {
					const left = until - t.clock.now();
					const got = left > 0 ? await nextWithin(left) : undefined;
					if (moved === undefined) t.assert(got !== undefined, `a pointer move to ${at} gave no new frame within ${t.patience} ms`);
					else t.assert(got !== undefined, `a pointer move to ${at} gave no frame with the cursor there within ${t.patience} ms: the last frame's cursor is ${moved.cursor ? moved.cursor.join(",") : "missing"}`);
					moved = got as ScreenFrame;
				}
				t.assert(moved.seq > first.seq, `the frame after the move is seq ${moved.seq}, not past ${first.seq}`);
			} finally {
				await watch.close();
			}
		},
	},
];

/** promise's value, or undefined once ms passed first. */
async function within<T>(promise: Promise<T>, ms: number, _what: string): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([promise, new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The width and height of a frame that decodes, or a throw in words. A PNG is decoded whole (every pixel, readPng). A
 * JPEG is walked to its end, with no decoder in the suite: its start, its segments each inside the bytes, a frame header
 * (SOF) and a quantization table (DQT) before its first scan, entropy-coded data in each scan, and its end (EOI) last.
 */
function decodedSize(bytes: Uint8Array, format: "jpeg" | "png"): [number, number] {
	if (format === "png") {
		const png = readPng(bytes);
		return [png.width, png.height];
	}
	return jpegSize(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/** A JPEG's width and height once its structure is whole; see decodedSize. */
function jpegSize(b: Buffer): [number, number] {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error("it lacks the JPEG start (SOI)");
	let size: [number, number] | undefined;
	let tables = false;
	let scans = 0;
	for (let i = 2; ; ) {
		if (i + 2 > b.length || b[i] !== 0xff) throw new Error(`byte ${i} is not a marker, and the JPEG has not ended (EOI)`);
		const marker = b[i + 1] as number;
		if (marker === 0xd9) {
			if (scans === 0) throw new Error("it ends with no scan (SOS): it holds no pixels");
			if (i + 2 !== b.length) throw new Error(`${b.length - i - 2} bytes follow its end (EOI)`);
			if (size === undefined || size[0] === 0 || size[1] === 0) throw new Error("its frame header (SOF) gives no size");
			return size;
		}
		if (i + 4 > b.length) throw new Error(`its segment at byte ${i} runs past the end, with no scan (SOS) whole`);
		const length = b.readUInt16BE(i + 2);
		if (length < 2 || i + 2 + length > b.length) throw new Error(`its segment at byte ${i} runs past the end, with no scan (SOS) whole`);
		// SOF0 to SOF15, but DHT (C4), JPG (C8) and DAC (CC): the frame's height, then its width.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (length < 8) throw new Error(`its frame header (SOF) at byte ${i} is ${length} bytes, too short`);
			size = [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
		}
		if (marker === 0xdb) tables = true;
		i += 2 + length;
		if (marker !== 0xda) continue;
		if (size === undefined) throw new Error("its scan (SOS) comes before a frame header (SOF)");
		if (!tables) throw new Error("its scan (SOS) comes before a quantization table (DQT)");
		// The entropy-coded data runs to the next marker: inside it, 0xFF is followed by 0x00 (a stuffed byte) or a
		// restart marker (D0 to D7).
		const start = i;
		while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && !((b[i + 1] as number) >= 0xd0 && (b[i + 1] as number) <= 0xd7))) i++;
		if (i === start) throw new Error(`its scan at byte ${start} holds no data: no pixels`);
		if (i + 1 >= b.length) throw new Error("its scan runs to the last byte, with no end (EOI)");
		scans++;
	}
}
