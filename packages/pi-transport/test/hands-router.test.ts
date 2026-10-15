import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Box, BoxError, type BoxProvider, type BoxSpec } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { parseTransportConfig } from "../src/config.ts";
import { transport } from "../src/hands/index.ts";
import { HandsDoc, SessionBoxesDoc, TransportError } from "../src/transport.ts";
import {
	bash,
	openSession,
	registerHandsCases,
	type WatchedProvider,
	watchdogsUnder,
	watched,
} from "./hands-support.ts";

const context = BACKGROUND_CONTEXT;
// Every directory of this file lies under one root, so what a test leaves behind can be counted after the file.
let RUN_ROOT = "";
beforeAll(() => {
	// Made when a test of this file runs: a filtered run that selects none leaves no directory.
	RUN_ROOT = mkdtempSync(join(tmpdir(), "pi-transport-hands-run-"));
});
afterAll(() => {
	const left = watchdogsUnder(RUN_ROOT);
	rmSync(RUN_ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	// A box that was released and never destroyed has a watchdog that sleeps out its lifetime, a day by default.
	expect(left, "watchdogs of this file's boxes still running").toEqual([]);
}, 60_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `use` with a watched local provider in a directory of its own, and ends every box it created. */
async function withLocal(use: (provider: WatchedProvider, directory: string) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(RUN_ROOT, "d-"));
	const provider = watched(localBoxes({ root: join(directory, "boxes") }));
	try {
		await use(provider, directory);
	} finally {
		for (const box of provider.created) await box.destroy(context);
		rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

const SANDBOX = { environments: { sandbox: { provider: "local" } }, hands: "sandbox" };
const EACH = { environments: { sandbox: { provider: "local", scope: "conversation" } }, hands: "sandbox" };

/** `provider`, whose boxes end the way `destroy` says. Everything else is the provider's own. */
function endingBy(provider: BoxProvider, destroy: (box: Box) => Box["destroy"]): BoxProvider {
	return {
		name: provider.name,
		attach: (id, attachContext) => provider.attach(id, attachContext),
		list: (labels, listContext) => provider.list(labels, listContext),
		async create(spec, createContext) {
			const created = await provider.create(spec, createContext);
			if (!created.ok) return created;
			const box = created.value;
			return ok({
				id: box.id,
				facts: () => box.facts(),
				exec: (command, options, execContext) => box.exec(command, options, execContext),
				status: (statusContext) => box.status(statusContext),
				upload: (files, uploadContext) => box.upload(files, uploadContext),
				download: (paths, downloadContext) => box.download(paths, downloadContext),
				destroy: destroy(box),
			});
		},
	};
}

registerHandsCases(
	"hands on local boxes",
	async (use) => {
		const directory = mkdtempSync(join(RUN_ROOT, "d-"));
		try {
			await use({
				provider: () => localBoxes({ root: join(directory, "boxes") }),
				environment: { provider: "local" },
				directory,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	},
	60_000,
);

describe("the check for watchdogs left running", () => {
	it("sees the watchdog of a live box under a directory whose name is not ASCII, and none after destroy", async () => {
		const root = mkdtempSync(join(RUN_ROOT, "测试-é-"));
		const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 60_000 }, context));
		try {
			let seen = watchdogsUnder(root);
			// At least 20 s: a start on a loaded machine can take seconds, and the loop ends as soon as it is seen.
			for (let tries = 0; seen.length === 0 && tries < 400; tries++) {
				await sleep(50);
				seen = watchdogsUnder(root);
			}
			expect(seen.length).toBeGreaterThan(0);
		} finally {
			await box.destroy(context);
		}
		expect(watchdogsUnder(root)).toEqual([]);
	});
});

describe("transport(): what it refuses at start", () => {
	const host = { providers: {}, commit: () => Promise.reject(new Error("not used")) };
	const refusal = (config: unknown, providers: Record<string, WatchedProvider> = {}) => {
		try {
			transport(getOrThrow(parseTransportConfig(config)), { ...host, providers });
		} catch (error) {
			return error;
		}
		return undefined;
	};

	it("refuses an environment with expose: no secret is passed into a box in this release", () => {
		const error = refusal({
			environments: { sandbox: { provider: "local", expose: ["API_KEY"] } },
			hands: "sandbox",
		});
		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).code).toBe("unsupported");
		expect((error as TransportError).message).toMatch(/"sandbox" has expose, which is not available yet/);
	});

	it("refuses an environment whose provider the host did not pass, but not local", () => {
		const remote = { environments: { far: { provider: "elsewhere", maxLifetime: "1h" } }, hands: "far" };
		expect((refusal(remote) as TransportError).code).toBe("unknown_provider");
		expect((refusal(remote) as TransportError).message).toMatch(/"far" names the provider "elsewhere"/);
		expect(refusal(SANDBOX)).toBeUndefined();
	});

	it("does not take a name that every object has for a provider the host passed", () => {
		const inherited = { environments: { far: { provider: "constructor", maxLifetime: "1h" } }, hands: "far" };
		expect((refusal(inherited) as TransportError | undefined)?.code).toBe("unknown_provider");
	});

	it("refuses a host label in the providers' own namespace, and sends no label of its own", async () => {
		const config = getOrThrow(parseTransportConfig(SANDBOX));
		for (const key of ["pi-transport", "pi-transport.box"]) {
			expect(() => transport(config, { ...host, labels: { [key]: "1" } })).toThrow(/belongs to providers/);
		}
		// Every provider of this package refuses a reserved key, so a box that exists was asked for without one.
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			expect((await session.turn(await session.converse(), [bash("true")]))[0]?.isError).toBe(false);
			expect(provider.specs.map((spec) => spec.labels)).toEqual([undefined]);
			await session.harness.close(context);
		});
	});

	it("refuses hands that are left to a classifier, which this release does not have", () => {
		const auto = {
			environments: { sandbox: { provider: "local" } },
			hands: "auto",
			auto: { classifier: { provider: "p", modelId: "m" } },
		};
		expect((refusal(auto) as TransportError).code).toBe("unsupported");
	});
});

