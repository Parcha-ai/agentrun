import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	createSession,
	defineExtension,
	defineTool,
	type Harness,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { App } from "../src/home/app.ts";
import { connectHome, type HomeHandle } from "../src/home/host.ts";
import { type Frame, linkPair } from "../src/home/link.ts";
import { type ModelServer, serveModels } from "../src/home/models.ts";
import {
	createShipper,
	type Recording,
	type RecordLine,
	type RecordSink,
	receiveRecords,
} from "../src/home/records.ts";
import { type HomeOptions, openHome } from "../src/home/run.ts";
import { createRunner, EXIT_REFUSED, type Runner, type RunnerOptions } from "../src/home/runner.ts";
import { admitsTool } from "../src/home/shipping.ts";
import { textResult } from "../src/testing/tool-result.ts";

const context = BACKGROUND_CONTEXT;
const ROUNDS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A session with a tool round for each of `ROUNDS`, and the place it runs. */
function world() {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-records-"));
	const effects = join(directory, "effects.log");
	// When each tool call started.
	const starts: number[] = [];
	const faux = fauxProvider({ api: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 100 }, (_, n) => async (transcript: { messages: readonly { role: string }[] }) => {
			await sleep(15);
			const done = transcript.messages.filter((message) => message.role === "toolResult").length;
			if (done >= ROUNDS) return fauxAssistantMessage("done");
			return fauxAssistantMessage(fauxToolCall("work", { n: done }, { id: `call-${done}-${n}` }), {
				stopReason: "toolUse",
			});
		}),
	);
	const work = defineTool({
		name: "work",
		description: "Do one unit of work.",
		parameters: Type.Object({ n: Type.Number() }),
		async execute(args) {
			starts.push(performance.now());
			await sleep(20);
			appendFileSync(effects, `${args.n}\n`);
			return textResult(`did ${args.n}`);
		},
	});
	const app: App = (ctx) => {
		const registry = createRegistry();
		registry.install(defineExtension({ name: "work", tools: [work] }));
		return { registry, root: { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: ctx.workspace } } };
	};
	const workspace = join(directory, "work");
	mkdirSync(workspace, { recursive: true });
	const options: RunnerOptions = {
		app,
		session: "session-1",
		store: join(directory, "store", "run.sqlite"),
		workspace,
		where: { environment: "a", provider: "local" },
		resumeWithinMs: 1_500,
		recording: recorder(),
	};
	return {
		directory,
		models,
		options,
		starts,
		effects: () => (existsSync(effects) ? readFileSync(effects, "utf8").trim().split("\n").filter(Boolean) : []),
		remove: () => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
	};
}

/** A recorder of the test's own, shaped as agentrun-pi's: a snapshot line at the open, lines for odd commits only. */
function recorder(): Recording {
	return {
		async snapshotLines(_storage, { at }) {
			return [{ commit: at, kind: "snapshot" } as RecordLine];
		},
		recordCommits(session, { write }) {
			let chain = Promise.resolve();
			const unsubscribe = session.subscribeCommits((publication) => {
				const commit = Number(publication.seq);
				if (commit % 2 === 0) return;
				const lines = [{ commit, kind: "commit", changes: publication.changes.length } as RecordLine];
				chain = chain.then(() => write(lines));
			});
			return async () => {
				unsubscribe();
				await chain;
			};
		},
	};
}

/** A host's record sink in memory: the log, the lines, and the order things happened in. */
function memorySink(options?: { readonly appendMs?: number }) {
	const log: { commit: number; writes: readonly StorageWrite[] }[] = [];
	// When each commit that admits a tool call was in the log.
	const admitted: number[] = [];
	const lines = new Map<number, readonly unknown[]>();
	const events: string[] = [];
	let after = 0;
	let linesAfter = 0;
	const sink: RecordSink = {
		held: () => ({ after, linesAfter }),
		async append(commit, writes) {
			events.push(`append ${commit} start`);
			if (options?.appendMs !== undefined) await sleep(options.appendMs);
			log.push({ commit, writes: JSON.parse(JSON.stringify(writes)) });
			if (admitsTool(writes)) admitted.push(performance.now());
			after = commit;
			events.push(`append ${commit}`);
		},
		async lines(commit, recorded, snapshot) {
			events.push(`${snapshot ? "snapshot" : "lines"} ${commit}`);
			if (!snapshot) {
				lines.set(commit, recorded);
				linesAfter = commit;
			}
		},
	};
	return { sink, log, lines, events, admitted };
}

