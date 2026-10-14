import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Models, SystemMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, UsageDoc } from "@earendil-works/pi-durable";
import { getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { BoxProcess } from "../src/box/box.ts";
import { connectHome } from "../src/home/host.ts";
import { HOST_REQUEST_OPTIONS } from "../src/home/index.ts";
import { type Frame, type Link, linkPair, MAX_LINE_LENGTH, processLink, streamLink } from "../src/home/link.ts";
import {
	catalogOf,
	crossingOptions,
	type ModelServer,
	type ProxyModels,
	proxyModels,
	serveModels,
} from "../src/home/models.ts";
import { textResult } from "../src/testing/tool-result.ts";

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** About 400 tokens by the faux provider's count of four characters a token. */
const LONG_ANSWER = Array.from({ length: 40 }, (_, n) => `Line ${n} of a long answer, said slowly. `)
	.join("")
	.padEnd(1600, ".")
	.slice(0, 1600);

/** Join a runner's proxy and a host's server over a fresh pair of links. Returns the runner's end, to cut. */
function connect(proxy: ProxyModels, server: ModelServer): Link {
	const [runner, host] = linkPair();
	const toHost = (frame: Frame) => runner.send(frame);
	const toRunner = (frame: Frame) => host.send(frame);
	runner.onFrame((frame) => proxy.receive(frame));
	host.onFrame((frame) => server.receive(frame, toRunner));
	runner.onClose((reason) => proxy.down(reason));
	host.onClose(() => server.down());
	server.up(toRunner);
	proxy.up(toHost);
	return runner;
}

/** A faux provider that thinks and calls a tool, then streams a long answer at 60 tokens a second. */
function hostModels() {
	// One api name for every instance: the faux provider otherwise makes up a new one each time.
	const faux = fauxProvider({ api: "faux", tokensPerSecond: 60 });
	const models = createModels();
	models.setProvider(faux.provider);
	const asked: Message[][] = [];
	faux.setResponses([
		(transcript) => {
			asked.push(structuredClone(transcript.messages));
			return fauxAssistantMessage(
				[fauxThinking("Look it up first."), fauxToolCall("lookup", { q: "cost", limit: 3 }, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(transcript) => {
			asked.push(structuredClone(transcript.messages));
			return fauxAssistantMessage(LONG_ANSWER);
		},
	]);
	return { faux, models, asked };
}

/** One session: a question, a tool round, a long answer. Returns what it left in its store. */
async function session(models: Models, during?: (elapsed: () => number) => Promise<void>, instructions?: string) {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-models-"));
	try {
		const lookup = defineTool({
			name: "lookup",
			description: "Look a thing up.",
			parameters: Type.Object({ q: Type.String(), limit: Type.Number() }),
			async execute(args) {
				await sleep(20);
				return textResult(`${args.limit} results for ${args.q}`);
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "lookup", tools: [lookup] }));
		const harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "run.sqlite")),
			{ models, registry },
			context,
		);
		const root = await harness.root(context, {
			agent: {
				model: { provider: "faux", modelId: "faux-1" },
				...(instructions === undefined ? {} : { instructions }),
			},
		});
		const started = performance.now();
		await root.submit({ type: "input", content: "What does it cost?" }, context);
		await during?.(() => performance.now() - started);
		await root.waitForIdle(context);
		// pi 1.1 scans newest first and 1.0 oldest first, and only 1.1 takes an order: entry ids count up in both.
		const entries = [...(await root.entries({}, 500, undefined, context)).items].sort(
			(left, right) => Number(left.id) - Number(right.id),
		);
		const usage = await harness.snapshot(UsageDoc, root.id, context);
		await harness.close(context);
		return { entries, usage };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Without what differs between any two runs: when a message started and how long it took, and storage ids. */
function scrub<T>(value: T): T {
	if (Array.isArray(value)) return value.map(scrub) as T;
	if (value === null || typeof value !== "object") return value;
	const copy: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!["timestamp", "durationMs", "id", "conversationId", "byTaskId"].includes(key)) copy[key] = scrub(item);
	}
	return copy as T;
}

describe("the model proxy", () => {
	it("gives a session the same entries, tool calls and usage as the models themselves", async () => {
		const direct = hostModels();
		const alone = await session(direct.models);
		const behind = hostModels();
		const server = serveModels(behind.models);
		const proxy = proxyModels(catalogOf(behind.models));
		connect(proxy, server);
		const proxied = await session(proxy.models);
		expect(scrub(proxied.entries)).toEqual(scrub(alone.entries));
		expect(proxied.usage).toEqual(alone.usage);
		expect(scrub(behind.asked)).toEqual(scrub(direct.asked));
		expect(server.paid).toBe(2);
		const answer = proxied.entries.findLast((entry) => entry.kind === "pi.assistant")?.model?.[0] as AssistantMessage;
		expect(answer.content).toEqual([{ type: "text", text: LONG_ANSWER }]);
	}, 30_000);

	it("gives the host's model the instructions and tools the runner's Harness built, as the models themselves get them", async () => {
		const instructions = "Answer in one line, and cite the lookup.";
		const direct = hostModels();
		await session(direct.models, undefined, instructions);
		const behind = hostModels();
		const server = serveModels(behind.models);
		const proxy = proxyModels(catalogOf(behind.models));
		connect(proxy, server);
		await session(proxy.models, undefined, instructions);
		// What each provider received: pi-ai carries the prompt and the tools in the transcript's leading system message.
		for (const [arm, asked] of [
			["direct", direct.asked],
			["through the proxy", behind.asked],
		] as const) {
			expect(asked, arm).toHaveLength(2);
			for (const transcript of asked) {
				const system = transcript[0] as SystemMessage | undefined;
				expect(system?.role, arm).toBe("system");
				expect(JSON.stringify(system), arm).toContain(instructions);
				expect(
					system?.toolsAdded?.map((tool) => ({ name: tool.name, description: tool.description })),
					arm,
				).toEqual([{ name: "lookup", description: "Look a thing up." }]);
				expect(JSON.parse(JSON.stringify(system?.toolsAdded?.[0]?.parameters)), arm).toMatchObject({
					type: "object",
					properties: { q: { type: "string" }, limit: { type: "number" } },
					required: ["q", "limit"],
				});
			}
		}
		expect(scrub(behind.asked)).toEqual(scrub(direct.asked));
	}, 30_000);

	it("goes on with the same answer after the link drops in the middle of it, and the host pays once", async () => {
		const host = hostModels();
		const server = serveModels(host.models);
		const proxy = proxyModels(catalogOf(host.models));
		let runnerEnd = connect(proxy, server);
		const proxied = await session(proxy.models, async (elapsed) => {
			// The long answer streams for about 6.7 s: cut it after its first second, for half a second.
			while (elapsed() < 2_000) await sleep(20);
			runnerEnd.close("the box's exec stream closed");
			await sleep(500);
			runnerEnd = connect(proxy, server);
		});
		expect(server.paid).toBe(2);
		const kinds = proxied.entries.map((entry) => {
			const message = entry.model?.[0];
			return message?.role === "assistant" ? `assistant:${message.stopReason}` : entry.kind;
		});
		// No error entry: the answer was never cut, only delayed.
		expect(kinds.filter((kind) => kind.startsWith("assistant"))).toEqual(["assistant:toolUse", "assistant:stop"]);
		const answer = proxied.entries.findLast((entry) => entry.kind === "pi.assistant")?.model?.[0] as AssistantMessage;
		expect(answer.content).toEqual([{ type: "text", text: LONG_ANSWER }]);
	}, 30_000);

	it("ends a request whose link stays down with an error pi retries, in the words pi-ai matches", async () => {
		const host = hostModels();
		const proxy = proxyModels(catalogOf(host.models), { resumeWithinMs: 200 });
		const model = proxy.models.getModel("faux", "faux-1");
		if (model === undefined) throw new Error("the catalog has no faux-1");
		// No link at all.
		const message = await proxy.models.completeSimple(model, {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		});
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/^model link: connection lost \(the link is down, not back in 200 ms\)$/);
		const { isRetryableAssistantError } = await import("@earendil-works/pi-ai");
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	it("stops the host's call when the runner aborts, and ends the runner's request at once", async () => {
		const host = hostModels();
		const server = serveModels(host.models);
		const proxy = proxyModels(catalogOf(host.models));
		connect(proxy, server);
		const model = proxy.models.getModel("faux", "faux-1");
		if (model === undefined) throw new Error("the catalog has no faux-1");
		let signal: AbortSignal | undefined;
		host.faux.setResponses([
			(_transcript, options) => {
				signal = options?.signal;
				return fauxAssistantMessage(LONG_ANSWER);
			},
		]);
		const controller = new AbortController();
		const stream = proxy.models.streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ signal: controller.signal },
		);
		let deltas = 0;
		const started = performance.now();
		for await (const event of stream) {
			if (event.type !== "text_delta") continue;
			deltas += 1;
			if (deltas === 3) controller.abort();
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(performance.now() - started).toBeLessThan(3_000);
		// The host's own call was stopped too: it pays for no more of the answer.
		await sleep(50);
		expect(signal?.aborted).toBe(true);
	});

	it("passes on only the plain knobs a host allows from a frame the runner wrote, whatever else it carries", async () => {
		const host = hostModels();
		const seen: Record<string, unknown>[] = [];
		host.faux.setResponses([
			(_transcript, options) => {
				seen.push({ ...(options as Record<string, unknown>) });
				return fauxAssistantMessage("ok");
			},
		]);
		const server = serveModels(host.models);
		const replies: Frame[] = [];
		// Written by hand, as a runner that is not this package's would write it.
		server.receive(
			{
				t: "model",
				id: "runner-1.1",
				model: { provider: "faux", modelId: "faux-1" },
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
				options: {
					apiKey: "not-a-secret",
					env: { AZURE_OPENAI_BASE_URL: "https://elsewhere.example", OPENAI_API_KEY: "not-a-secret" },
					azureBaseUrl: "https://elsewhere.example",
					headers: { authorization: "Bearer not-a-secret" },
					maxRetries: 1e9,
					timeoutMs: 1e9,
					metadata: { when: new Date(0) },
					temperature: 0.2,
					sessionId: "s-1",
				},
			},
			(frame) => replies.push(frame) > 0,
		);
		await sleep(200);
		expect(seen).toHaveLength(1);
		const received = seen[0] ?? {};
		// pi-ai's models give a provider its own apiKey, headers and env (the host's): none of the frame's may be there.
		const text = JSON.stringify(received);
		expect(text).not.toContain("not-a-secret");
		expect(text).not.toContain("elsewhere.example");
		for (const key of ["azureBaseUrl", "maxRetries", "timeoutMs", "metadata"])
			expect(received, key).not.toHaveProperty(key);
		expect(received).toMatchObject({ temperature: 0.2, sessionId: "s-1" });
		expect(replies.at(-1)?.t).toBe("model-end");
	});

	it("takes a host's allow list in place of the default, never on top of it, and keeps the default frozen", async () => {
		/** The options the host's model received for one hand-written frame, served with `allow`. */
		async function received(allow: readonly string[] | undefined): Promise<Record<string, unknown>> {
			const host = hostModels();
			const seen: Record<string, unknown>[] = [];
			host.faux.setResponses([
				(_transcript, options) => {
					seen.push({ ...(options as Record<string, unknown>) });
					return fauxAssistantMessage("ok");
				},
			]);
			const server = serveModels(host.models, allow === undefined ? undefined : { allow });
			server.receive(
				{
					t: "model",
					id: "runner-1.1",
					model: { provider: "faux", modelId: "faux-1" },
					messages: [{ role: "user", content: "hi", timestamp: 0 }],
					options: { temperature: 0.2, sessionId: "s-1", seed: 7 },
				},
				() => true,
			);
			await sleep(200);
			expect(seen).toHaveLength(1);
			return seen[0] ?? {};
		}
		const byDefault = await received(undefined);
		expect(byDefault).toMatchObject({ temperature: 0.2, sessionId: "s-1" });
		expect(byDefault).not.toHaveProperty("seed");
		// A list of its own replaces the default: sessionId is in the default and not in this list.
		const replaced = await received(["temperature"]);
		expect(replaced).toMatchObject({ temperature: 0.2 });
		expect(replaced).not.toHaveProperty("sessionId");
		expect(replaced).not.toHaveProperty("seed");
		// Widening is the default spread into a list of the host's own.
		const widened = await received([...HOST_REQUEST_OPTIONS, "seed"]);
		expect(widened).toMatchObject({ temperature: 0.2, sessionId: "s-1", seed: 7 });
		expect(Object.isFrozen(HOST_REQUEST_OPTIONS)).toBe(true);
		expect(() => (HOST_REQUEST_OPTIONS as string[]).push("apiKey")).toThrow(TypeError);
		expect(HOST_REQUEST_OPTIONS).not.toContain("apiKey");
	});

	it("never calls the host's model twice for one request id, and says so for an id it never saw", async () => {
		const host = hostModels();
		const server = serveModels(host.models);
		const replies: Frame[] = [];
		const reply = (frame: Frame) => replies.push(frame) > 0;
		const request: Frame = {
			t: "model",
			id: "runner-1.1",
			model: { provider: "faux", modelId: "faux-1" },
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			options: {},
		};
		server.receive(request, reply);
		server.receive(request, reply);
		await sleep(300);
		expect(server.paid).toBe(1);
		server.receive({ t: "model-resume", id: "runner-9.9", after: 0 }, reply);
		expect(replies.at(-1)).toEqual({ t: "model-unknown", id: "runner-9.9" });
	});

	it("keeps answering on the newest link when an older one closes after it came up, and pays once", async () => {
		const faux = fauxProvider({ api: "faux", tokensPerSecond: 200 });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("An answer of some length, streamed. ".repeat(10))]);
		const server = serveModels(models);
		/** A runner of the test's own on a fresh link: it says ready and keeps what the host sends it. */
		const hold = async () => {
			const [runnerEnd, hostEnd] = linkPair();
			const got: Frame[] = [];
			runnerEnd.onFrame((frame) => {
				if (frame.t === "hello") runnerEnd.send({ t: "ready", v: 1, ok: true, session: "s", state: "open" });
				else got.push(frame);
			});
			const handle = connectHome(hostEnd, { models, epoch: 1, server });
			getOrThrow(await handle.ready);
			return { runnerEnd, handle, got };
		};
		const older = await hold();
		older.runnerEnd.send({
			t: "model",
			id: "runner-1.1",
			epoch: 1,
			model: { provider: "faux", modelId: "faux-1" },
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			options: {},
		});
		await sleep(100);
		// The runner came back on a new link, and only then did the host see the old one close.
		const newer = await hold();
		older.handle.close("the old exec ended late");
		for (let waited = 0; waited < 5_000 && newer.got.at(-1)?.t !== "model-end"; waited += 20) await sleep(20);
		expect(newer.got.at(-1)?.t).toBe("model-end");
		expect(older.got.length).toBeGreaterThan(0);
		// Every frame of the answer went to one link or the other, in order, once; the provider was called once.
		expect([...older.got, ...newer.got].map((frame) => frame.seq)).toEqual(
			Array.from({ length: older.got.length + newer.got.length }, (_, n) => n + 1),
		);
		expect(server.paid).toBe(1);
		newer.handle.close("done");
		server.close();
	});

	it("tells the runner nothing secret: no header, no endpoint, no key, no environment", () => {
		const secret = "not-a-secret";
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const catalog = JSON.stringify(catalogOf(models));
		expect(catalog).not.toContain(faux.getModel().baseUrl);
		expect(catalog).toContain("proxy://host");
		const sent = crossingOptions({
			apiKey: secret,
			env: { OPENAI_API_KEY: secret },
			headers: { "x-trace": "1" },
			signal: new AbortController().signal,
			fetch: () => undefined,
			sessionId: "s-1",
			maxRetries: 2,
		});
		expect(sent).toEqual({ headers: { "x-trace": "1" }, sessionId: "s-1", maxRetries: 2 });
		expect(JSON.stringify(sent)).not.toContain(secret);
	});
});