describe("transport(): where tools run", () => {
	it("leaves tools with the host when the config names no hands, or names local and the host has no local provider", async () => {
		await withLocal(async (provider) => {
			for (const [config, providers] of [
				[{ environments: { sandbox: { provider: "local" } } }, { local: provider }],
				[SANDBOX, {}],
			] as const) {
				const session = await openSession(new MemoryStorage(), config, providers);
				const conversation = await session.converse();
				expect(
					await session.hands.env({ conversationId: conversation.id, read: session.harness }, context),
				).toBeUndefined();
				await session.harness.close(context);
			}
			expect(provider.specs).toEqual([]);
		});
	});

	it("is lazy: an environment with no box yet names no box, and a command started in it runs in the box's own directory", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversation = await session.converse();
			const env = (await session.hands.env(
				{ conversationId: conversation.id, read: session.harness },
				context,
			)) as ExecutionEnv;
			expect(env.id).toBe("pi-transport:sandbox:unopened");
			expect(env.cwd).toBe(".");
			expect(getOrThrow(await env.joinPath(["a", "..", "b"], context))).toBe("b");
			expect(provider.specs).toEqual([]);

			let output = "";
			const collect = (text: string) => {
				output += text;
			};
			getOrThrow(await env.exec(["pwd"], { cwd: env.cwd, onOutput: collect }, context));
			const box = provider.created[0];
			expect(output.trim()).toBe(box?.facts().workspace);
			expect(env.id).toBe(`pi-transport:local:${box?.id}`);
			expect(env.cwd).toBe(box?.facts().workspace);
			await session.harness.close(context);
		});
	});

	it("creates one box for first uses that come at the same time", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversations = [await session.converse(), await session.converse(), await session.converse()];
			const envs = await Promise.all(
				conversations.map((conversation) =>
					session.hands.env({ conversationId: conversation.id, read: session.harness }, context),
				),
			);
			const results = await Promise.all(envs.map((env) => (env as ExecutionEnv).exec(["true"], undefined, context)));
			expect(results.map((result) => result.ok)).toEqual([true, true, true]);
			expect(provider.created.length).toBe(1);
			expect(new Set(envs.map((env) => env?.id)).size).toBe(1);
			await session.harness.close(context);
		});
	});

	it("reports a box that cannot be created as that call's error with the provider's code, and asks again at the next call", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			provider.refuseNext(new BoxError("capacity", "no machine left"));
			const outcomes = await session.turn(await session.converse(), [bash("echo one"), bash("echo two")]);
			expect(outcomes[0]?.isError).toBe(true);
			expect(outcomes[0]?.text).toContain(
				'could not create a box for environment "sandbox": [capacity] no machine left',
			);
			expect(outcomes[1]?.isError).toBe(false);
			expect(outcomes[1]?.text).toContain("two");
			expect(provider.specs.length).toBe(2);
			await session.harness.close(context);
		});
	});

	it("fails a command with unknown, never spawn_error, and a file operation with unknown, when no box can be had", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversation = await session.converse();
			const env = (await session.hands.env(
				{ conversationId: conversation.id, read: session.harness },
				context,
			)) as ExecutionEnv;
			provider.refuseNext(new BoxError("unauthorized", "the key was refused"));
			const ran = await env.exec(["true"], undefined, context);
			// pi's bash tool runs the next form of a command after a spawn error, and each form would ask for a box.
			expect(ran.ok ? "" : ran.error.code).toBe("unknown");
			expect(ran.ok ? "" : ran.error.message).toContain("[unauthorized] the key was refused");
			provider.refuseNext(new BoxError("capacity", "no machine left"));
			const read = await env.readTextFile("a.txt", context);
			expect(read.ok ? "" : read.error.code).toBe("unknown");
			expect(provider.created).toEqual([]);
			await session.harness.close(context);
		});
	});

	it("ends a box it could not record, and fails the call that needed it", async () => {
		await withLocal(async (provider) => {
			let failing = true;
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider }, undefined, (inner) => {
				return (change, commitContext) => {
					if (!failing) return inner(change, commitContext);
					failing = false;
					return Promise.reject(new Error("the store refused the write"));
				};
			});
			const outcomes = await session.turn(await session.converse(), [bash("echo one"), bash("echo two")]);
			expect(outcomes[0]?.isError).toBe(true);
			expect(outcomes[0]?.text).toMatch(/could not record box local-[0-9a-f]+: the store refused the write/);
			expect(outcomes[1]?.text).toContain("two");
			expect(provider.created.length).toBe(2);
			const [unrecorded] = provider.created;
			if (unrecorded === undefined) throw new Error("no box was created");
			expect(getOrThrow(await unrecorded.status(context)).state).toBe("ended");
			await session.harness.close(context);
		});
	});

	it("ends the boxes it has in hand even when the session's documents cannot be read", async () => {
		await withLocal(async (provider) => {
			let failing = false;
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider }, undefined, (inner) => {
				return (change, commitContext) =>
					failing ? Promise.reject(new Error("the store is closed")) : inner(change, commitContext);
			});
			expect((await session.turn(await session.converse(), [bash("true")]))[0]?.isError).toBe(false);
			const [box] = provider.created;
			if (box === undefined) throw new Error("no box was created");
			failing = true;
			const destroyed = await session.hands.destroy(context);
			expect(destroyed.ok ? "" : destroyed.error.code).toBe("store");
			expect(getOrThrow(await box.status(context)).state).toBe("ended");
			await session.harness.close(context);
		});
	});

	it("asks again after a provider threw while a box was opened, and still releases and destroys", async () => {
		await withLocal(async (provider, directory) => {
			const store = join(directory, "session.db");
			const first = await openSession(await openNodeSqliteStorage(store), SANDBOX, { local: provider });
			expect((await first.turn(await first.converse(), [bash("echo one")]))[0]?.isError).toBe(false);
			await first.hands.release(context);
			await first.harness.close(context);
			// The next host's provider breaks once where it should answer: it throws.
			let broken = true;
			const flaky: BoxProvider = {
				name: provider.name,
				create: (spec, createContext) => provider.create(spec, createContext),
				list: (labels, listContext) => provider.list(labels, listContext),
				attach(id, attachContext) {
					if (!broken) return provider.attach(id, attachContext);
					broken = false;
					return Promise.reject(new Error("the box's record could not be read"));
				},
			};
			const second = await openSession(await openNodeSqliteStorage(store), SANDBOX, { local: flaky });
			const outcomes = await second.turn(await second.converse(), [bash("echo two"), bash("echo three")]);
			expect(outcomes[0]?.isError).toBe(true);
			expect(outcomes[0]?.text).toContain(
				'could not open a box for environment "sandbox": the box\'s record could not be read',
			);
			expect(outcomes[1]?.isError).toBe(false);
			expect(outcomes[1]?.text).toContain("three");
			// The box the first host left, found at the second ask: no other was made.
			expect(provider.created.length).toBe(1);
			await second.hands.release(context);
			expect((await second.hands.destroy(context)).ok).toBe(true);
			await second.harness.close(context);
		});
	});

	it("runs the tools of an environment named like a property every object has", async () => {
		await withLocal(async (provider) => {
			const config = {
				environments: { first: { provider: "local" }, constructor: { provider: "local" } },
				hands: "first",
			};
			const asked: unknown[] = [];
			const noting: BoxProvider = {
				name: provider.name,
				create: (spec, createContext) => provider.create(spec, createContext),
				list: (labels, listContext) => provider.list(labels, listContext),
				attach: (id, attachContext) => {
					asked.push(id);
					return provider.attach(id, attachContext);
				},
			};
			const session = await openSession(new MemoryStorage(), config, { local: noting });
			// Another environment's box is in the session's document first.
			expect((await session.turn(await session.converse(), [bash("echo first")]))[0]?.isError).toBe(false);
			const other = await session.converse();
			getOrThrow(await session.hands.assign(other.id, "constructor", context));
			const outcomes = await session.turn(other, [bash("echo second")]);
			expect(outcomes[0]?.isError).toBe(false);
			expect(outcomes[0]?.text).toContain("second");
			expect(provider.created.length).toBe(2);
			// No box id was read from what the document's object inherits: a provider is never asked for a function.
			expect(asked.every((id) => typeof id === "string")).toBe(true);
			expect((await session.hands.destroy(context)).ok).toBe(true);
			await session.harness.close(context);
		});
	});

	it("ends every other box when a provider throws while destroy looks for one", async () => {
		await withLocal(async (provider, directory) => {
			const store = join(directory, "session.db");
			const first = await openSession(await openNodeSqliteStorage(store), EACH, { local: provider });
			expect((await first.turn(await first.converse(), [bash("echo one")]))[0]?.isError).toBe(false);
			expect((await first.turn(await first.converse(), [bash("echo two")]))[0]?.isError).toBe(false);
			await first.hands.release(context);
			await first.harness.close(context);
			const [broken, sound] = provider.created;
			if (broken === undefined || sound === undefined) throw new Error("two boxes were expected");
			// The next host cannot read the record of one box: its provider throws where it should answer.
			const throwing: BoxProvider = {
				name: provider.name,
				create: (spec, createContext) => provider.create(spec, createContext),
				list: (labels, listContext) => provider.list(labels, listContext),
				attach: (id, attachContext) =>
					id === broken.id
						? Promise.reject(new Error("the box's record could not be read"))
						: provider.attach(id, attachContext),
			};
			const second = await openSession(await openNodeSqliteStorage(store), EACH, { local: throwing });
			const destroyed = await second.hands.destroy(context);
			expect(destroyed.ok).toBe(false);
			if (!destroyed.ok) {
				expect(destroyed.error.code).toBe("box");
				expect(destroyed.error.message).toContain(broken.id);
			}
			expect(getOrThrow(await sound.status(context)).state).toBe("ended");
			// The box it could not reach keeps its record for the next destroy.
			expect(Object.values((await second.harness.snapshot(SessionBoxesDoc, context))?.boxes ?? {})).toEqual([
				broken.id,
			]);
			await second.harness.close(context);
		});
	});

	it("makes a command that comes during release wait, so no command outlives the release", async () => {
		await withLocal(async (provider) => {
			let letGo: () => void = () => {};
			const slowCleanup = new Promise<void>((resolve) => {
				letGo = resolve;
			});
			let cleaning = 0;
			// Boxes whose command cleanup (a script that sends signals) takes its time.
			const slow: BoxProvider = {
				name: provider.name,
				list: (labels, listContext) => provider.list(labels, listContext),
				attach: (id, attachContext) => provider.attach(id, attachContext),
				async create(spec, createContext) {
					const created = await provider.create(spec, createContext);
					if (!created.ok) return created;
					const box = created.value;
					return ok({
						id: box.id,
						facts: () => box.facts(),
						async exec(command, options, execContext) {
							if (command[0] === "sh" && /\bkill\b/.test(command[2] ?? "") && command.length > 4) {
								cleaning += 1;
								await slowCleanup;
							}
							return box.exec(command, options, execContext);
						},
						status: (statusContext) => box.status(statusContext),
						upload: (files, uploadContext) => box.upload(files, uploadContext),
						download: (paths, downloadContext) => box.download(paths, downloadContext),
						destroy: (destroyContext) => box.destroy(destroyContext),
					});
				},
			};
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: slow });
			const conversation = await session.converse();
			const env = await session.hands.env({ conversationId: conversation.id, read: session.harness }, context);
			if (env === undefined) throw new Error("an environment was expected");
			// A command still runs when the release starts, so the release has a command to stop.
			const long = env.exec("sleep 30", undefined, context);
			await sleep(500);
			const releasing = session.hands.release(context);
			let releasedAt = 0;
			void releasing.then(() => {
				releasedAt = Date.now();
			});
			while (cleaning === 0) await sleep(10);
			let lateAt = 0;
			const late = env.exec("echo late", undefined, context).then((result) => {
				lateAt = Date.now();
				return result;
			});
			await sleep(300);
			expect(lateAt).toBe(0);
			letGo();
			await releasing;
			expect(getOrThrow(await late).exitCode).toBe(0);
			expect(lateAt).toBeGreaterThanOrEqual(releasedAt);
			await long;
			expect((await session.hands.destroy(context)).ok).toBe(true);
			await session.harness.close(context);
		});
	});

	it("makes a tool call that comes during destroy wait, so the box it opens keeps its record", async () => {
		await withLocal(async (provider) => {
			let letEnd: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				letEnd = resolve;
			});
			let ending = 0;
			// Boxes that take their time to end.
			const slow = endingBy(provider, (box) => async (destroyContext) => {
				ending += 1;
				await held;
				return box.destroy(destroyContext);
			});
			const session = await openSession(new MemoryStorage(), EACH, { local: slow });
			expect((await session.turn(await session.converse(), [bash("echo early")]))[0]?.isError).toBe(false);
			const destroying = session.hands.destroy(context);
			while (ending === 0) await sleep(10);
			// A tool call of another conversation, which needs a box of its own, while the first box is still ending.
			const late = session.turn(await session.converse(), [bash("echo late")]);
			await sleep(300);
			expect(provider.created.length).toBe(1);
			letEnd();
			expect((await destroying).ok).toBe(true);
			const outcomes = await late;
			expect(outcomes[0]?.isError).toBe(false);
			expect(outcomes[0]?.text).toContain("late");
			const [first, second] = provider.created;
			if (first === undefined || second === undefined) throw new Error("two boxes were expected");
			expect(getOrThrow(await first.status(context)).state).toBe("ended");
			expect(getOrThrow(await second.status(context)).state).toBe("running");
			// The box opened after the shutdown is the one the session's document names: a later destroy ends it.
			expect(Object.values((await session.harness.snapshot(SessionBoxesDoc, context))?.boxes ?? {})).toEqual([
				second.id,
			]);
			expect((await session.hands.destroy(context)).ok).toBe(true);
			expect(getOrThrow(await second.status(context)).state).toBe("ended");
			expect((await session.harness.snapshot(SessionBoxesDoc, context))?.boxes).toEqual({});
			await session.harness.close(context);
		});
	});

	it("clears the record of each box that ended, and keeps the record of one that would not end", async () => {
		await withLocal(async (provider) => {
			let stubborn: string | undefined;
			// The first box refuses to end until the test says so.
			const partly = endingBy(provider, (box) => async (destroyContext) => {
				stubborn ??= box.id;
				if (stubborn === box.id) return { ok: false, error: new BoxError("timeout", "the vendor did not answer") };
				return box.destroy(destroyContext);
			});
			const session = await openSession(new MemoryStorage(), EACH, { local: partly });
			expect((await session.turn(await session.converse(), [bash("echo one")]))[0]?.isError).toBe(false);
			expect((await session.turn(await session.converse(), [bash("echo two")]))[0]?.isError).toBe(false);
			const [first, second] = provider.created;
			if (first === undefined || second === undefined) throw new Error("two boxes were expected");
			const destroyed = await session.hands.destroy(context);
			expect(destroyed.ok ? "" : destroyed.error.code).toBe("box");
			expect(destroyed.ok ? "" : destroyed.error.message).toContain(
				`${first.id} ([timeout] the vendor did not answer)`,
			);
			expect(getOrThrow(await second.status(context)).state).toBe("ended");
			// What is left is still findable: its record stays, the other's is gone.
			expect(Object.values((await session.harness.snapshot(SessionBoxesDoc, context))?.boxes ?? {})).toEqual([
				first.id,
			]);
			await session.harness.close(context);
		});
	});

	it("forgets at destroy a box its provider no longer has", async () => {
		await withLocal(async (provider, directory) => {
			const store = join(directory, "session.db");
			const first = await openSession(await openNodeSqliteStorage(store), SANDBOX, { local: provider });
			expect((await first.turn(await first.converse(), [bash("echo one")]))[0]?.isError).toBe(false);
			await first.hands.release(context);
			await first.harness.close(context);
			const [box] = provider.created;
			if (box === undefined) throw new Error("no box was created");
			// The box ends behind the session's back, as at the end of its lifetime.
			getOrThrow(await box.destroy(context));
			const second = await openSession(await openNodeSqliteStorage(store), SANDBOX, { local: provider });
			expect(Object.values((await second.harness.snapshot(SessionBoxesDoc, context))?.boxes ?? {})).toEqual([
				box.id,
			]);
			expect((await second.hands.destroy(context)).ok).toBe(true);
			expect((await second.harness.snapshot(SessionBoxesDoc, context))?.boxes).toEqual({});
			await second.harness.close(context);
		});
	});

	it("labels every box and hands the environment's settings and the workspace to the provider", async () => {
		await withLocal(async (provider, directory) => {
			const workspace = join(directory, "workspace");
			const config = {
				environments: {
					sandbox: {
						provider: "elsewhere",
						image: "tools:1",
						cpus: 2,
						memoryMb: 512,
						env: { MODE: "test" },
						maxLifetime: "2h",
					},
				},
				hands: "sandbox",
				workspace: { path: workspace },
			};
			// A provider that takes an image and a size, which a local box refuses: they stop here.
			const specs: BoxSpec[] = [];
			const elsewhere: BoxProvider = {
				name: "elsewhere",
				create: (spec, createContext) => {
					specs.push(spec);
					const { image: _image, cpus: _cpus, memoryMb: _memoryMb, ...honoured } = spec;
					return provider.create(honoured, createContext);
				},
				attach: (id, attachContext) => provider.attach(id, attachContext),
				list: (labels, listContext) => provider.list(labels, listContext),
			};
			const labels = { team: "docs" };
			const session = await openSession(new MemoryStorage(), config, { elsewhere }, labels);
			expect((await session.turn(await session.converse(), [bash("echo $MODE")]))[0]?.text).toContain("test");
			expect(specs).toEqual([
				{
					maxLifetimeMs: 2 * 3_600_000,
					labels: { team: "docs" },
					env: { MODE: "test" },
					image: "tools:1",
					cpus: 2,
					memoryMb: 512,
					workspace,
				},
			]);
			await session.harness.close(context);
		});
	});

	it("follows the agent's directory only inside the box's workspace", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversation = await session.converse();
			const target = { conversationId: conversation.id, read: session.harness };
			const first = (await session.hands.env(target, context)) as ExecutionEnv;
			const workspace = getOrThrow(await first.absolutePath(".", context));
			mkdirSync(join(workspace, "sub"));
			const inside = (await session.hands.env({ ...target, cwd: join(workspace, "sub") }, context)) as ExecutionEnv;
			expect(getOrThrow(await inside.absolutePath("x", context))).toBe(join(workspace, "sub", "x"));
			const outside = (await session.hands.env({ ...target, cwd: "/a/path/of/the/host" }, context)) as ExecutionEnv;
			expect(getOrThrow(await outside.absolutePath("x", context))).toBe(join(workspace, "x"));
			expect(provider.created.length).toBe(1);
			await session.harness.close(context);
		});
	});

	it("gives a fork the default environment, not its parent's assignment", async () => {
		await withLocal(async (provider) => {
			const config = {
				environments: { sandbox: { provider: "local" }, other: { provider: "local" } },
				hands: { default: "sandbox", build: "other" },
			};
			const session = await openSession(new MemoryStorage(), config, { local: provider });
			const parent = await session.converse();
			expect((await session.turn(parent, [bash("echo default > where.txt")]))[0]?.isError).toBe(false);
			getOrThrow(await session.hands.assign(parent.id, "build", context));
			const newest = (await parent.entries({}, 1, undefined, context)).items[0];
			if (newest === undefined) throw new Error("the conversation has no entry");
			const fork = await parent.fork(newest.id, { ownership: { kind: "ownerless" } }, context);
			expect(await session.harness.snapshot(HandsDoc, parent.id, context)).toEqual({ environment: "other" });
			expect((await session.harness.snapshot(HandsDoc, fork.id, context))?.environment).toBeUndefined();
			expect((await session.turn(fork, [bash("cat where.txt")]))[0]?.text).toContain("default");
			await session.harness.close(context);
		});
	});

	it("stops the commands it still runs on release, and leaves the box", async () => {
		await withLocal(async (provider) => {
			const session = await openSession(new MemoryStorage(), SANDBOX, { local: provider });
			const conversation = await session.converse();
			const env = (await session.hands.env(
				{ conversationId: conversation.id, read: session.harness },
				context,
			)) as ExecutionEnv;
			const tag = `pi-transport-release-${process.pid}-${Date.now()}`;
			const running = () => spawnSync("pgrep", ["-f", tag]).stdout.toString().trim() !== "";
			const pending = env.exec(`sleep 30 & sleep 30 # ${tag}\nwait`, undefined, context);
			for (let tries = 0; !running(); tries++) {
				if (tries > 400) throw new Error("the command did not start");
				await sleep(50);
			}
			await session.hands.release(context);
			expect(getOrThrow(await pending).exitCode).toBeGreaterThan(128);
			expect(running()).toBe(false);
			const box = provider.created[0];
			if (box === undefined) throw new Error("no box was created");
			expect(getOrThrow(await box.status(context)).state).toBe("running");
			await session.harness.close(context);
		});
	});
});

