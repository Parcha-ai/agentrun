import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import { getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { describe, expect, it } from "vitest";
import type { Box, BoxError, BoxProvider, BoxSpec } from "../src/box/box.ts";
import { parseTransportConfig } from "../src/config.ts";
import { transport } from "../src/hands/index.ts";
import { SessionBoxesDoc, type Transport } from "../src/transport.ts";

const context: Context = BACKGROUND_CONTEXT;

/** One tool call the scripted model makes. */
export type ToolUse = { readonly name: string; readonly args: ToolCall["arguments"] };

/** A tool call's result as the model saw it. */
export type ToolOutcome = { readonly text: string; readonly isError: boolean };

/** A provider that remembers what it was asked for, and can be told to refuse. */
export type WatchedProvider = BoxProvider & {
	/** Every box created through this provider, oldest first. */
	readonly created: Box[];
	/** The spec of every create, oldest first. */
	readonly specs: BoxSpec[];
	/** Make the next create fail with this error. */
	refuseNext(error: BoxError): void;
};

export function watched(inner: BoxProvider): WatchedProvider {
	const created: Box[] = [];
	const specs: BoxSpec[] = [];
	let refusal: BoxError | undefined;
	return {
		name: inner.name,
		created,
		specs,
		async create(spec, createContext): Promise<Result<Box, BoxError>> {
			specs.push(spec);
			if (refusal !== undefined) {
				const error = refusal;
				refusal = undefined;
				return { ok: false, error };
			}
			const box = await inner.create(spec, createContext);
			if (box.ok) created.push(box.value);
			return box;
		},
		attach: (id, attachContext) => inner.attach(id, attachContext),
		list: (labels, listContext) => inner.list(labels, listContext),
		refuseNext(error) {
			refusal = error;
		},
	};
}

/** A Harness with pi's coding tools and a scripted model, its tools routed by a transport. */
export type Session = {
	readonly harness: Harness;
	readonly hands: Transport;
	/** A new conversation with no owner. */
	converse(): Promise<Conversation>;
	/**
	 * One user message, answered by the scripted model with these tool calls, one for each request, then a last word.
	 * Returns every call's result as the model saw it.
	 */
	turn(conversation: Conversation, calls: readonly ToolUse[]): Promise<ToolOutcome[]>;
};

/** Open a Harness on `storage` whose tools go where `config` says. */
export async function openSession(
	storage: Storage,
	config: unknown,
	providers: Readonly<Record<string, BoxProvider>>,
	labels?: Readonly<Record<string, string>>,
	/** Stands between the transport and the Harness's `commit`, for a test that makes a commit fail. */
	commit: (inner: Harness["commit"]) => Harness["commit"] = (inner) => inner,
): Promise<Session> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(CodingTools);
	// The transport is the Harness's `env`, so it exists first and reaches the Harness through this binding.
	let harness: Harness | undefined;
	const hands = transport(getOrThrow(parseTransportConfig(config)), {
		providers,
		commit: commit((change, commitContext) => (harness as Harness).commit(change, commitContext)),
		...(labels === undefined ? {} : { labels }),
	});
	harness = await Harness.open(storage, { models, registry, env: hands.env }, context);
	const opened = harness;
	const model = { provider: "faux", modelId: faux.getModel().id };
	return {
		harness: opened,
		hands,
		converse: () => opened.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context),
		async turn(conversation, calls) {
			const outcomes: ToolOutcome[] = [];
			const see = (transcript: TranscriptContext) => {
				const last = transcript.messages.at(-1);
				if (last?.role !== "toolResult") return;
				const text = last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				outcomes.push({ text, isError: last.isError });
			};
			faux.setResponses([
				...calls.map((call, index) => (transcript: TranscriptContext) => {
					if (index > 0) see(transcript);
					return fauxAssistantMessage(fauxToolCall(call.name, call.args), { stopReason: "toolUse" });
				}),
				(transcript: TranscriptContext) => {
					see(transcript);
					return fauxAssistantMessage("Done.");
				},
			]);
			await (await conversation.submit({ type: "input", content: "Go on." }, context)).wait(context);
			return outcomes;
		},
	};
}

/** The bash tool, running one command. */
export function bash(command: string): ToolUse {
	return { name: "bash", args: { command } };
}

/** The write tool, writing one file. */
export function write(path: string, content: string): ToolUse {
	return { name: "write", args: { path, content } };
}

