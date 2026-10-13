import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AssistantMessageFrame,
	AssistantMessageFrameEncoder,
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	type Model,
	type Models,
	type MutableModels,
	parseStreamingJson,
} from "@earendil-works/pi-ai";
import type { Frame } from "./link.ts";

const DEFAULT_RESUME_WITHIN_MS = 30_000;
const DEFAULT_KEEP_MS = 60_000;
/**
 * The text an open request ends with when its link is lost for good. pi-durable retries a failed request only when
 * pi-ai's `isRetryableAssistantError()` matches the text, and "connection lost" does.
 */
const LOST_TEXT = "model link: connection lost";

/** The host's chat models as plain JSON, for a runner that holds no credential. */
export type Catalog = {
	readonly providers: readonly {
		readonly id: string;
		readonly name: string;
		readonly models: readonly Model<Api>[];
	}[];
};

/**
 * The host's chat models without what may hold a secret: `headers` (of a provider or a model) can carry static
 * credentials and `baseUrl` can name a private gateway. The runner never uses either.
 */
export function catalogOf(models: Models): Catalog {
	return {
		providers: models.getProviders().map((provider) => ({
			id: provider.id,
			name: provider.name,
			models: provider.getModels().map((model) => {
				const { headers: _headers, baseUrl: _baseUrl, ...rest } = model;
				return JSON.parse(JSON.stringify({ ...rest, baseUrl: "proxy://host" })) as Model<Api>;
			}),
		})),
	};
}

/** Request options that never leave the runner, whatever their value. */
const NEVER_CROSSES = new Set([
	// Rebuilt on the host: the runner sends `model-abort`.
	"signal",
	// Credentials and the provider's own environment: the host uses its own.
	"apiKey",
	"env",
	// Functions and objects with methods.
	"fetch",
	"onPayload",
	"onResponse",
	"onProviderStreamEvent",
	"telemetryContext",
	"transformHeaders",
	"client",
]);

/**
 * The request options a host passes from a runner's frame to its own models when it names none. Plain knobs only:
 * never anything that picks a credential, an endpoint, a header, the provider's environment, or how long and how
 * often the host retries. A runner sits in a box and is not trusted with those. `serveModels(models, { allow })`
 * replaces this list with `allow`; a host that widens it passes `[...HOST_REQUEST_OPTIONS, "name"]`. Frozen.
 */
export const HOST_REQUEST_OPTIONS: readonly string[] = Object.freeze([
	"temperature",
	"maxTokens",
	"reasoning",
	"thinkingBudgets",
	"toolChoice",
	"samplingParams",
	"sessionId",
	"cacheRetention",
	"metadata",
]);

/** Whether `value` is plain JSON: what survives `JSON.stringify` unchanged. */
function plain(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) return value.every(plain);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	return Object.values(value).every((item) => item === undefined || plain(item));
}

/** The options of a request that go to the host: everything plain but what never crosses. */
export function crossingOptions(options: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
	const sent: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options ?? {})) {
		if (value !== undefined && !NEVER_CROSSES.has(key) && plain(value)) sent[key] = value;
	}
	return sent;
}

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type OpenRequest = {
	readonly id: string;
	readonly model: Model<Api>;
	readonly stream: AssistantMessageEventStream;
	/** The frame that asked, sent again when the host never saw it. */
	readonly request: Frame;
	/** The answer so far, rebuilt here frame by frame. */
	partial: AssistantMessage | undefined;
	/** The argument JSON received so far for each tool call. */
	readonly json: Map<number, string>;
	/** The sequence number of the last frame applied. */
	seq: number;
	readonly cleanup: () => void;
	deadline: ReturnType<typeof setTimeout> | undefined;
};

/** The runner's end of the model proxy. */
export interface ProxyModels {
	/** pi-ai's models for the Harness: the host's catalog, every request a frame to the host. */
	readonly models: MutableModels;
	/** A frame from the host. False when it is not a model frame. */
	receive(frame: Frame): boolean;
	/** The link is up: `send` reaches the host. Open requests ask the host for what they missed. */
	up(send: (frame: Frame) => boolean): void;
	/** The link is down. Open requests wait for it to come back, for a while. */
	down(reason: string): void;
}

