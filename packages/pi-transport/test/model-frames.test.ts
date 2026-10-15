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
	it("has the captured streams: text and thinking, tool calls, an error, an abort, and three of live tool arguments", () => {
		expect(fixtures.map((fixture) => fixture.name)).toEqual([
			"abort.json",
			"error.json",
			"text-and-thinking.json",
			"tool-args-empty-start.json",
			"tool-args-grown.json",
			"tool-args-late-match.json",
			"tool-call.json",
			"two-tools-and-text.json",
		]);
	});

	// A tool call's arguments are rebuilt while it streams, not only at its end: after each frame between the start and the
	// end, the rebuilt arguments are the ones the provider's own partial held at that event. The three streams reach the
	// three paths of the encoder: a start with empty arguments (every delta is sent), a start with arguments that the
	// deltas then grow beyond (one checkpoint, then deltas), and deltas that do not match the start until a later one does.
	for (const name of ["tool-args-empty-start.json", "tool-args-grown.json", "tool-args-late-match.json"]) {
		it(`rebuilds the arguments of ${name} before the tool call ends, as the provider's partial held them`, () => {
			const fixture = fixtures.find((one) => one.name === name) as Fixture;
			const state: FrameState = { partial: undefined, json: new Map() };
			const checked: string[] = [];
			fixture.frames.forEach((frame, at) => {
				if (frame === null) return;
				applyFrame(state, frame);
				const event = fixture.events[at] as AssistantMessageEvent;
				if (
					frame.type === "start" ||
					frame.type === "toolcall_start" ||
					frame.type === "toolcall_end" ||
					!("partial" in event)
				)
					return;
				const rebuilt = state.partial?.content[0] as { arguments: unknown };
				const held = (event.partial.content[0] as { arguments: unknown }).arguments;
				expect(rebuilt.arguments, `after the ${frame.type} frame at event ${at}`).toEqual(held);
				checked.push(frame.type);
			});
			expect(checked.length).toBeGreaterThan(0);
			if (name === "tool-args-empty-start.json") expect(new Set(checked)).toEqual(new Set(["toolcall_delta"]));
			else expect(checked).toContain("toolcall_checkpoint");
		});
	}

	it("sends no frame for an empty delta of a tool call whose start was empty, and none for deltas that do not yet match a held start", () => {
		const empty = fixtures.find((one) => one.name === "tool-args-empty-start.json") as Fixture;
		const emptyDelta = empty.events.findIndex((event) => event.type === "toolcall_delta" && event.delta === "");
		expect(emptyDelta).toBeGreaterThan(0);
		expect(new FrameEncoder().encode(empty.events[0] as AssistantMessageEvent) !== undefined).toBe(true);
		expect(empty.frames[emptyDelta]).toBeNull();
		const late = fixtures.find((one) => one.name === "tool-args-late-match.json") as Fixture;
		const firstDelta = late.events.findIndex((event) => event.type === "toolcall_delta");
		expect(late.frames[firstDelta]).toBeNull();
		expect((late.frames[firstDelta + 1] as { type: string }).type).toBe("toolcall_checkpoint");
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
