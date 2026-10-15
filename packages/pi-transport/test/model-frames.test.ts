import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { applyFrame, FrameEncoder, type FrameState, type ModelFrame } from "../src/home/frames.ts";

// The fixtures are streams captured once from pi-ai 1.2.0's own frame encoder (events in, frames out): test data, the
// wire format this package keeps writing and reading, so that frames at rest and a home on an older build still link.
const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "model-frames");
type Fixture = { events: AssistantMessageEvent[]; frames: (ModelFrame | null)[] };
const fixtures = readdirSync(DIRECTORY)
	.filter((name) => name.endsWith(".json"))
	.sort()
	.map((name) => ({ name, ...(JSON.parse(readFileSync(join(DIRECTORY, name), "utf8")) as Fixture) }));

const wire = (frame: ModelFrame | null | undefined) => JSON.stringify(frame ?? null);

describe("the model frames this package writes and reads", () => {
	it("has the five captured streams: text and thinking, a tool call, two tools, an error and an abort", () => {
		expect(fixtures.map((fixture) => fixture.name)).toEqual([
			"abort.json",
			"error.json",
			"text-and-thinking.json",
			"tool-call.json",
			"two-tools-and-text.json",
		]);
	});

	for (const fixture of fixtures) {
		it(`writes, for the events of ${fixture.name}, the same bytes pi-ai's encoder wrote`, () => {
			const encoder = new FrameEncoder();
			const written = fixture.events.map((event) => wire(encoder.encode(event)));
			expect(written).toEqual(fixture.frames.map(wire));
		});

		it(`rebuilds the frames of ${fixture.name} into the answer the events built`, () => {
			const state: FrameState = { partial: undefined, json: new Map() };
			const rebuilt: AssistantMessageEvent[] = [];
			for (const frame of fixture.frames) if (frame !== null) rebuilt.push(applyFrame(state, frame));
			// One event for each frame, of the type the frame names.
			expect(rebuilt.map((event) => event.type)).toEqual(
				fixture.frames
					.filter((frame) => frame !== null)
					.map((frame) => (frame.type === "toolcall_checkpoint" ? "toolcall_delta" : frame.type)),
			);
			// The content the events ended with is the content the frames rebuild.
			const last = [...fixture.events].reverse().find((event) => "partial" in event) as {
				partial: AssistantMessage;
			};
			expect(state.partial?.content).toEqual(last.partial.content);
		});
	}

	it("writes a start frame with no content, a pending stop and the cost so far", () => {
		const fixture = fixtures.find((one) => one.name === "tool-call.json") as Fixture;
		const start = new FrameEncoder().encode(fixture.events[0] as AssistantMessageEvent) as Extract<
			ModelFrame,
			{ type: "start" }
		>;
		expect(start.partial.content).toEqual([]);
		expect(start.partial.stopReason).toBe("pending");
		expect(Object.keys(start.partial)).toEqual([
			"role",
			"content",
			"api",
			"provider",
			"model",
			"usage",
			"stopReason",
			"timestamp",
		]);
	});

	it("does not send again what a block's start already held, and sends the rest of a partly held delta", () => {
		const partial = (text: string, kind: "text" | "thinking" = "text") =>
			({
				role: "assistant",
				content: [kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text }],
			}) as unknown as AssistantMessage;
		const encoder = new FrameEncoder();
		encoder.encode({
			type: "start",
			partial: { ...partial(""), api: "a", provider: "p", model: "m", usage: {}, timestamp: 1 } as never,
		});
		encoder.encode({ type: "text_start", contentIndex: 0, partial: partial("Hello") });
		// Held: "Hel" is inside "Hello". Partly held: the next delta "loWor" has "lo" held and "Wor" new.
		expect(
			encoder.encode({ type: "text_delta", contentIndex: 0, delta: "Hel", partial: partial("Hello") }),
		).toBeUndefined();
		expect(
			encoder.encode({ type: "text_delta", contentIndex: 0, delta: "loWor", partial: partial("HelloWor") }),
		).toEqual({
			type: "text_delta",
			contentIndex: 0,
			delta: "Wor",
		});
		expect(
			encoder.encode({ type: "text_delta", contentIndex: 0, delta: "ld", partial: partial("HelloWorld") }),
		).toEqual({
			type: "text_delta",
			contentIndex: 0,
			delta: "ld",
		});
	});

	it("refuses a stream that breaks the order: an event before the start, a second start, an event after the end", () => {
		const start = {
			type: "start",
			partial: { role: "assistant", content: [], api: "a", provider: "p", model: "m", usage: {}, timestamp: 1 },
		} as never;
		expect(() =>
			new FrameEncoder().encode({ type: "text_delta", contentIndex: 0, delta: "x", partial: {} } as never),
		).toThrow(/before the stream began/);
		const twice = new FrameEncoder();
		twice.encode(start);
		expect(() => twice.encode(start)).toThrow(/began twice/);
		const ended = new FrameEncoder();
		ended.encode(start);
		ended.encode({ type: "error", reason: "error", error: {} } as never);
		expect(() => ended.encode({ type: "text_delta", contentIndex: 0, delta: "x", partial: {} } as never)).toThrow(
			/already ended/,
		);
	});

	it("refuses a frame that comes before the start, and a delta for a block of another kind", () => {
		const state: FrameState = { partial: undefined, json: new Map() };
		expect(() => applyFrame(state, { type: "text_delta", contentIndex: 0, delta: "x" })).toThrow(/before the start/);
		applyFrame(state, { type: "start", partial: { role: "assistant", content: [] } as never });
		applyFrame(state, { type: "text_start", contentIndex: 0, content: { type: "text", text: "" } });
		expect(() => applyFrame(state, { type: "thinking_delta", contentIndex: 0, delta: "x" })).toThrow(/found text/);
	});
});
