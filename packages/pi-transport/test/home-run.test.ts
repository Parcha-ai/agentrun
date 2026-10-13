import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	AgentDoc,
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { parseTransportConfig } from "../src/config.ts";
import { type App, loadApp } from "../src/home/app.ts";
import { DrainError } from "../src/home/gate.ts";
import { checkHomeHands } from "../src/home/place.ts";
import { type Home, type HomeOptions, MOVE_ENTRY, openHome } from "../src/home/run.ts";
import type { Seal } from "../src/home/store.ts";

const context = BACKGROUND_CONTEXT;
const ROUNDS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A session's world for one test: a model that works in rounds, and the effects its tool left. */
type World = {
	readonly directory: string;
	readonly models: MutableModels;
	readonly model: { readonly provider: string; readonly modelId: string };
	/** Requests the model has answered. */
	requests(): number;
	/** One line for each time the tool ran, in order. */
	effects(): string[];
	/** The app: one tool with an effect, and a root conversation that works in the home's workspace. */
	readonly app: App;
	/** What a home in the directory `name` needs. */
	home(name: string, overrides?: Partial<HomeOptions>): HomeOptions;
};

/**
 * A model that calls `work` once for each round and then answers "done". It is stateless: its next step depends
 * only on the transcript, so it goes on wherever the session is opened.
 */
function world(): World {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-home-"));
	const effects = join(directory, "effects.log");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let requests = 0;
	faux.setResponses(
		Array.from({ length: 200 }, () => async (transcript: { messages: readonly { role: string }[] }) => {
			requests += 1;
			await sleep(10 + (requests % 4) * 10);
			const done = transcript.messages.filter((message) => message.role === "toolResult").length;
			if (done >= ROUNDS) return fauxAssistantMessage("done");
			return fauxAssistantMessage(fauxToolCall("work", { n: done }, { id: `call-${done}-${requests}` }), {
				stopReason: "toolUse",
			});
		}),
	);
	const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
	const work = defineTool({
		name: "work",
		description: "Do one unit of work with an effect.",
		parameters: Type.Object({ n: Type.Number() }),
		async execute(args) {
			await sleep(20);
			appendFileSync(effects, `${args.n}\n`);
			await sleep(10);
			return { content: [{ type: "text", text: `did ${args.n}` }] };
		},
	});
	const app: App = (ctx) => {
		const registry = createRegistry();
		registry.install(defineExtension({ name: "work", tools: [work] }));
		return { registry, root: { agent: { model, cwd: ctx.workspace } } };
	};
	return {
		directory,
		models,
		model,
		requests: () => requests,
		effects: () => (existsSync(effects) ? readFileSync(effects, "utf8").trim().split("\n").filter(Boolean) : []),
		app,
		home(name, overrides) {
			const workspace = join(directory, name, "work");
			mkdirSync(workspace, { recursive: true });
			return {
				app,
				session: "session-1",
				store: join(directory, name, "store", "run.sqlite"),
				workspace,
				where: { environment: name, provider: "local" },
				models,
				...overrides,
			};
		},
	};
}