/** A runner on a fresh pair of links, held by a host with `sink` and `server`. */
async function hold(
	made: ReturnType<typeof world>,
	runner: Runner,
	epoch: number,
	sink: RecordSink | undefined,
	server: ModelServer,
): Promise<HomeHandle> {
	const [runnerEnd, hostEnd] = linkPair();
	runner.attach(runnerEnd);
	const handle = connectHome(hostEnd, {
		models: made.models,
		epoch,
		server,
		...(sink === undefined ? {} : { records: sink }),
	});
	getOrThrow(await handle.ready);
	return handle;
}

/** The store's head: the sequence its next commit takes. */
function headOf(store: string): number {
	const database = new DatabaseSync(store, { readOnly: true });
	try {
		return Number((database.prepare("SELECT next_seq FROM durable_metadata").get() as { next_seq: number }).next_seq);
	} finally {
		database.close();
	}
}

const everyRound = Array.from({ length: ROUNDS }, (_, n) => String(n));
const from1 = (count: number) => Array.from({ length: count }, (_, n) => n + 1);

async function withWorld(use: (made: ReturnType<typeof world>) => Promise<void>): Promise<void> {
	const made = world();
	try {
		await use(made);
	} finally {
		made.remove();
	}
}

describe("the record stream", () => {
	it("ships every commit to a host that keeps it, its lines after it, and a log that rebuilds the store", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const runner = createRunner(made.options);
			const host = await hold(made, runner, 1, kept.sink, serveModels(made.models));
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			getOrThrow(await host.idle(context));
			expect(made.effects()).toEqual(everyRound);
			await runner.home?.close(context);
			const head = headOf(made.options.store);
			expect(kept.log.map((one) => one.commit)).toEqual(from1(head - 1));
			// The snapshot first, at the commit the process opened at; then each commit's lines after it is in the log.
			expect(kept.events[0]).toBe("snapshot 0");
			for (const [at, event] of kept.events.entries()) {
				const lines = /^lines (\d+)$/.exec(event);
				if (lines !== null) expect(kept.events.indexOf(`append ${lines[1]}`), event).toBeLessThan(at);
			}
			expect([...kept.lines.keys()]).toEqual(from1(head - 1).filter((commit) => commit % 2 === 1));

			// The host's log alone rebuilds the store, row for row.
			const rebuilt = join(made.directory, "rebuilt.sqlite");
			const storage = await openNodeSqliteStorage(rebuilt);
			for (const one of kept.log) expect(Number(await storage.commit(one.writes, context))).toBe(one.commit);
			await storage.close(context);
			expect(dump(rebuilt)).toEqual(dump(made.options.store));
			host.close("done");
		});
	}, 30_000);

	it("loses nothing when the link drops again and again: the runner sends from where the host is", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const server = serveModels(made.models);
			const runner = createRunner(made.options);
			let host = await hold(made, runner, 1, kept.sink, server);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			for (let cut = 0; cut < 4; cut += 1) {
				await sleep(60);
				host.close("the box's exec stream closed");
				// The session goes on without a host: its commits wait in the outbox.
				await sleep(60);
				host = await hold(made, runner, 1, kept.sink, server);
			}
			getOrThrow(await host.idle(context));
			expect(made.effects()).toEqual(everyRound);
			await runner.home?.close(context);
			const head = headOf(made.options.store);
			expect(kept.log.map((one) => one.commit)).toEqual(from1(head - 1));
			expect([...kept.lines.keys()].sort((left, right) => left - right)).toEqual(
				from1(head - 1).filter((commit) => commit % 2 === 1),
			);
			host.close("done");
		});
	}, 30_000);

	it("writes a commit's lines only once the commit is in the log, however slow the log is", async () => {
		await withWorld(async (made) => {
			const kept = memorySink({ appendMs: 25 });
			const runner = createRunner(made.options);
			const host = await hold(made, runner, 1, kept.sink, serveModels(made.models));
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			getOrThrow(await host.idle(context));
			for (const [at, event] of kept.events.entries()) {
				const lines = /^lines (\d+)$/.exec(event);
				if (lines !== null) expect(kept.events.indexOf(`append ${lines[1]}`), event).toBeLessThan(at);
				// Nothing starts while an append is under way.
				const started = /^append (\d+) start$/.exec(event);
				if (started !== null) expect(kept.events[at + 1], event).toBe(`append ${started[1]}`);
			}
			await runner.home?.close(context);
			// And nothing was dropped on the way: every commit, every line.
			const head = headOf(made.options.store);
			expect(kept.log.map((one) => one.commit)).toEqual(from1(head - 1));
			expect([...kept.lines.keys()]).toEqual(from1(head - 1).filter((commit) => commit % 2 === 1));
			host.close("done");
		});
	}, 30_000);

	it("seals only what the host holds: a seal fails as not_shipped until a host that takes the stream has it all", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const server = serveModels(made.models);
			const runner = createRunner(made.options);
			const first = await hold(made, runner, 1, kept.sink, server);
			getOrThrow(await first.resume({ epoch: 1 }, context));
			getOrThrow(await first.submit("go", undefined, context));
			getOrThrow(await first.idle(context));
			first.close("gone");
			// A host that does not take the stream: what the runner commits now stays in its outbox. (A question
			// answered without a tool call: a tool call would wait for the host to hold its admission.)
			const blind = await hold(made, runner, 1, undefined, server);
			getOrThrow(await blind.submit("again", undefined, context));
			getOrThrow(await blind.idle(context));
			getOrThrow(await blind.drain({ timeoutMs: 5_000 }, context));
			const refused = await blind.seal(context);
			expect(refused.ok ? "sealed" : refused.error.code).toBe("not_shipped");
			blind.close("gone");
			const back = await hold(made, runner, 1, kept.sink, server);
			getOrThrow(await back.drain({ timeoutMs: 5_000 }, context));
			const seal = getOrThrow(await back.seal(context));
			expect(kept.log.map((one) => one.commit)).toEqual(from1(seal.head - 1));
			back.close("done");
		});
	}, 30_000);

	it("takes nothing into the log from a runner the lease left behind", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const runner = createRunner(made.options);
			const host = await hold(made, runner, 1, kept.sink, serveModels(made.models));
			getOrThrow(await host.resume({ epoch: 1 }, context));
			const before = kept.log.length;
			host.setEpoch(2);
			// The frames the resume left on the link are refused already, so the submit may find the session closed.
			await host.submit("go", undefined, context);
			expect(await runner.ended).toMatchObject({ how: "refused", exitCode: EXIT_REFUSED });
			expect(kept.log.length).toBe(before);
		});
	}, 30_000);
	it("sends a snapshot taken while no host took the stream once one does, after the commits before it", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const server = serveModels(made.models);
			// A first process runs the session to its end with a host that takes the stream.
			const first = createRunner(made.options);
			const host = await hold(made, first, 1, kept.sink, server);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			getOrThrow(await host.idle(context));
			await first.home?.close(context);
			host.close("gone");
			const opened = headOf(made.options.store) - 1;
			// The next process: a host that takes no stream reopens it and asks a question answered without a tool.
			const runner = createRunner(made.options);
			(await hold(made, runner, 1, kept.sink, server)).close("gone");
			const blind = await hold(made, runner, 1, undefined, server);
			getOrThrow(await blind.resume({ epoch: 1 }, context));
			getOrThrow(await blind.submit("again", undefined, context));
			getOrThrow(await blind.idle(context));
			blind.close("gone");
			const head = headOf(made.options.store);
			expect(head - 1).toBeGreaterThan(opened);
			const back = await hold(made, runner, 1, kept.sink, server);
			await sleep(100);
			expect(kept.events.filter((event) => event.startsWith("snapshot"))).toEqual([
				"snapshot 0",
				`snapshot ${opened}`,
			]);
			// The second process's snapshot comes after the commits before it, and before the ones after it.
			const at = kept.events.indexOf(`snapshot ${opened}`);
			expect(kept.events.indexOf(`append ${opened}`)).toBeLessThan(at);
			expect(kept.events.indexOf(`append ${opened + 1}`)).toBeGreaterThan(at);
			expect(kept.log.map((one) => one.commit)).toEqual(from1(head - 1));
			back.close("done");
			await runner.home?.close(context);
		});
	}, 30_000);

	it("sends a snapshot taken while no host took the stream when one does, also with no commit after it", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const server = serveModels(made.models);
			const runner = createRunner(made.options);
			(await hold(made, runner, 1, kept.sink, server)).close("gone");
			const blind = await hold(made, runner, 1, undefined, server);
			getOrThrow(await blind.resume({ epoch: 1 }, context));
			blind.close("gone");
			const committed = headOf(made.options.store) - 1;
			const back = await hold(made, runner, 1, kept.sink, server);
			await sleep(100);
			expect(kept.events.filter((event) => event.startsWith("snapshot"))).toEqual(["snapshot 0"]);
			expect(kept.log.map((one) => one.commit)).toEqual(from1(committed));
			back.close("done");
			await runner.home?.close(context);
		});
	}, 30_000);

	it("sends a later process's snapshot taken while no host took the stream, when it reopened without a commit", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const server = serveModels(made.models);
			const first = createRunner(made.options);
			const host = await hold(made, first, 1, kept.sink, server);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			getOrThrow(await host.idle(context));
			await first.home?.close(context);
			host.close("gone");
			const head = headOf(made.options.store);
			// The process starts again; a host that takes no stream reopens the session.
			const again = createRunner(made.options);
			(await hold(made, again, 1, kept.sink, server)).close("gone");
			const blind = await hold(made, again, 1, undefined, server);
			getOrThrow(await blind.resume({ epoch: 1 }, context));
			blind.close("gone");
			expect(headOf(made.options.store)).toBe(head);
			const back = await hold(made, again, 1, kept.sink, server);
			await sleep(100);
			expect(kept.events.filter((event) => event.startsWith("snapshot"))).toEqual([
				"snapshot 0",
				`snapshot ${head - 1}`,
			]);
			back.close("done");
			await again.home?.close(context);
		});
	}, 30_000);

	it("runs a tool call only once the host holds the commit that admits it", async () => {
		await withWorld(async (made) => {
			const kept = memorySink({ appendMs: 60 });
			const runner = createRunner(made.options);
			const host = await hold(made, runner, 1, kept.sink, serveModels(made.models));
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			getOrThrow(await host.idle(context));
			expect(made.effects()).toEqual(everyRound);
			expect(kept.admitted).toHaveLength(ROUNDS);
			for (const [n, started] of made.starts.entries()) {
				expect(started, `call ${n}`).toBeGreaterThanOrEqual(kept.admitted[n] ?? Number.POSITIVE_INFINITY);
			}
			host.close("done");
			await runner.home?.close(context);
		});
	}, 30_000);

	it("still runs a tool call only once the host holds its admission when the app adds admissions of its own", async () => {
		await withWorld(async (made) => {
			const kept = memorySink({ appendMs: 60 });
			// The app's own predicate admits none of the batches here: pi's tool intent must still wait for the host.
			const runner = createRunner({ ...made.options, admits: () => false });
			const host = await hold(made, runner, 1, kept.sink, serveModels(made.models));
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			getOrThrow(await host.idle(context));
			expect(made.effects()).toEqual(everyRound);
			expect(kept.admitted).toHaveLength(ROUNDS);
			for (const [n, started] of made.starts.entries()) {
				expect(started, `call ${n}`).toBeGreaterThanOrEqual(kept.admitted[n] ?? Number.POSITIVE_INFINITY);
			}
			host.close("done");
			await runner.home?.close(context);
		});
	}, 30_000);

	it("never runs a tool call whose admission the host does not hold in time, and the session stops", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const server = serveModels(made.models);
			const runner = createRunner(made.options);
			(await hold(made, runner, 1, kept.sink, server)).close("gone");
			// A host that does not take the stream: no commit of this runner is acknowledged.
			const blind = await hold(made, runner, 1, undefined, server);
			getOrThrow(await blind.resume({ epoch: 1 }, context));
			getOrThrow(await blind.submit("go", undefined, context));
			// Longer than the runner waits for an acknowledgement (1.5 s).
			await sleep(2_500);
			expect(made.starts).toEqual([]);
			expect(made.effects()).toEqual([]);
			blind.close("gone");
			// A host that takes the stream gets the admission, late: the call still does not run.
			const back = await hold(made, runner, 1, kept.sink, server);
			await sleep(300);
			expect(kept.log.some((one) => admitsTool(one.writes))).toBe(true);
			expect(made.starts).toEqual([]);
			back.close("done");
			await runner.home?.close(context).catch(() => {});
		});
	}, 30_000);

	it("keys each model request by its generation: a new process re-asks under the same key, a new ask under its own", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const real = serveModels(made.models);
			const seen: Frame[] = [];
			// The host holds the first request unanswered, as a provider in the middle of an answer would.
			const server: ModelServer = {
				receive(frame, reply) {
					if (frame.t === "model") seen.push(frame);
					if (frame.t === "model" && seen.length === 1) return true;
					return real.receive(frame, reply);
				},
				down: (from) => real.down(from),
				close: () => real.close(),
				get paid() {
					return real.paid;
				},
			};
			const first = createRunner(made.options);
			const host = await hold(made, first, 1, kept.sink, server);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			for (let waited = 0; waited < 5_000 && seen.length === 0; waited += 10) await sleep(10);
			// The process ends in the middle of the request.
			await first.home?.close(context);
			host.close("gone");
			const again = createRunner(made.options);
			const back = await hold(made, again, 1, kept.sink, server);
			getOrThrow(await back.resume({ epoch: 1 }, context));
			getOrThrow(await back.idle(context));
			expect(made.effects()).toEqual(everyRound);
			const [asked, reasked] = seen;
			expect(asked?.key).toMatch(/^sha256:/);
			expect(reasked?.key).toBe(asked?.key);
			expect(typeof asked?.position).toBe("number");
			expect(Number(reasked?.position)).toBeGreaterThanOrEqual(Number(asked?.position));
			// Every later generation asks under a key of its own.
			const keys = seen.slice(1).map((frame) => frame.key);
			expect(new Set(keys).size).toBe(keys.length);
			// A deliberate new ask, the same words again: a new generation, a new key.
			getOrThrow(await back.submit("go", undefined, context));
			getOrThrow(await back.idle(context));
			expect(seen.slice(0, -1).map((frame) => frame.key)).not.toContain(seen.at(-1)?.key);
			back.close("done");
			await again.home?.close(context);
		});
	}, 30_000);

	it("pays once for a request a new process asks again under the same key, and answers it from the first answer", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const real = serveModels(made.models);
			const seen: Frame[] = [];
			let firstId: unknown;
			// The host serves the first request in full, but its answer never reaches the runner, as when the runner's
			// process is killed while the provider answers: a killed process sends nothing more, no abort either.
			const server: ModelServer = {
				receive(frame, reply) {
					if (frame.t === "model") seen.push(frame);
					if (frame.t === "model" && firstId === undefined) {
						firstId = frame.id;
						return real.receive(frame, () => true);
					}
					if (frame.id === firstId && frame.t !== "model") return true;
					return real.receive(frame, reply);
				},
				down: (from) => real.down(from),
				close: () => real.close(),
				get paid() {
					return real.paid;
				},
			};
			const runner = createRunner(made.options);
			const host = await hold(made, runner, 1, kept.sink, server);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			for (let waited = 0; waited < 5_000 && real.paid === 0; waited += 10) await sleep(10);
			await runner.home?.close(context);
			host.close("gone");
			const again = createRunner(made.options);
			const back = await hold(made, again, 1, kept.sink, server);
			getOrThrow(await back.resume({ epoch: 1 }, context));
			getOrThrow(await back.idle(context));
			expect(made.effects()).toEqual(everyRound);
			expect(seen[1]?.key).toBe(seen[0]?.key);
			// One provider call for each key the runners asked under, the first one's twice: paid once.
			expect(real.paid).toBe(new Set(seen.map((frame) => frame.key)).size);
			back.close("done");
			await again.home?.close(context);
		});
	}, 30_000);

	it("asks the provider again for a key whose first call the runner aborted: an aborted call has no answer to give", async () => {
		await withWorld(async (made) => {
			const kept = memorySink();
			const real = serveModels(made.models);
			const seen: Frame[] = [];
			let first = true;
			// The first runner closes in order: it aborts the request it was waiting for, and the host stops the call.
			const server: ModelServer = {
				receive(frame, reply) {
					if (frame.t === "model") seen.push(frame);
					if (frame.t === "model" && first) {
						first = false;
						return real.receive(frame, () => true);
					}
					return real.receive(frame, reply);
				},
				down: (from) => real.down(from),
				close: () => real.close(),
				get paid() {
					return real.paid;
				},
			};
			const runner = createRunner(made.options);
			const host = await hold(made, runner, 1, kept.sink, server);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			for (let waited = 0; waited < 5_000 && real.paid === 0; waited += 10) await sleep(10);
			await runner.home?.close(context);
			host.close("gone");
			const again = createRunner(made.options);
			const back = await hold(made, again, 1, kept.sink, server);
			getOrThrow(await back.resume({ epoch: 1 }, context));
			getOrThrow(await back.idle(context));
			expect(made.effects()).toEqual(everyRound);
			expect(seen[1]?.key).toBe(seen[0]?.key);
			// The aborted key is paid again: one call more than the keys.
			expect(real.paid).toBe(new Set(seen.map((frame) => frame.key)).size + 1);
			back.close("done");
			await again.home?.close(context);
		});
	}, 30_000);

	it("gives an order the answer the runner sent before it closed, behind a slow log", async () => {
		const models = createModels();
		const kept = memorySink({ appendMs: 50 });
		const [runnerEnd, hostEnd] = linkPair();
		runnerEnd.onFrame((frame) => {
			if (frame.t === "hello") runnerEnd.send({ t: "ready", v: 1, ok: true, session: "s", state: "open" });
			if (frame.t === "order") {
				// A commit the host must log first, the answer, and the end of the runner.
				runnerEnd.send({ t: "record", commit: 1, writes: [], epoch: 1 });
				runnerEnd.send({ t: "answer", id: frame.id, ok: true, value: { state: "retired", epoch: 2 } });
				runnerEnd.close("retired");
			}
		});
		const host = connectHome(hostEnd, { models, epoch: 1, records: kept.sink });
		getOrThrow(await host.ready);
		const status = await host.status(context);
		expect(status.ok ? status.value : status.error.code).toEqual({ state: "retired", epoch: 2 });
		expect(kept.log.map((one) => one.commit)).toEqual([1]);
	});

	it("appends a commit once when a second link to the same log comes up while the first is still appending it", async () => {
		const models = createModels();
		const kept = memorySink({ appendMs: 300 });
		// The runner on its first link sends commit 1 once the host said where its log is, then its process dies.
		const [firstRunner, firstHost] = linkPair();
		firstRunner.onFrame((frame) => {
			if (frame.t === "hello") firstRunner.send({ t: "ready", v: 1, ok: true, session: "s", state: "open" });
			if (frame.t === "resend-after") firstRunner.send({ t: "record", commit: 1, writes: [], epoch: 1 });
		});
		const first = connectHome(firstHost, { models, epoch: 1, records: kept.sink });
		getOrThrow(await first.ready);
		for (let waited = 0; waited < 5_000 && !kept.events.includes("append 1 start"); waited += 5) await sleep(5);
		firstRunner.close("the process died");
		// On a new link it sends what the host does not hold, from where the host says its log is.
		const [secondRunner, secondHost] = linkPair();
		const said: unknown[] = [];
		secondRunner.onFrame((frame) => {
			if (frame.t === "hello") secondRunner.send({ t: "ready", v: 1, ok: true, session: "s", state: "open" });
			if (frame.t === "resend-after") {
				said.push(frame.after);
				if (Number(frame.after) < 1) secondRunner.send({ t: "record", commit: 1, writes: [], epoch: 1 });
			}
		});
		const second = connectHome(secondHost, { models, epoch: 1, records: kept.sink });
		getOrThrow(await second.ready);
		for (let waited = 0; waited < 5_000 && !kept.events.includes("append 1"); waited += 5) await sleep(5);
		await sleep(400);
		expect(kept.log.map((one) => one.commit)).toEqual([1]);
		expect(said).toEqual([1]);
		second.close("done");
		first.close("done");
	});
});