describe("what the router leans on in pi", () => {
	// The router records a box's id with the Harness's `commit` while a tool call is under way, and reads documents
	// inside `env`. pi says `env` is never called on the Session line; this holds it to that on the version in use.
	it("lets an environment function commit to the session before a tool runs", async () => {
		const Count = defineDoc<{ commits: number }>({
			kind: "test.env-commits",
			version: 1,
			scope: "session",
			initial: () => ({ commits: 0 }),
		});
		const directory = mkdtempSync(join(RUN_ROOT, "d-"));
		try {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const registry = createRegistry();
			registry.install(CodingTools);
			let harness: Harness | undefined;
			harness = await Harness.open(
				new MemoryStorage(),
				{
					models,
					registry,
					env: async (_target, envContext) => {
						await (harness as Harness).commit(async (tx) => {
							(await tx.doc(Count)).commits += 1;
						}, envContext);
						return new NodeExecutionEnv({ cwd: directory });
					},
				},
				context,
			);
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo ran" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done."),
			]);
			const model = { provider: "faux", modelId: faux.getModel().id };
			const conversation = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model } },
				context,
			);
			await (await conversation.submit({ type: "input", content: "Go on." }, context)).wait(context);
			// Once for each of the two prompts, and once for the tool call.
			expect((await harness.snapshot(Count, context))?.commits).toBe(3);
			await harness.close(context);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