/** A message the runner makes up itself, when the host's own end of the request did not arrive. */
function endedHere(request: OpenRequest, stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
	const base: AssistantMessage = request.partial ?? {
		role: "assistant",
		content: [],
		api: request.model.api,
		provider: request.model.provider,
		model: request.model.id,
		usage: structuredClone(ZERO_USAGE),
		stopReason,
		timestamp: Date.now(),
	};
	return { ...structuredClone(base), stopReason, errorMessage };
}

/**
 * Apply one compact frame and return the pi-ai event it stands for. The block the frame touches and the content
 * array are copied, so the partial of an event already handed out never changes.
 */
function rebuild(request: OpenRequest, frame: AssistantMessageFrame): AssistantMessageEvent {
	if (frame.type === "start") {
		request.partial = frame.partial;
		return { type: "start", partial: frame.partial };
	}
	const before = request.partial;
	if (before === undefined) throw new Error(`a ${frame.type} frame came before the start`);
	const index = frame.contentIndex;
	const put = (block: AssistantMessage["content"][number]): AssistantMessage => {
		const content = [...before.content];
		content[index] = block;
		request.partial = { ...before, content };
		return request.partial;
	};
	const copy = <T extends "text" | "thinking" | "toolCall">(type: T) => {
		const block = before.content[index];
		if (block?.type !== type) throw new Error(`a ${frame.type} frame at ${index} found ${block?.type ?? "nothing"}`);
		return { ...block } as Extract<AssistantMessage["content"][number], { type: T }>;
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
			request.json.set(index, "");
			return { type: "toolcall_start", contentIndex: index, partial: put(frame.toolCall) };
		case "toolcall_checkpoint":
		case "toolcall_delta": {
			const block = copy("toolCall");
			const delta = frame.type === "toolcall_delta" ? frame.delta : frame.json;
			const json = frame.type === "toolcall_delta" ? (request.json.get(index) ?? "") + delta : delta;
			request.json.set(index, json);
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

/**
 * pi-ai models for a runner that holds no credential. Each provider of the host's catalog is mirrored by id with an
 * auth that says "configured" and holds nothing; a request is one `model` frame to the host, and the answer comes
 * back as pi-ai's compact frames, rebuilt here into the same events.
 *
 * A lost link keeps open requests open for `resumeWithinMs`: when it comes back the runner asks for the frames it
 * missed, so the host pays once. A request still open after that ends with a retryable error.
 */
export function proxyModels(catalog: Catalog, options?: { readonly resumeWithinMs?: number }): ProxyModels {
	const resumeWithinMs = options?.resumeWithinMs ?? DEFAULT_RESUME_WITHIN_MS;
	const open = new Map<string, OpenRequest>();
	// Unique for each runner process, so a runner that started again cannot reuse an id the host still remembers.
	const process = randomUUID().slice(0, 8);
	let counter = 0;
	let send: ((frame: Frame) => boolean) | undefined;

	const finish = (request: OpenRequest, event: Extract<AssistantMessageEvent, { type: "done" | "error" }>) => {
		if (!open.delete(request.id)) return;
		request.cleanup();
		clearTimeout(request.deadline);
		request.stream.push(event);
		request.stream.end(event.type === "done" ? event.message : event.error);
	};
	const lose = (request: OpenRequest, why: string) => {
		finish(request, { type: "error", reason: "error", error: endedHere(request, "error", `${LOST_TEXT} (${why})`) });
	};
	const wait = (request: OpenRequest, why: string) => {
		request.deadline ??= setTimeout(() => lose(request, `${why}, not back in ${resumeWithinMs} ms`), resumeWithinMs);
	};

	const start = (
		model: Model<Api>,
		messages: readonly unknown[],
		received: Readonly<Record<string, unknown>> | undefined,
	): AssistantMessageEventStream => {
		counter += 1;
		const id = `${process}.${counter}`;
		const stream = createAssistantMessageEventStream();
		const frame: Frame = {
			t: "model",
			id,
			model: { provider: model.provider, modelId: model.id },
			messages,
			options: crossingOptions(received),
		};
		const signal = received?.signal instanceof AbortSignal ? received.signal : undefined;
		const onAbort = () => {
			send?.({ t: "model-abort", id });
			// Ended here at once: the host's own end of an aborted request may be slow, or never come.
			finish(request, {
				type: "error",
				reason: "aborted",
				error: endedHere(request, "aborted", "Request was aborted"),
			});
		};
		const request: OpenRequest = {
			id,
			model,
			stream,
			request: frame,
			partial: undefined,
			json: new Map(),
			seq: 0,
			cleanup: () => signal?.removeEventListener("abort", onAbort),
			deadline: undefined,
		};
		open.set(id, request);
		if (signal?.aborted) {
			queueMicrotask(onAbort);
			return stream;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		if (send?.(frame) !== true) wait(request, "the link is down");
		return stream;
	};

	const models = createModels();
	for (const provider of catalog.providers) {
		models.setProvider(
			createProvider({
				id: provider.id,
				name: provider.name,
				// Every provider has auth semantics. This one says "configured" and holds nothing.
				auth: { apiKey: { name: "the host (no credential here)", resolve: async () => ({ auth: {} }) } },
				models: provider.models,
				api: {
					stream: (model, context, received) =>
						start(model, context.messages, received as Readonly<Record<string, unknown>>),
					streamSimple: (model, context, received) =>
						start(model, context.messages, received as Readonly<Record<string, unknown>>),
				},
			}),
		);
	}

	return {
		models,
		receive(frame) {
			if (!frame.t.startsWith("model-")) return false;
			const request = typeof frame.id === "string" ? open.get(frame.id) : undefined;
			// A frame for a request that ended here already.
			if (request === undefined) return true;
			if (frame.t === "model-unknown") {
				// Frames were applied, so the host that sent them is gone: this answer cannot be continued.
				if (request.seq > 0) lose(request, "the host no longer knows this request");
				// The host never saw the request: sending it again cannot make it pay twice.
				else send?.(request.request);
				return true;
			}
			const seq = typeof frame.seq === "number" ? frame.seq : -1;
			// A replay after a resume can repeat frames; a gap means the answer cannot be trusted.
			if (seq <= request.seq) return true;
			if (seq !== request.seq + 1) {
				lose(request, `frame ${seq} came after ${request.seq}`);
				return true;
			}
			request.seq = seq;
			try {
				if (frame.t === "model-frame") {
					request.stream.push(rebuild(request, frame.frame as AssistantMessageFrame));
				} else if (frame.t === "model-end") {
					const message = frame.message as AssistantMessage;
					finish(request, { type: "done", reason: message.stopReason as "stop", message });
				} else if (frame.t === "model-error") {
					const message = frame.message as AssistantMessage | undefined;
					const reason = frame.reason === "aborted" ? "aborted" : "error";
					const error = message ?? endedHere(request, reason, String(frame.errorMessage ?? "the host failed"));
					finish(request, { type: "error", reason, error });
				}
			} catch (cause) {
				lose(request, cause instanceof Error ? cause.message : String(cause));
			}
			return true;
		},
		up(next) {
			send = next;
			for (const request of open.values()) {
				clearTimeout(request.deadline);
				request.deadline = undefined;
				// The host answers with what was missed, or with model-unknown when the request never reached it.
				next({ t: "model-resume", id: request.id, after: request.seq });
			}
		},
		down(reason) {
			send = undefined;
			for (const request of open.values()) wait(request, reason);
		},
	};
}

type ServedCall = {
	readonly controller: AbortController;
	/** Every frame sent for the call, kept so a runner that lost the link can ask for what it missed. */
	readonly frames: Frame[];
	done: boolean;
};

/** The host's end of the model proxy. */
export interface ModelServer {
	/** A model frame from the runner; answers go through `send`. False when it is not a model frame. */
	receive(frame: Frame, send: (frame: Frame) => boolean): boolean;
	/** The link is up again: answers go through `send` from now on. */
	up(send: (frame: Frame) => boolean): void;
	/** The link is down. Calls run on and keep their frames for a resume. */
	down(): void;
	/** End every call that still runs. */
	close(): void;
	/** Requests the host made to its providers: what it paid for. */
	readonly paid: number;
}

/**
 * Answer a runner's model frames with the host's own models: its credentials, its endpoints, its fetch, its signal.
 * A frame's options are not trusted: only the plain values of `allow` reach the host's models, and everything else in
 * them is dropped. `allow` replaces `HOST_REQUEST_OPTIONS`, the default; it does not add to it. A request id seen before is never called again.
 */
export function serveModels(
	models: Models,
	options?: { readonly keepMs?: number; readonly allow?: readonly string[] },
): ModelServer {
	const keepMs = options?.keepMs ?? DEFAULT_KEEP_MS;
	const allow = new Set(options?.allow ?? HOST_REQUEST_OPTIONS);
	const calls = new Map<string, ServedCall>();
	let send: ((frame: Frame) => boolean) | undefined;
	let paid = 0;

	const emit = (id: string, call: ServedCall, frame: Frame) => {
		const numbered: Frame = { ...frame, id, seq: call.frames.length + 1 };
		call.frames.push(numbered);
		send?.(numbered);
	};

	const run = async (id: string, request: Frame): Promise<void> => {
		const call: ServedCall = { controller: new AbortController(), frames: [], done: false };
		calls.set(id, call);
		try {
			const asked = request.model as { provider?: unknown; modelId?: unknown } | undefined;
			const model = models.getModel(String(asked?.provider), String(asked?.modelId));
			if (model === undefined) {
				const errorMessage = `the model ${String(asked?.provider)}/${String(asked?.modelId)} is not available on the host`;
				emit(id, call, { t: "model-error", reason: "error", errorMessage });
				return;
			}
			paid += 1;
			// Only the knobs a host allows, and only plain values: the frame came from a box.
			const sent = (request.options ?? {}) as Readonly<Record<string, unknown>>;
			const requestOptions: Record<string, unknown> = { signal: call.controller.signal };
			for (const [key, value] of Object.entries(sent)) {
				if (allow.has(key) && value !== undefined && plain(value)) requestOptions[key] = value;
			}
			const events = models.streamSimple(
				model,
				{ messages: request.messages as never },
				requestOptions as Parameters<Models["streamSimple"]>[2],
			);
			const encoder = new AssistantMessageFrameEncoder();
			let ended = false;
			for await (const event of events) {
				if (event.type === "done") {
					ended = true;
					emit(id, call, { t: "model-end", message: event.message });
				} else if (event.type === "error") {
					ended = true;
					emit(id, call, { t: "model-error", reason: event.reason, message: event.error });
				} else {
					const frame = encoder.encode(event);
					if (frame !== undefined) emit(id, call, { t: "model-frame", frame });
				}
			}
			if (!ended) {
				const message = await events.result();
				const failed = message.stopReason === "error" || message.stopReason === "aborted";
				emit(
					id,
					call,
					failed ? { t: "model-error", reason: message.stopReason, message } : { t: "model-end", message },
				);
			}
		} catch (cause) {
			const errorMessage = cause instanceof Error ? cause.message : String(cause);
			emit(id, call, { t: "model-error", reason: "error", errorMessage });
		} finally {
			call.done = true;
			// Kept a while for a runner that lost the link at the very end, then let go.
			setTimeout(() => calls.delete(id), keepMs).unref?.();
		}
	};

	return {
		receive(frame, reply) {
			if (frame.t !== "model" && frame.t !== "model-abort" && frame.t !== "model-resume") return false;
			send = reply;
			const id = typeof frame.id === "string" ? frame.id : "";
			const call = calls.get(id);
			if (frame.t === "model") {
				// The same id again is a resend of a request that did arrive: never call the provider twice for one id.
				if (call === undefined) void run(id, frame);
			} else if (frame.t === "model-abort") {
				if (call !== undefined && !call.done) call.controller.abort();
			} else if (call === undefined) {
				reply({ t: "model-unknown", id });
			} else {
				const after = typeof frame.after === "number" ? frame.after : 0;
				for (const kept of call.frames.slice(after)) reply(kept);
			}
			return true;
		},
		up(next) {
			send = next;
		},
		down() {
			send = undefined;
		},
		close() {
			send = undefined;
			for (const call of calls.values()) if (!call.done) call.controller.abort();
		},
		get paid() {
			return paid;
		},
	};
}