describe("the runner's end of the record stream", () => {
	it("lets an admission go when the host says its log holds it, though its acknowledgement was lost", async () => {
		await withWorld(async (made) => {
			// Longer than any case runs: only the host's word can let the commit go.
			const shipper = createShipper({ admits: () => true, acknowledgeWithinMs: 600_000 });
			mkdirSync(join(made.directory, "store"), { recursive: true });
			const wrapped = await shipper.wrapStore(made.options.store)(
				await openNodeSqliteStorage(made.options.store),
				context,
			);
			const sent: Frame[] = [];
			shipper.up((frame) => sent.push(frame) > 0);
			shipper.receive({ t: "resend-after", after: 0, linesAfter: 0 });
			const session = createSession(wrapped.storage);
			const committed = session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
			await sleep(100);
			// The host logged it and acknowledged it, and the acknowledgement went with the link.
			const record = sent.find((frame) => frame.t === "record");
			expect(record?.commit).toBe(1);
			shipper.down();
			shipper.up((frame) => sent.push(frame) > 0);
			shipper.receive({ t: "resend-after", after: 1, linesAfter: 0 });
			await committed;
			await session.close(context);
			await wrapped.closed?.();
		});
	});

	it("lets the outbox go when the host says its log holds the commits, though their acknowledgements were lost", async () => {
		await withWorld(async (made) => {
			let record: (lines: readonly RecordLine[]) => void = () => {};
			const shipper = createShipper({
				admits: () => false,
				recording: {
					recordCommits: (_harness, { write }) => {
						record = write;
						return async () => {};
					},
				},
			});
			mkdirSync(join(made.directory, "store"), { recursive: true });
			const wrapped = await shipper.wrapStore(made.options.store)(
				await openNodeSqliteStorage(made.options.store),
				context,
			);
			wrapped.opened?.({} as Harness);
			shipper.up(() => true);
			shipper.receive({ t: "resend-after", after: 0, linesAfter: 0 });
			const session = createSession(wrapped.storage);
			for (let n = 1; n <= 2; n += 1) {
				await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
				record([{ commit: n, kind: "commit" } as RecordLine]);
			}
			// The host logged both, writes and lines; their acknowledgements went with the link.
			expect(await shipper.drained(100)).toBe(false);
			shipper.down();
			shipper.up(() => true);
			shipper.receive({ t: "resend-after", after: 2, linesAfter: 2 });
			expect(await shipper.drained(2_000)).toBe(true);
			await session.close(context);
			await wrapped.closed?.();
		});
	});

	it("sends a commit's writes only once the store has them, also on a link that comes up while it is pending", async () => {
		await withWorld(async (made) => {
			const shipper = createShipper({ admits: () => false });
			mkdirSync(join(made.directory, "store"), { recursive: true });
			const real = await openNodeSqliteStorage(made.options.store);
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			// A store whose commit waits: its writes are in the outbox and not yet in the store.
			const slow = new Proxy(real, {
				get(target, key) {
					if (key === "commit") {
						return async (...args: Parameters<typeof real.commit>) => {
							await gate;
							return target.commit(...args);
						};
					}
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const wrapped = await shipper.wrapStore(made.options.store)(slow, context);
			const session = createSession(wrapped.storage);
			const committed = session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
			await sleep(50);
			const sent: Frame[] = [];
			shipper.up((frame) => sent.push(frame) > 0);
			shipper.receive({ t: "resend-after", after: 0, linesAfter: 0 });
			expect(sent.filter((frame) => frame.t === "record")).toEqual([]);
			release();
			await committed;
			expect(sent.filter((frame) => frame.t === "record").map((frame) => frame.commit)).toEqual([1]);
			await session.close(context);
			await wrapped.closed?.();
		});
	});

	it("keeps a snapshot until the host acknowledges it, and sends it again on the next link when one dropped first", async () => {
		await withWorld(async (made) => {
			const shipper = createShipper({
				admits: () => false,
				recording: {
					snapshotLines: async (_storage, { at }) => [{ commit: at, state: "as it was" }],
					recordCommits: () => async () => {},
				},
			});
			mkdirSync(join(made.directory, "store"), { recursive: true });
			const wrapped = await shipper.wrapStore(made.options.store)(
				await openNodeSqliteStorage(made.options.store),
				context,
			);
			const snapshots = (frames: readonly Frame[]) =>
				frames.filter((frame) => frame.t === "lines" && frame.snapshot);
			const first: Frame[] = [];
			shipper.up((frame) => first.push(frame) > 0);
			shipper.receive({ t: "resend-after", after: 0, linesAfter: 0 });
			expect(snapshots(first)).toHaveLength(1);
			// The link drops before the host acknowledged the snapshot: the next link carries it again.
			shipper.down();
			const second: Frame[] = [];
			shipper.up((frame) => second.push(frame) > 0);
			shipper.receive({ t: "resend-after", after: 0, linesAfter: 0 });
			expect(snapshots(second)).toHaveLength(1);
			expect(await shipper.drained(100)).toBe(false);
			// An acknowledgement of another commit's snapshot is not this one's.
			shipper.receive({ t: "lines-ack", commit: Number(snapshots(second)[0]?.commit) + 1, snapshot: true });
			expect(await shipper.drained(100)).toBe(false);
			shipper.receive({ t: "lines-ack", commit: Number(snapshots(second)[0]?.commit), snapshot: true });
			expect(await shipper.drained(2_000)).toBe(true);
			await wrapped.closed?.();
		});
	});

	it("lets a dead process's outbox go when the host holds it all, though it said so before the store opened", async () => {
		await withWorld(async (made) => {
			mkdirSync(join(made.directory, "store"), { recursive: true });
			// A process whose commits the host logged, and that died before their acknowledgements came.
			const dead = createShipper({ admits: () => false });
			const before = await dead.wrapStore(made.options.store)(
				await openNodeSqliteStorage(made.options.store),
				context,
			);
			const session = createSession(before.storage);
			for (let n = 0; n < 3; n += 1)
				await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
			await session.close(context);
			await before.closed?.();
			// The next process hears the host holds all three before it opens the store: nothing is left to wait for.
			const next = createShipper({ admits: () => false });
			const sent: Frame[] = [];
			next.up((frame) => sent.push(frame) > 0);
			next.receive({ t: "resend-after", after: 3, linesAfter: 3 });
			const after = await next.wrapStore(made.options.store)(
				await openNodeSqliteStorage(made.options.store),
				context,
			);
			expect(sent).toEqual([]);
			expect(await next.drained(2_000)).toBe(true);
			await after.closed?.();
		});
	});

	it("sends what a dead process left in the outbox when the store opens after the host said where it is", async () => {
		await withWorld(async (made) => {
			mkdirSync(join(made.directory, "store"), { recursive: true });
			// A process that commits with no host to send to, and dies.
			const dead = createShipper({ admits: () => false });
			const before = await dead.wrapStore(made.options.store)(
				await openNodeSqliteStorage(made.options.store),
				context,
			);
			const session = createSession(before.storage);
			for (let n = 0; n < 3; n += 1)
				await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
			await session.close(context);
			await before.closed?.();
			// The next process hears where the host is before it opens the store, as a runner does at its hello.
			const next = createShipper({ admits: () => false });
			const sent: Frame[] = [];
			next.up((frame) => sent.push(frame) > 0);
			next.receive({ t: "resend-after", after: 1, linesAfter: 0 });
			expect(sent).toEqual([]);
			const after = await next.wrapStore(made.options.store)(
				await openNodeSqliteStorage(made.options.store),
				context,
			);
			expect(sent.filter((frame) => frame.t === "record").map((frame) => frame.commit)).toEqual([2, 3]);
			const later = createSession(after.storage);
			await later.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
			expect(sent.filter((frame) => frame.t === "record").map((frame) => frame.commit)).toEqual([2, 3, 4]);
			await later.close(context);
			await after.closed?.();
		});
	});
});

describe("the host's end of the record stream", () => {
	it("appends each commit once, in order, and acknowledges one it holds already", async () => {
		const kept = memorySink();
		const replies: Frame[] = [];
		const reply = (frame: Frame) => replies.push(frame) > 0;
		const record = (commit: number): Frame => ({ t: "record", commit, writes: [] });
		// Ahead of the log: not appended and not acknowledged; the runner sends from where the host is.
		await receiveRecords(kept.sink, record(2), reply);
		expect(kept.log).toEqual([]);
		expect(replies).toEqual([]);
		await receiveRecords(kept.sink, record(1), reply);
		await receiveRecords(kept.sink, record(1), reply);
		await receiveRecords(kept.sink, record(2), reply);
		expect(kept.log.map((one) => one.commit)).toEqual([1, 2]);
		expect(replies).toEqual([
			{ t: "record-ack", commit: 1 },
			{ t: "record-ack", commit: 1 },
			{ t: "record-ack", commit: 2 },
		]);
		// Lines of a commit the log does not hold yet are not written.
		await receiveRecords(kept.sink, { t: "lines", commit: 3, lines: ["early"] }, reply);
		expect(kept.lines.size).toBe(0);
	});
});

/** Every table of a store, every row, in rowid order. */
function dump(path: string): Record<string, unknown[]> {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		const tables = database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all()
			.map((row) => String((row as { name: string }).name));
		return Object.fromEntries(
			tables.map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]),
		);
	} finally {
		database.close();
	}
}

