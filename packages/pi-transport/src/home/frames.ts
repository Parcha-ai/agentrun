import { type AssistantMessage, type AssistantMessageEvent, parseStreamingJson } from "@earendil-works/pi-ai";

/**
 * The compact frames of a model answer on the link: what the host sends for each streamed event, small enough to keep
 * and to send again. Both ends are this package's code from one install, so the format is this package's own: a frame
 * names the content block it touches and carries only what changed. The answer is rebuilt at the runner from the frames
 * in order (`applyFrame`); the final message travels whole, in its own frame, so a rebuild that is cut short loses
 * nothing that matters.
 */
export type ModelFrame =
	| { readonly type: "start"; readonly partial: AssistantMessage }
	| { readonly type: "text_start"; readonly contentIndex: number; readonly content: TextBlock }
	| { readonly type: "text_delta"; readonly contentIndex: number; readonly delta: string }
	| {
			readonly type: "text_end";
			readonly contentIndex: number;
			readonly content: string;
			readonly textSignature?: string;
	  }
	| { readonly type: "thinking_start"; readonly contentIndex: number; readonly content: ThinkingBlock }
	| { readonly type: "thinking_delta"; readonly contentIndex: number; readonly delta: string }
	| {
			readonly type: "thinking_end";
			readonly contentIndex: number;
			readonly content: string;
			readonly thinkingSignature?: string;
			readonly redacted?: boolean;
	  }
	| { readonly type: "toolcall_start"; readonly contentIndex: number; readonly toolCall: ToolCallBlock }
	| { readonly type: "toolcall_delta"; readonly contentIndex: number; readonly delta: string }
	| { readonly type: "toolcall_checkpoint"; readonly contentIndex: number; readonly json: string }
	| {
			readonly type: "toolcall_end";
			readonly contentIndex: number;
			readonly id: string;
			readonly name: string;
			readonly arguments: ToolCallBlock["arguments"];
			readonly thoughtSignature?: string;
			readonly namespace?: string;
	  };

type Block = AssistantMessage["content"][number];
type TextBlock = Extract<Block, { type: "text" }>;
type ThinkingBlock = Extract<Block, { type: "thinking" }>;
type ToolCallBlock = Extract<Block, { type: "toolCall" }>;

/** A copy that shares nothing with the event it was taken from: a provider may go on changing its partial. */
const own = <T>(value: T): T => structuredClone(value);

const textOf = (block: TextBlock): TextBlock => ({
	type: "text",
	text: block.text,
	...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
});

const thinkingOf = (block: ThinkingBlock): ThinkingBlock => ({
	type: "thinking",
	thinking: block.thinking,
	...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
	...(block.redacted === undefined ? {} : { redacted: block.redacted }),
});

const toolCallOf = (call: ToolCallBlock): ToolCallBlock => ({
	type: "toolCall",
	id: call.id,
	name: call.name,
	arguments: own(call.arguments),
	...(call.thoughtSignature === undefined ? {} : { thoughtSignature: call.thoughtSignature }),
	...(call.namespace === undefined ? {} : { namespace: call.namespace }),
});

/** The message a stream starts with: who answers, what it cost so far, and nothing of its content yet. */
const startOf = (message: AssistantMessage): AssistantMessage =>
	({
		role: "assistant",
		content: [],
		api: message.api,
		provider: message.provider,
		model: message.model,
		...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
		...(message.responseId === undefined ? {} : { responseId: message.responseId }),
		...(message.providerThinkingLevel === undefined ? {} : { providerThinkingLevel: message.providerThinkingLevel }),
		...(message.diagnostics === undefined ? {} : { diagnostics: own(message.diagnostics) }),
		usage: own(message.usage),
		stopReason: "pending",
		timestamp: message.timestamp,
	}) as unknown as AssistantMessage;

/** What the encoder knows of a block that has started and not ended. */
type Open =
	| { readonly kind: "text" | "thinking"; readonly covered: number; seen: number }
	| { readonly kind: "toolCall"; caughtUp: boolean; pending: string; snapshot: string };

const json = (value: unknown): string => {
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("Tool-call arguments are not JSON-serializable");
	return text;
};
const EMPTY_ARGUMENTS = json(parseStreamingJson(""));

/** Whether `later` holds everything `earlier` does, grown: strings extended, arrays lengthened, objects with more keys. */
function grew(earlier: unknown, later: unknown): boolean {
	if (typeof earlier === "string") return typeof later === "string" && later.startsWith(earlier);
	if (Array.isArray(earlier)) {
		return (
			Array.isArray(later) && earlier.length <= later.length && earlier.every((item, at) => grew(item, later[at]))
		);
	}
	if (typeof earlier !== "object" || earlier === null) return Object.is(earlier, later);
	if (typeof later !== "object" || later === null || Array.isArray(later)) return false;
	const now = later as Record<string, unknown>;
	return Object.entries(earlier).every(([key, value]) => Object.hasOwn(now, key) && grew(value, now[key]));
}