async function withWorld(use: (world: World) => Promise<void>): Promise<void> {
	const made = world();
	try {
		await use(made);
	} finally {
		rmSync(made.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

async function opened(options: HomeOptions): Promise<Home> {
	return getOrThrow(await openHome(options));
}

/** Start the session's one run in `home` and return its root conversation. The run is not awaited. */
async function start(home: Home): Promise<Conversation> {
	const root = getOrThrow(await home.root(context));
	await root.submit({ type: "input", content: "go" }, context);
	return root;
}

/** Drain and seal `home` after `afterMs`, and return the seal. */
async function sealAfter(home: Home, afterMs: number): Promise<Seal> {
	await sleep(afterMs);
	getOrThrow(await home.drain({ timeoutMs: 5_000 }, context));
	return getOrThrow(await home.seal(context));
}

/** What a finished run left in the conversation: tool results by diagnostic, notices, and the last answer. */
async function transcript(root: Conversation) {
	const page = await root.entries({}, 500, undefined, context);
	const texts = page.items.map((entry) => JSON.stringify(entry));
	return {
		interrupted: texts.filter((text) => text.includes('"interrupted"')).length,
		blocked: texts.filter((text) => text.includes('"blocked"')).length,
		notices: page.items.filter((entry) => entry.kind === MOVE_ENTRY),
		answered: texts.some((text) => text.includes('"done"')),
	};
}

const everyRoundOnce = Array.from({ length: ROUNDS }, (_, n) => String(n));

describe("a home: starting and moving a session", () => {
	it("starts a session that is new, runs it, and opens nothing before it is told to", async () => {
		await withWorld(async (made) => {
			const options = made.home("a");
			const home = await opened(options);
			expect(home.state).toBe("closed");
			expect(existsSync(options.store)).toBe(false);
			getOrThrow(await home.resume({ epoch: 1 }, context));
			expect(home.state).toBe("open");
			const root = await start(home);
			await root.waitForIdle(context);
			expect(made.effects()).toEqual(everyRoundOnce);
			expect(made.requests()).toBe(ROUNDS + 1);
			await home.close(context);
		});
	});

	it("moves a running session to another home with nothing cut, one notice and its directory rewritten", async () => {
		for (const afterMs of [0, 40, 90, 150, 220]) {
			await withWorld(async (made) => {
				const from = made.home("a");
				const to = made.home("b");
				const source = await opened(from);
				getOrThrow(await source.resume({ epoch: 1 }, context));
				await start(source);
				const seal = await sealAfter(source, afterMs);
				expect(source.state).toBe("sealed");
				mkdirSync(dirname(to.store), { recursive: true });
				copyFileSync(from.store, to.store);

				const target = await opened(to);
				const move = {
					id: `move-${afterMs}`,
					notice: "System notice: you now run in b.",
				};
				getOrThrow(await target.resume({ epoch: 2, seal, move }, context));
				const root = getOrThrow(await target.root(context));
				await root.waitForIdle(context);

				const seen = await transcript(root);
				expect(seen, `moved after ${afterMs} ms`).toMatchObject({ interrupted: 0, blocked: 0, answered: true });
				expect(seen.notices.length).toBe(1);
				expect(made.effects().sort()).toEqual(everyRoundOnce);
				expect(made.requests()).toBe(ROUNDS + 1);
				expect((await target.harness?.snapshot(AgentDoc, root.id, context))?.cwd).toBe(to.workspace);

				// The source is told the session lives elsewhere: its copy goes.
				getOrThrow(await source.retire({ epoch: 2 }, context));
				expect(source.state).toBe("retired");
				expect(existsSync(from.store)).toBe(false);
				await target.close(context);
			});
		}
	}, 60_000);
});

describe("a home: the target's steps are safe to repeat", () => {
	/** A sealed session in `a`, copied to `b`, with the order that makes `b` its home. The new root lies under the old. */
	async function shipped(made: World) {
		const from = made.home("a");
		const source = await opened(from);
		getOrThrow(await source.resume({ epoch: 1 }, context));
		await start(source);
		const seal = await sealAfter(source, 60);
		const to = made.home("b", { workspace: join(from.workspace, "inner") });
		mkdirSync(to.workspace, { recursive: true });
		mkdirSync(dirname(to.store), { recursive: true });
		copyFileSync(from.store, to.store);
		const order = {
			epoch: 2,
			seal,
			move: {
				id: "move-1",
				notice: "System notice: you now run in b.",
			},
		};
		return { to, order };
	}

	async function finishes(made: World, to: HomeOptions, home: Home) {
		const root = getOrThrow(await home.root(context));
		await root.waitForIdle(context);
		const seen = await transcript(root);
		expect(seen).toMatchObject({ interrupted: 0, blocked: 0, answered: true });
		expect(seen.notices.length).toBe(1);
		expect(made.effects().sort()).toEqual(everyRoundOnce);
		expect(made.requests()).toBe(ROUNDS + 1);
		// Rewritten once: a second pass would have put it one level deeper, the new root being under the old.
		expect((await home.harness?.snapshot(AgentDoc, root.id, context))?.cwd).toBe(to.workspace);
		await home.close(context);
	}

	it("opens its own store again after it died between the marker and the open", async () => {
		await withWorld(async (made) => {
			const { to, order } = await shipped(made);
			// The first process verified the store and wrote the marker, then its app failed to build.
			const broken = await opened({ ...to, app: () => Promise.reject(new Error("the app's module is broken")) });
			const failed = await broken.resume(order, context);
			expect(failed.ok ? "" : failed.error.code).toBe("app");
			// A Harness opened the store meanwhile and died: the head has moved past the seal.
			const stray = await Harness.open(
				await openNodeSqliteStorage(to.store),
				{ models: made.models, registry: createRegistry() },
				context,
			);
			await stray.close(context);
			const again = await opened(to);
			getOrThrow(await again.resume(order, context));
			await finishes(made, to, again);
		});
	});

	it("goes on after it died once the conversations were rewritten and before the notice", async () => {
		await withWorld(async (made) => {
			const { to, order } = await shipped(made);
			const base = made.app;
			let failing = true;
			const app: App = async (ctx) => ({
				...(await base(ctx)),
				onOpen: () => {
					if (failing) throw new Error("killed here");
				},
			});
			const first = await opened({ ...to, app });
			const failed = await first.resume(order, context);
			expect(failed.ok ? "" : failed.error.message).toContain("killed here");
			expect(first.state).toBe("closed");
			failing = false;
			const again = await opened({ ...to, app });
			getOrThrow(await again.resume(order, context));
			await finishes(made, to, again);
		});
	});

	it("admits the notice once when it died after the notice and resumes again", async () => {
		await withWorld(async (made) => {
			const { to, order } = await shipped(made);
			const first = await opened(to);
			getOrThrow(await first.resume(order, context));
			await first.close(context);
			const again = await opened(to);
			getOrThrow(await again.resume(order, context));
			await finishes(made, to, again);
		});
	});
});

describe("a home: what it refuses", () => {
	it("opens no store that no seal vouches for, and none that is not the sealed one", async () => {
		await withWorld(async (made) => {
			const from = made.home("a");
			const source = await opened(from);
			getOrThrow(await source.resume({ epoch: 1 }, context));
			await start(source);
			const seal = await sealAfter(source, 50);
			const to = made.home("b");
			mkdirSync(dirname(to.store), { recursive: true });
			copyFileSync(from.store, to.store);
			const target = await opened(to);
			const unvouched = await target.resume({ epoch: 2 }, context);
			expect(unvouched.ok ? "" : unvouched.error.code).toBe("not_verified");
			const other = await target.resume({ epoch: 2, seal: { ...seal, sha256: "0".repeat(64) } }, context);
			expect(other.ok ? "" : other.error.code).toBe("seal_mismatch");
			expect(target.state).toBe("closed");
			expect(existsSync(`${to.store}.home.json`)).toBe(false);
		});
	});

	it("stays sealed until it is told to reopen, also in a new process, and then goes on with nothing cut", async () => {
		await withWorld(async (made) => {
			const options = made.home("a");
			const source = await opened(options);
			getOrThrow(await source.resume({ epoch: 1 }, context));
			await start(source);
			await sealAfter(source, 70);
			// The process is gone. The next one finds the seal and waits.
			const restarted = await opened(options);
			expect(restarted.state).toBe("sealed");
			const byItself = await restarted.resume({ epoch: 1 }, context);
			expect(byItself.ok ? "" : byItself.error.code).toBe("wrong_state");
			const wrongEpoch = await restarted.reopen({ epoch: 2 }, context);
			expect(wrongEpoch.ok ? "" : wrongEpoch.error.code).toBe("stale_epoch");
			expect(made.effects().length).toBeLessThan(ROUNDS);
			getOrThrow(await restarted.reopen({ epoch: 1 }, context));
			const root = getOrThrow(await restarted.root(context));
			await root.waitForIdle(context);
			expect(await transcript(root)).toMatchObject({ interrupted: 0, blocked: 0, answered: true });
			expect(made.effects().sort()).toEqual(everyRoundOnce);
			expect(made.requests()).toBe(ROUNDS + 1);
			await restarted.close(context);
		});
	});

	it("takes no order for an epoch it has left behind, and seals only after a drain", async () => {
		await withWorld(async (made) => {
			const options = made.home("a");
			const home = await opened(options);
			getOrThrow(await home.resume({ epoch: 3 }, context));
			const early = await home.seal(context);
			expect(early.ok ? "" : early.error.code).toBe("wrong_state");
			const twice = await home.resume({ epoch: 3 }, context);
			expect(twice.ok ? "" : twice.error.code).toBe("wrong_state");
			const notLater = await home.retire({ epoch: 3 }, context);
			expect(notLater.ok ? "" : notLater.error.code).toBe("stale_epoch");
			expect(home.state).toBe("open");
			await home.close(context);
			const older = await (await opened(options)).resume({ epoch: 2 }, context);
			expect(older.ok ? "" : older.error.code).toBe("stale_epoch");
		});
	});

	it("stops and deletes its copy when a later epoch retires it while it runs", async () => {
		await withWorld(async (made) => {
			const options = made.home("a");
			const home = await opened(options);
			getOrThrow(await home.resume({ epoch: 1 }, context));
			await start(home);
			await sleep(60);
			getOrThrow(await home.retire({ epoch: 2 }, context));
			expect(home.state).toBe("retired");
			expect(home.harness).toBeUndefined();
			expect(existsSync(options.store)).toBe(false);
			expect(existsSync(`${options.store}.home.json`)).toBe(false);
			const ran = made.effects().length;
			await sleep(200);
			expect(made.effects().length).toBe(ran);
		});
	});
});

describe("a home: a move that is given up", () => {
	it("lets held work go on in the same home when a completed drain is abandoned, and then refuses a seal", async () => {
		await withWorld(async (made) => {
			const home = await opened(made.home("a"));
			getOrThrow(await home.resume({ epoch: 1 }, context));
			const root = await start(home);
			await sleep(60);
			const drained = getOrThrow(await home.drain({ timeoutMs: 5_000 }, context));
			expect(drained.held).toBe(1);
			const before = made.effects().length;
			await sleep(150);
			// Held: nothing moves.
			expect(made.effects().length).toBe(before);
			home.abandon();
			const sealed = await home.seal(context);
			expect(sealed.ok ? "" : sealed.error.code).toBe("wrong_state");
			await root.waitForIdle(context);
			expect(await transcript(root)).toMatchObject({ interrupted: 0, blocked: 0, answered: true });
			expect(made.effects()).toEqual(everyRoundOnce);
			expect(made.requests()).toBe(ROUNDS + 1);
			await home.close(context);
		});
	});
});

describe("a home: a drain that does not complete", () => {
	it("says what held it, leaves the session running, and lets it be given up", async () => {
		await withWorld(async (made) => {
			// The drain starts once the tool is executing, past the gate: a fixed wait could end before a slow model asked for it,
			// and then the drain would rightly hold the tool at the gate instead of timing out.
			let executing: () => void = () => {};
			const running = new Promise<void>((resolve) => {
				executing = resolve;
			});
			const stuck = defineTool({
				name: "work",
				description: "A unit of work that takes a while.",
				parameters: Type.Object({ n: Type.Number() }),
				async execute(args) {
					executing();
					await sleep(400);
					return { content: [{ type: "text", text: `did ${args.n}` }] };
				},
			});
			const app: App = (ctx) => {
				const registry = createRegistry();
				registry.install(defineExtension({ name: "work", tools: [stuck] }));
				return { registry, root: { agent: { model: made.model, cwd: ctx.workspace } } };
			};
			const home = await opened(made.home("a", { app }));
			getOrThrow(await home.resume({ epoch: 1 }, context));
			const root = await start(home);
			await running;
			const drained = await home.drain({ timeoutMs: 100 }, context);
			expect(drained.ok ? undefined : drained.error).toBeInstanceOf(DrainError);
			const error = drained.ok ? undefined : (drained.error as DrainError);
			expect(error?.code).toBe("timeout");
			expect(error?.holdouts).toEqual([{ kind: "pi.tool", count: 1 }]);
			expect(home.state).toBe("open");
			const sealed = await home.seal(context);
			expect(sealed.ok ? "" : sealed.error.code).toBe("wrong_state");
			// A drain given up from outside: the caller's context ends it, and work goes on.
			const controller = new AbortController();
			const pending = home.drain({ timeoutMs: 60_000 }, withAbortSignal(controller.signal, context));
			await sleep(50);
			controller.abort();
			const aborted = await pending;
			expect(aborted.ok ? "" : (aborted.error as DrainError).code).toBe("aborted");
			home.abandon();
			await root.waitForIdle(context);
			expect(await transcript(root)).toMatchObject({ interrupted: 0, blocked: 0, answered: true });
			await home.close(context);
		});
	}, 30_000);
});

describe("a home: the app", () => {
	it("refuses an app that throws or returns no registry, and opens nothing", async () => {
		await withWorld(async (made) => {
			const options = made.home("a");
			for (const app of [() => Promise.reject(new Error("no config")), () => ({}) as never]) {
				const home = await opened({ ...options, app });
				const refused = await home.resume({ epoch: 1 }, context);
				expect(refused.ok ? "" : refused.error.code).toBe("app");
				expect(home.state).toBe("closed");
				expect(existsSync(options.store)).toBe(false);
			}
		});
	});

	it("loads an app from a module file by its default export", async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const loaded = await loadApp(join(here, "home-app.fixture.ts"));
		expect(typeof getOrThrow(loaded)).toBe("function");
		const missing = await loadApp(join(here, "no-such-app.ts"));
		expect(missing.ok ? "" : missing.error.message).toContain("cannot load the app module");
		const plain = await loadApp(join(here, "home-support.ts"));
		expect(plain.ok ? "" : plain.error.message).toContain("has no default export function");
	});
});

describe("a home: where its tools may run", () => {
	const environments = {
		here: { provider: "local" },
		box: { provider: "docker", maxLifetime: "1h" },
		other: { provider: "docker", maxLifetime: "1h" },
	};
	const check = (hands: unknown, home: string) => {
		const config = getOrThrow(parseTransportConfig({ environments, ...(hands === undefined ? {} : { hands }) }));
		const checked = checkHomeHands(config, home);
		return checked.ok ? "ok" : checked.error.code;
	};

	it("lets a home on this machine send its tools anywhere, and a home in a box only to its own box", () => {
		expect(check(undefined, "here")).toBe("ok");
		expect(check("other", "here")).toBe("ok");
		expect(check({ default: "box", build: "other" }, "here")).toBe("ok");
		expect(check(undefined, "box")).toBe("ok");
		expect(check("box", "box")).toBe("ok");
		expect(check({ default: "box", build: "box" }, "box")).toBe("ok");
		expect(check("other", "box")).toBe("unsupported");
		expect(check("here", "box")).toBe("unsupported");
		expect(check({ default: "box", build: "other" }, "box")).toBe("unsupported");
		expect(check(undefined, "nowhere")).toBe("unknown_environment");
		// A name every object has is not an environment.
		expect(check(undefined, "constructor")).toBe("unknown_environment");
	});

	it("says in the refusal which environment the hands name and that it comes later", () => {
		const config = getOrThrow(parseTransportConfig({ environments, hands: { default: "box", build: "other" } }));
		const refused = checkHomeHands(config, "box");
		expect(refused.ok ? "" : refused.error.message).toMatch(/hands names "other".*later release/);
	});
});