describe("a link", () => {
	it("reads frames that arrive in pieces, a character split between two of them included", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const link = streamLink(input, output);
		const frames: Frame[] = [];
		link.onFrame((frame) => frames.push(frame));
		const bytes = Buffer.from(`${JSON.stringify({ t: "a", text: "é 漢字" })}\n${JSON.stringify({ t: "b" })}\n`);
		for (let at = 0; at < bytes.length; at += 3) input.write(bytes.subarray(at, at + 3));
		await sleep(10);
		expect(frames).toEqual([{ t: "a", text: "é 漢字" }, { t: "b" }]);
		expect(link.send({ t: "out" })).toBe(true);
		expect(output.read()?.toString()).toBe('{"t":"out"}\n');
	});

	it("closes on a line that is not a frame, and sends nothing after", async () => {
		const input = new PassThrough();
		const link = streamLink(input, new PassThrough());
		let why = "";
		link.onClose((reason) => {
			why = reason;
		});
		input.write("not json\n");
		await sleep(10);
		expect(link.closed).toBe(true);
		expect(why).toMatch(/not JSON/);
		expect(link.send({ t: "late" })).toBe(false);
	});

	it("closes on a line longer than it takes, finished or not, and takes one of exactly that length", async () => {
		/** What a link that takes lines of 100 characters does with `chunks`. */
		async function read(chunks: readonly string[]) {
			const input = new PassThrough();
			const link = streamLink(input, new PassThrough(), { maxLineLength: 100 });
			const frames: Frame[] = [];
			let why = "";
			link.onFrame((frame) => frames.push(frame));
			link.onClose((reason) => {
				why = reason;
			});
			for (const chunk of chunks) input.write(chunk);
			await sleep(10);
			return { frames, why, closed: link.closed };
		}
		// {"t":"a","p":""} is 16 characters, and the padding.
		const line = (length: number) => JSON.stringify({ t: "a", p: "x".repeat(length - 16) });
		expect(line(100)).toHaveLength(100);
		const exact = await read([`${line(100)}\n`]);
		expect(exact).toEqual({ frames: [{ t: "a", p: "x".repeat(84) }], why: "", closed: false });
		for (const [what, chunks] of [
			["finished, in one piece", [`${line(101)}\n`]],
			["finished, in pieces", [line(101).slice(0, 60), `${line(101).slice(60)}\n`]],
			["never finished", ["x".repeat(60), "x".repeat(41)]],
			["after a frame, in the same piece", [`${line(26)}\n${"x".repeat(101)}`]],
		] as const) {
			const read101 = await read(chunks);
			expect(read101.closed, what).toBe(true);
			expect(read101.why, what).toBe("a line longer than 100 characters arrived");
		}
		// The host's end over a program in a box takes the same limit.
		const stdout = (async function* () {
			yield new TextEncoder().encode("x".repeat(101));
			await new Promise(() => {});
		})();
		const boxLink = processLink(
			{ stdin: { write: async () => {}, close: async () => {} }, stdout, stderr: stdout, wait: async () => ok(0) },
			{ maxLineLength: 100 },
		);
		let boxWhy = "";
		boxLink.onClose((reason) => {
			boxWhy = reason;
		});
		await sleep(10);
		expect(boxWhy).toBe("a line longer than 100 characters arrived");
	});

	it("takes lines of up to 64 Mi characters by default, and not one more", async () => {
		expect(MAX_LINE_LENGTH).toBe(64 * 1024 * 1024);
		const input = new PassThrough();
		const link = streamLink(input, new PassThrough());
		let why = "";
		link.onClose((reason) => {
			why = reason;
		});
		// A box that writes and never ends its line.
		const chunk = "x".repeat(8 * 1024 * 1024);
		for (let n = 0; n < 8; n += 1) input.write(chunk);
		await sleep(50);
		expect(link.closed).toBe(false);
		input.write("x");
		await sleep(50);
		expect(link.closed).toBe(true);
		expect(why).toBe(`a line longer than ${MAX_LINE_LENGTH} characters arrived`);
	});

	it("puts every frame sent while a slow write is in flight into the next write", async () => {
		const writes: string[] = [];
		let ended: () => void = () => {};
		const output: AsyncIterable<Uint8Array> = {
			[Symbol.asyncIterator]: () => ({
				next: () =>
					new Promise<IteratorResult<Uint8Array>>((resolve) => {
						ended = () => resolve({ done: true, value: undefined });
					}),
			}),
		};
		// A box whose input is a buffered call of 120 ms, as on Daytona.
		const process: BoxProcess = {
			stdin: {
				write: async (bytes) => {
					writes.push(new TextDecoder().decode(bytes));
					await sleep(120);
				},
				close: async () => {},
			},
			stdout: output,
			stderr: output,
			wait: async () => ok(0),
		};
		const link = processLink(process);
		for (let n = 0; n < 50; n += 1) {
			link.send({ t: "frame", n });
			await sleep(5);
		}
		await sleep(300);
		const sent = writes
			.join("")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { n: number }).n);
		expect(sent).toEqual(Array.from({ length: 50 }, (_, n) => n));
		// About 250 ms of frames in writes of 120 ms each: a few writes, not fifty.
		expect(writes.length).toBeLessThanOrEqual(5);
		ended();
		await sleep(10);
		expect(link.closed).toBe(true);
	});
});
