import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, type StorageWrite } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { App } from "../src/home/app.ts";
import { connectHome, type HomeHandle } from "../src/home/host.ts";
import { linkPair } from "../src/home/link.ts";
import { type ModelServer, serveModels } from "../src/home/models.ts";
import type { Recording, RecordLine, RecordSink } from "../src/home/records.ts";
import { createRunner, EXIT_REFUSED, type Runner, type RunnerOptions } from "../src/home/runner.ts";
import { textResult } from "../src/testing/tool-result.ts";

const context = BACKGROUND_CONTEXT;
const ROUNDS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A session with a tool round for each of `ROUNDS`, and the place it runs. */
function world() {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-records-"));
	const effects = join(directory, "effects.log");
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
	return { sink, log, lines, events };
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
			host.close("done");
			await runner.home?.close(context);
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
			await sleep(80);
			first.close("gone");
			// A host that does not take the stream: what the runner commits now stays in its outbox.
			const blind = await hold(made, runner, 1, undefined, server);
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