/** What the shared cases need to run on one kind of box. */
export type HandsFixture = {
	/** A provider over the same boxes at every call, as a host that starts again builds one. */
	provider(): BoxProvider;
	/** The config of one environment on that provider. */
	readonly environment: Readonly<Record<string, unknown>>;
	/** A directory of this machine for the session's store. */
	readonly directory: string;
	/** Labels for every box of this run, so the run can count what it left behind. */
	readonly labels?: Readonly<Record<string, string>>;
};

const decoder = new TextDecoder();

/** Calls `use` with what the cases need, then cleans up whatever the fixture itself made. */
export type WithHandsFixture = (use: (fixture: HandsFixture) => Promise<void>) => Promise<void>;

/**
 * The cases every kind of box must pass under the router: tools run in the box, a host that starts again finds it, a
 * box that vanished is one failed call, and the two scopes, the roles and the two ways to let boxes go hold.
 */
export function registerHandsCases(name: string, withFixture: WithHandsFixture, timeoutMs: number): void {
	/** Runs `use` with a watched provider, and ends every box it created whatever happens. */
	const withProvider = (use: (fixture: HandsFixture, provider: WatchedProvider) => Promise<void>) =>
		withFixture(async (fixture) => {
			const provider = watched(fixture.provider());
			try {
				await use(fixture, provider);
			} finally {
				for (const box of provider.created) await box.destroy(context);
			}
		});
	const config = (fixture: HandsFixture, scope: "session" | "conversation" = "session") => ({
		environments: { sandbox: { ...fixture.environment, scope }, other: { ...fixture.environment, scope } },
		hands: { default: "sandbox", build: "other" },
	});
	const providers = (fixture: HandsFixture, provider: BoxProvider) => ({
		[String(fixture.environment.provider)]: provider,
	});
	const store = (fixture: HandsFixture) => openNodeSqliteStorage(join(fixture.directory, "session.db"));

	describe(name, () => {
		it(
			"runs the session's write and bash tools in the box, not on this machine",
			() =>
				withProvider(async (fixture, provider) => {
					const session = await openSession(
						await store(fixture),
						config(fixture),
						providers(fixture, provider),
						fixture.labels,
					);
					const conversation = await session.converse();
					const outcomes = await session.turn(conversation, [
						write("note.txt", "from the box"),
						bash("cat note.txt"),
					]);
					expect(outcomes.map((outcome) => outcome.isError)).toEqual([false, false]);
					expect(outcomes[1]?.text).toContain("from the box");
					expect(provider.created.length).toBe(1);
					const [file] = getOrThrow(await (provider.created[0] as Box).download(["note.txt"], context));
					expect(decoder.decode(file?.bytes)).toBe("from the box");
					expect(existsSync("note.txt")).toBe(false);
					await session.harness.close(context);
				}),
			timeoutMs,
		);

		it(
			"creates no box for a run that calls no tool",
			() =>
				withProvider(async (fixture, provider) => {
					const session = await openSession(
						await store(fixture),
						config(fixture),
						providers(fixture, provider),
						fixture.labels,
					);
					expect(await session.turn(await session.converse(), [])).toEqual([]);
					expect(provider.specs).toEqual([]);
					await session.harness.close(context);
				}),
			timeoutMs,
		);

		it(
			"finds the same box again after the host closed and opened the session",
			() =>
				withProvider(async (fixture, provider) => {
					const first = await openSession(
						await store(fixture),
						config(fixture),
						providers(fixture, provider),
						fixture.labels,
					);
					const conversation = await first.converse();
					expect((await first.turn(conversation, [write("note.txt", "kept")]))[0]?.isError).toBe(false);
					await first.hands.release(context);
					await first.harness.close(context);

					const later = watched(fixture.provider());
					const second = await openSession(
						await store(fixture),
						config(fixture),
						providers(fixture, later),
						fixture.labels,
					);
					const again = await second.harness.conversation(conversation.id, context);
					if (again === undefined) throw new Error("the conversation is not in the store");
					const outcomes = await second.turn(again, [bash("cat note.txt")]);
					expect(outcomes[0]?.isError).toBe(false);
					expect(outcomes[0]?.text).toContain("kept");
					expect(later.specs).toEqual([]);
					expect(provider.created.length).toBe(1);
					await second.harness.close(context);
				}),
			timeoutMs,
		);

		it(
			"fails one tool call when the box vanished, and runs the next in a new box",
			() =>
				withProvider(async (fixture, provider) => {
					const session = await openSession(
						await store(fixture),
						config(fixture),
						providers(fixture, provider),
						fixture.labels,
					);
					const conversation = await session.converse();
					expect((await session.turn(conversation, [bash("echo one > a.txt")]))[0]?.isError).toBe(false);
					getOrThrow(await (provider.created[0] as Box).destroy(context));
					const outcomes = await session.turn(conversation, [bash("cat a.txt"), bash("echo two; ls")]);
					expect(outcomes[0]?.isError).toBe(true);
					expect(outcomes[0]?.text).toMatch(/is gone/);
					expect(outcomes[1]?.isError).toBe(false);
					expect(outcomes[1]?.text).toContain("two");
					expect(outcomes[1]?.text).not.toContain("a.txt");
					expect(provider.created.length).toBe(2);
					await session.harness.close(context);
				}),
			timeoutMs,
		);

		it(
			"gives each conversation a box of its own under scope conversation, and one shared box under scope session",
			() =>
				withProvider(async (fixture, provider) => {
					for (const [scope, boxes] of [
						["conversation", 2],
						["session", 1],
					] as const) {
						const before = provider.created.length;
						const directory = join(fixture.directory, scope);
						const storage = await openNodeSqliteStorage(`${directory}.db`);
						const session = await openSession(
							storage,
							config(fixture, scope),
							providers(fixture, provider),
							fixture.labels,
						);
						const one = await session.converse();
						const two = await session.converse();
						expect((await session.turn(one, [bash("echo one > mine.txt")]))[0]?.isError).toBe(false);
						const seen = await session.turn(two, [bash("cat mine.txt || echo nothing-here")]);
						expect(seen[0]?.text).toContain(scope === "session" ? "one" : "nothing-here");
						expect(provider.created.length - before).toBe(boxes);
						await session.harness.close(context);
					}
				}),
			timeoutMs,
		);

		it(
			"moves a conversation's next tool call when it is assigned a role, and refuses a name it does not know",
			() =>
				withProvider(async (fixture, provider) => {
					const session = await openSession(
						await store(fixture),
						config(fixture),
						providers(fixture, provider),
						fixture.labels,
					);
					const conversation = await session.converse();
					expect((await session.turn(conversation, [bash("echo here > where.txt")]))[0]?.isError).toBe(false);

					getOrThrow(await session.hands.assign(conversation.id, "build", context));
					const moved = await session.turn(conversation, [bash("cat where.txt || echo not-here")]);
					expect(moved[0]?.text).toContain("not-here");
					expect(provider.created.length).toBe(2);

					for (const unknown of ["nowhere", "constructor"]) {
						const refused = await session.hands.assign(conversation.id, unknown, context);
						expect(refused.ok ? "" : refused.error.code).toBe("unknown_environment");
					}

					// An environment's own id is a target too, and its box is still there.
					getOrThrow(await session.hands.assign(conversation.id, "sandbox", context));
					const back = await session.turn(conversation, [bash("cat where.txt")]);
					expect(back[0]?.text).toContain("here");
					expect(provider.created.length).toBe(2);
					await session.harness.close(context);
				}),
			timeoutMs,
		);

		it(
			"leaves its boxes running on release, and a later transport's destroy ends them from the documents alone",
			() =>
				withProvider(async (fixture, provider) => {
					const first = await openSession(
						await store(fixture),
						config(fixture),
						providers(fixture, provider),
						fixture.labels,
					);
					expect((await first.turn(await first.converse(), [bash("true")]))[0]?.isError).toBe(false);
					const box = provider.created[0] as Box;
					await first.hands.release(context);
					await first.harness.close(context);
					expect(getOrThrow(await box.status(context)).state).toBe("running");

					const second = await openSession(
						await store(fixture),
						config(fixture),
						providers(fixture, fixture.provider()),
						fixture.labels,
					);
					getOrThrow(await second.hands.destroy(context));
					expect(getOrThrow(await box.status(context)).state).toBe("ended");
					expect(await second.harness.snapshot(SessionBoxesDoc, context)).toEqual({ boxes: {} });
					await second.harness.close(context);
				}),
			timeoutMs,
		);
	});
}

/**
 * Pids of local-box watchdogs that still run for a box whose directory is under `root`, read from `/proc`: a process
 * that carries the watchdog marker in its environment and names `root` on its command line. A box that was released
 * and then forgotten leaves one that sleeps out its whole lifetime.
 */
export function watchdogsUnder(root: string): number[] {
	if (!existsSync("/proc/self/environ")) return [];
	const found: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
		try {
			if (!readFileSync(`/proc/${name}/environ`, "latin1").includes("PI_TRANSPORT_WATCHDOG=")) continue;
			if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes(root)) found.push(Number(name));
		} catch {
			// Another user's process, or one that ended.
		}
	}
	return found;
}