type World = ReturnType<typeof world>;

/** The file descriptors this process holds open on `path`. */
function openOn(path: string): number {
	let count = 0;
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			if (readlinkSync(`/proc/self/fd/${fd}`) === path) count += 1;
		} catch {
			// Closed while it was listed.
		}
	}
	return count;
}

describe("a home whose store wrapper fails", () => {
	const homeOf = (made: World, wrapStore?: HomeOptions["wrapStore"]): HomeOptions => {
		const { recording: _recording, resumeWithinMs: _resume, ...base } = made.options;
		return { ...base, models: made.models, ...(wrapStore === undefined ? {} : { wrapStore }) };
	};
	/** Whether another home can take the store now: the first let it go. */
	const free = async (made: World) => {
		const other = getOrThrow(await openHome(homeOf(made)));
		const resumed = await other.resume({ epoch: 1 }, context);
		await other.close(context);
		return resumed.ok ? "free" : resumed.error.code;
	};

	it("lets the store go when the wrapper's close fails", async () => {
		await withWorld(async (made) => {
			const home = getOrThrow(
				await openHome(
					homeOf(made, async (storage) => ({
						storage,
						closed: async () => {
							throw new Error("the recorder's stop failed");
						},
					})),
				),
			);
			getOrThrow(await home.resume({ epoch: 1 }, context));
			await home.close(context).catch(() => {});
			expect(await free(made)).toBe("free");
		});
	});

	it("fails the order, closes what it opened and lets the store go when the recorder does not start", async () => {
		await withWorld(async (made) => {
			const home = getOrThrow(
				await openHome(
					homeOf(made, async (storage) => ({
						storage,
						opened: () => {
							throw new Error("the recorder did not start");
						},
					})),
				),
			);
			const resumed = await home.resume({ epoch: 1 }, context);
			expect(resumed.ok ? "" : resumed.error.message).toContain("the recorder did not start");
			expect(openOn(made.options.store)).toBe(0);
			expect(await free(made)).toBe("free");
		});
	});

	it("closes the store and the outbox, and lets the store go, when the recorder's snapshot fails", async () => {
		await withWorld(async (made) => {
			const shipper = createShipper({
				recording: {
					snapshotLines: async () => {
						throw new Error("the snapshot failed");
					},
					recordCommits: () => async () => {},
				},
			});
			const home = getOrThrow(await openHome(homeOf(made, shipper.wrapStore(made.options.store))));
			const resumed = await home.resume({ epoch: 1 }, context);
			expect(resumed.ok ? "" : resumed.error.message).toContain("the snapshot failed");
			expect(openOn(made.options.store)).toBe(0);
			expect(openOn(`${made.options.store}.outbox.jsonl`)).toBe(0);
			expect(await free(made)).toBe("free");
		});
	});
});
