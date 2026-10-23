import { describe, expect, it } from "vitest";
import { errorOutput, LINE_MAX_CHARS, SAID_MAX_CHARS } from "../src/place/box-place.ts";

const OUTCOME = JSON.stringify({ outcome: { status: "complete", generation: 1 } });

describe("a runner's error output, read as it comes", () => {
	it("hands each outcome line over once, also one split across chunks, and keeps the start of the rest", () => {
		const outcomes: string[] = [];
		const read = errorOutput((line) => outcomes.push(line));
		read.push("starting\n");
		read.push(OUTCOME.slice(0, 7));
		read.push(`${OUTCOME.slice(7)}\nafter\n`);
		expect(outcomes).toEqual([OUTCOME]);
		expect(read.said()).toBe("starting\nafter");
	});

	it("holds a bounded amount whatever the runner writes: a line longer than the limit is cut, and is never an outcome", () => {
		const outcomes: string[] = [];
		const read = errorOutput((line) => outcomes.push(line));
		const chunk = "x".repeat(64 * 1024);
		// Four times the limit of one line, with no newline, then the line's end and an outcome.
		for (let n = 0; n < (4 * LINE_MAX_CHARS) / chunk.length; n += 1) {
			read.push(chunk);
			expect(read.held()).toBeLessThanOrEqual(LINE_MAX_CHARS + chunk.length + SAID_MAX_CHARS);
		}
		read.push(`{"outcome":"not one: the end of the cut line"}\n${OUTCOME}\n`);
		expect(outcomes).toEqual([OUTCOME]);
		expect(read.said()).toBe("x".repeat(SAID_MAX_CHARS));
		// Many short lines: the kept start stays at its limit.
		for (let n = 0; n < 10_000; n += 1) read.push("a line of logs\n");
		expect(read.held()).toBeLessThanOrEqual(SAID_MAX_CHARS);
	});

	it("reads an outcome the runner wrote with no newline at its end, when the output ends", () => {
		const outcomes: string[] = [];
		const read = errorOutput((line) => outcomes.push(line));
		read.push(`log\n${OUTCOME}`);
		expect(outcomes).toEqual([]);
		read.end();
		expect(outcomes).toEqual([OUTCOME]);
		expect(read.said()).toBe("log");
	});
});