/**
 * Turn the events of one stream into frames, one at a time, in this wire format: a block's start frame carries what the
 * block holds when it starts, and a delta already inside that is not sent again; a tool call's arguments that were
 * already in its start are caught up by one `toolcall_checkpoint` with the JSON received. `done` and `error` have no
 * frame: the final message or the failure travels whole in a frame of its own.
 */
export class FrameEncoder {
	#started = false;
	#terminal = false;
	readonly #open = new Map<number, Open>();

	encode(event: AssistantMessageEvent): ModelFrame | undefined {
		if (this.#terminal) throw new Error(`Assistant message event ${event.type} follows a terminal event`);
		if (event.type === "start") {
			if (this.#started) throw new Error("Assistant message stream contains more than one start event");
			this.#started = true;
			return { type: "start", partial: startOf(event.partial) };
		}
		if (event.type === "done" || event.type === "error") {
			if (event.type === "done" && !this.#started)
				throw new Error("Assistant message done event appears before start");
			this.#terminal = true;
			return undefined;
		}
		if (!this.#started) throw new Error(`Assistant message ${event.type} event appears before start`);
		const at = event.contentIndex;
		if (!Number.isSafeInteger(at) || at < 0) throw new Error(`Invalid assistant message frame contentIndex: ${at}`);
		switch (event.type) {
			case "text_start": {
				const block = blockOf(event, "text");
				this.#begin(at, { kind: "text", covered: block.text.length, seen: 0 });
				return { type: "text_start", contentIndex: at, content: textOf(block) };
			}
			case "text_delta":
				return this.#words(at, event.delta, "text");
			case "text_end": {
				const block = blockOf(event, "text");
				this.#finish(at, "text");
				return {
					type: "text_end",
					contentIndex: at,
					content: event.content,
					...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
				};
			}
			case "thinking_start": {
				const block = blockOf(event, "thinking");
				this.#begin(at, { kind: "thinking", covered: block.thinking.length, seen: 0 });
				return { type: "thinking_start", contentIndex: at, content: thinkingOf(block) };
			}
			case "thinking_delta":
				return this.#words(at, event.delta, "thinking");
			case "thinking_end": {
				const block = blockOf(event, "thinking");
				this.#finish(at, "thinking");
				return {
					type: "thinking_end",
					contentIndex: at,
					content: event.content,
					...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
					...(block.redacted === undefined ? {} : { redacted: block.redacted }),
				};
			}
			case "toolcall_start": {
				const block = blockOf(event, "toolCall");
				const snapshot = json(block.arguments);
				const caughtUp = snapshot === EMPTY_ARGUMENTS;
				this.#begin(at, { kind: "toolCall", caughtUp, pending: "", snapshot: caughtUp ? "" : snapshot });
				return { type: "toolcall_start", contentIndex: at, toolCall: toolCallOf(block) };
			}
			case "toolcall_delta": {
				const state = this.#state(at, "toolCall");
				if (state.kind !== "toolCall") throw new Error("Unreachable tool-call encoder state");
				if (state.caughtUp) {
					return event.delta.length === 0
						? undefined
						: { type: "toolcall_delta", contentIndex: at, delta: event.delta };
				}
				state.pending += event.delta;
				const now = parseStreamingJson(state.pending);
				// The deltas always begin from empty input, also when the start held some arguments: they may build more than it held.
				if (json(now) !== state.snapshot && !grew(parseStreamingJson(state.snapshot), now)) return undefined;
				const received = state.pending;
				state.caughtUp = true;
				state.snapshot = "";
				state.pending = "";
				return received.length === 0
					? undefined
					: { type: "toolcall_checkpoint", contentIndex: at, json: received };
			}
			case "toolcall_end": {
				blockOf(event, "toolCall");
				if (event.toolCall.type !== "toolCall")
					throw new Error(`toolcall_end event has invalid tool call at index ${at}`);
				this.#finish(at, "toolCall");
				const call = event.toolCall;
				return {
					type: "toolcall_end",
					contentIndex: at,
					id: call.id,
					name: call.name,
					arguments: own(call.arguments),
					...(call.thoughtSignature === undefined ? {} : { thoughtSignature: call.thoughtSignature }),
					...(call.namespace === undefined ? {} : { namespace: call.namespace }),
				};
			}
			default:
				return undefined;
		}
	}

	#begin(at: number, state: Open): void {
		if (this.#open.has(at)) throw new Error(`Assistant message block ${at} starts more than once`);
		this.#open.set(at, state);
	}

	#state(at: number, kind: Open["kind"]): Open {
		const state = this.#open.get(at);
		if (state === undefined) throw new Error(`Assistant message ${kind} block ${at} has not started`);
		if (state.kind !== kind) throw new Error(`Assistant message block ${at} is ${state.kind}, not ${kind}`);
		return state;
	}

	#finish(at: number, kind: Open["kind"]): void {
		this.#state(at, kind);
		this.#open.delete(at);
	}

	/** A text or thinking delta, less what the block's start already held. */
	#words(at: number, delta: string, kind: "text" | "thinking"): ModelFrame | undefined {
		const state = this.#state(at, kind);
		if (state.kind === "toolCall") throw new Error("Unreachable text encoder state");
		const from = state.seen;
		state.seen += delta.length;
		const held = Math.max(0, state.covered - from);
		if (held >= delta.length) return undefined;
		const rest = held === 0 ? delta : delta.slice(held);
		return kind === "text"
			? { type: "text_delta", contentIndex: at, delta: rest }
			: { type: "thinking_delta", contentIndex: at, delta: rest };
	}
}

/** The block of `type` a block event stands at in its partial. */
function blockOf<T extends Block["type"]>(
	event: Extract<AssistantMessageEvent, { contentIndex: number }>,
	type: T,
): Extract<Block, { type: T }> {
	const block = event.partial.content[event.contentIndex];
	if (!block) throw new Error(`${event.type} event has no content block at index ${event.contentIndex}`);
	if (block.type !== type) {
		throw new Error(`${event.type} event points to ${block.type} block at index ${event.contentIndex}`);
	}
	return block as Extract<Block, { type: T }>;
}

/** What a rebuild keeps between frames: the answer so far, and the argument JSON received for each tool call. */
export type FrameState = {
	partial: AssistantMessage | undefined;
	readonly json: Map<number, string>;
};

/**
 * Apply one frame to `state` and return the event it stands for. The block the frame touches and the content array
 * are copied, so the partial of an event already handed out never changes.
 */
export function applyFrame(state: FrameState, frame: ModelFrame): AssistantMessageEvent {
	if (frame.type === "start") {
		state.partial = frame.partial;
		return { type: "start", partial: frame.partial };
	}
	const before = state.partial;
	if (before === undefined) throw new Error(`a ${frame.type} frame came before the start`);
	const index = frame.contentIndex;
	const put = (block: Block): AssistantMessage => {
		const content = [...before.content];
		content[index] = block;
		state.partial = { ...before, content };
		return state.partial;
	};
	const copy = <T extends "text" | "thinking" | "toolCall">(type: T) => {
		const block = before.content[index];
		if (block?.type !== type) throw new Error(`a ${frame.type} frame at ${index} found ${block?.type ?? "nothing"}`);
		return { ...block } as Extract<Block, { type: T }>;
	};
	switch (frame.type) {
		case "text_start":
			return { type: "text_start", contentIndex: index, partial: put(frame.content) };
		case "text_delta": {
			const block = copy("text");
			block.text += frame.delta;
			return { type: "text_delta", contentIndex: index, delta: frame.delta, partial: put(block) };
		}
		case "text_end": {
			const block = copy("text");
			block.text = frame.content;
			if (frame.textSignature === undefined) delete block.textSignature;
			else block.textSignature = frame.textSignature;
			return { type: "text_end", contentIndex: index, content: frame.content, partial: put(block) };
		}
		case "thinking_start":
			return { type: "thinking_start", contentIndex: index, partial: put(frame.content) };
		case "thinking_delta": {
			const block = copy("thinking");
			block.thinking += frame.delta;
			return { type: "thinking_delta", contentIndex: index, delta: frame.delta, partial: put(block) };
		}
		case "thinking_end": {
			const block = copy("thinking");
			block.thinking = frame.content;
			if (frame.thinkingSignature === undefined) delete block.thinkingSignature;
			else block.thinkingSignature = frame.thinkingSignature;
			if (frame.redacted === undefined) delete block.redacted;
			else block.redacted = frame.redacted;
			return { type: "thinking_end", contentIndex: index, content: frame.content, partial: put(block) };
		}
		case "toolcall_start":
			state.json.set(index, "");
			return { type: "toolcall_start", contentIndex: index, partial: put(frame.toolCall) };
		case "toolcall_checkpoint":
		case "toolcall_delta": {
			const block = copy("toolCall");
			const delta = frame.type === "toolcall_delta" ? frame.delta : frame.json;
			const json = frame.type === "toolcall_delta" ? (state.json.get(index) ?? "") + delta : delta;
			state.json.set(index, json);
			// The provider's own partial arguments are not on the wire: parsed here as pi-ai's adapters parse them.
			block.arguments = parseStreamingJson(json);
			return { type: "toolcall_delta", contentIndex: index, delta, partial: put(block) };
		}
		case "toolcall_end": {
			const block = copy("toolCall");
			block.id = frame.id;
			block.name = frame.name;
			block.arguments = frame.arguments;
			if (frame.thoughtSignature === undefined) delete block.thoughtSignature;
			else block.thoughtSignature = frame.thoughtSignature;
			if (frame.namespace === undefined) delete block.namespace;
			else block.namespace = frame.namespace;
			return { type: "toolcall_end", contentIndex: index, toolCall: block, partial: put(block) };
		}
	}
}
