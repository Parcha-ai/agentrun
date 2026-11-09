// The screen: a shot is a PNG of the size it says, read whole through screen.read, and every pixel of it decodes; a
// region shot has the region's size and decodes too; on a desktop the fixture's colors are where the fixture paints them.
// The stream, where a provider offers one, is an https URL that answers.
import { MAX_CHUNK_BYTES, type Rect, type ScreenShotResult } from "../../protocol.js";
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

/** A screenshot's pixels sampled on a 16 x 16 grid, with its size: two different screens differ in it. */
export async function screenPrint(t: CaseContext): Promise<string> {
	const { image } = await shoot(t);
	const samples: string[] = [];
	for (let j = 0; j < 16; j++) {
		for (let i = 0; i < 16; i++) samples.push(image.rgb(Math.floor(((i + 0.5) * image.width) / 16), Math.floor(((j + 0.5) * image.height) / 16)).join(","));
	}
	return `${image.width}x${image.height}:${samples.join(";")}`;
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
		id: "screen.stream",
		level: "full",
		group: "screen",
		needs: ["stream"],
		async run(t) {
			const stream = t.provider.stream;
			if (stream === undefined) return t.skip("the provider has no stream()");
			const streamed = t.ok(await stream.call(t.provider, t.ref, {}, { signal: t.signal }), "stream");
			const url = t.present(typeof streamed.url === "string" ? URL.parse(streamed.url) : null, `stream's url is a URL, not ${JSON.stringify(streamed.url)}`);
			// The URL may carry a token: only its origin is ever in the report.
			t.equal(url.protocol, "https:", `the stream at ${url.origin}: its scheme`);
			const answered = await t.fetch(url.href);
			t.equal(answered.status, 200, `GET of the stream at ${url.origin}`);
		},
	},
];
