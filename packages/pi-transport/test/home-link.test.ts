import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { App } from "../src/home/app.ts";
import { connectHome, type HomeHandle } from "../src/home/host.ts";
import { type Frame, linkPair } from "../src/home/link.ts";
import { createRunner, EXIT_REFUSED, type Runner, type RunnerOptions } from "../src/home/runner.ts";

const context = BACKGROUND_CONTEXT;
const ROUNDS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One session's world: the host's models, the tool's effects, and the places it can run. */
function world() {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-link-"));
	const effects = join(directory, "effects.log");
	const faux = fauxProvider({ api: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	let requests = 0;
	// A stateless model: one call of `work` for each round, then a last word.
	faux.setResponses(
		Array.from({ length: 200 }, () => async (transcript: { messages: readonly { role: string }[] }) => {
			requests += 1;
			await sleep(15);
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
			await sleep(25);
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
		requests: () => requests,
		effects: () => (existsSync(effects) ? readFileSync(effects, "utf8").trim().split("\n").filter(Boolean) : []),
		place(name: string): RunnerOptions {
			const workspace = join(directory, name, "work");
			mkdirSync(workspace, { recursive: true });
			return {
				app,
				session: "session-1",
				store: join(directory, name, "store", "run.sqlite"),
				workspace,
				where: { environment: name, provider: "local" },
				resumeWithinMs: 2_000,
			};
		},
		remove() {
			rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		},
	};
}

type World = ReturnType<typeof world>;

async function withWorld(use: (made: World) => Promise<void>): Promise<void> {
	const made = world();
	try {
		await use(made);
	} finally {
		made.remove();
	}
}

/** A runner and the host's hold on it, over a fresh pair of links. */
async function linked(made: World, runner: Runner, epoch: number): Promise<HomeHandle> {
	const [runnerEnd, hostEnd] = linkPair();
	runner.attach(runnerEnd);
	const handle = connectHome(hostEnd, { models: made.models, epoch });
	getOrThrow(await handle.ready);
	return handle;
}

const everyRound = Array.from({ length: ROUNDS }, (_, n) => String(n));

/** A runner of the test's own: it answers the host's frames with `answer`, and its ready frame with `ready`. */
function fakeRunner(ready: Frame, answer: (order: string) => unknown) {
	const [runnerEnd, hostEnd] = linkPair();
	runnerEnd.onFrame((frame) => {
		if (frame.t === "hello") runnerEnd.send(ready);
		if (frame.t === "order")
			runnerEnd.send({ t: "answer", id: frame.id, ok: true, value: answer(String(frame.order)) });
	});
	return hostEnd;
}

describe("the host does not take a runner's answer on trust", () => {
	const models = createModels();
	const readyFrame: Frame = { t: "ready", v: 1, ok: true, session: "s", state: "closed" };

	it("refuses a ready frame in no known state", async () => {
		const host = connectHome(
			fakeRunner({ ...readyFrame, state: "running everywhere" }, () => null),
			{ models, epoch: 1 },
		);
		const ready = await host.ready;
		expect(ready.ok ? "" : ready.error.code).toBe("invalid");
	});

	it("refuses a seal whose head, hash or size is not one", async () => {
		const good = { head: 7, sha256: "a".repeat(64), bytes: 4096 };
		for (const seal of [
			{ ...good, head: -1 },
			{ ...good, head: 1.5 },
			{ ...good, sha256: "A".repeat(64) },
			{ ...good, sha256: "abc" },
			{ ...good, bytes: "4096" },
			null,
		]) {
			const host = connectHome(
				fakeRunner(readyFrame, () => seal),
				{ models, epoch: 1 },
			);
			const sealed = await host.seal(context);
			expect(sealed.ok ? "taken" : sealed.error.code, JSON.stringify(seal)).toBe("invalid");
		}
		const host = connectHome(
			fakeRunner(readyFrame, () => good),
			{ models, epoch: 1 },
		);
		expect(getOrThrow(await host.seal(context))).toEqual(good);
	});

	it("refuses a status in no known state or with an epoch that is not a whole number", async () => {
		for (const status of [
			{ state: "bogus", epoch: 1 },
			{ state: "open", epoch: 1.5 },
			{ state: "open", epoch: "1" },
			{ state: "open" },
		]) {
			const host = connectHome(
				fakeRunner(readyFrame, () => status),
				{ models, epoch: 1 },
			);
			const answered = await host.status(context);
			expect(answered.ok ? "taken" : answered.error.code, JSON.stringify(status)).toBe("invalid");
		}
		const host = connectHome(
			fakeRunner(readyFrame, () => ({ state: "sealed", epoch: null })),
			{ models, epoch: 1 },
		);
		expect(getOrThrow(await host.status(context))).toEqual({ state: "sealed", epoch: null });
	});
});

describe("a home over a link", () => {
	it("runs a session, moves it to another runner with nothing cut, and retires the first", async () => {
		await withWorld(async (made) => {
			const from = made.place("a");
			const source = createRunner(from);
			const first = await linked(made, source, 1);
			getOrThrow(await first.resume({ epoch: 1 }, context));
			getOrThrow(await first.submit("go", undefined, context));
			await sleep(120);
			const drained = getOrThrow(await first.drain({ timeoutMs: 5_000 }, context));
			expect(drained.held).toBe(1);
			const seal = getOrThrow(await first.seal(context));

			const to = made.place("b");
			mkdirSync(dirname(to.store), { recursive: true });
			copyFileSync(from.store, to.store);
			const target = createRunner(to);
			const second = await linked(made, target, 2);
			const move = {
				id: "move-1",
				notice: "System notice: you now run in b.",
				roots: { from: from.workspace, to: to.workspace },
			};
			getOrThrow(await second.resume({ epoch: 2, seal, move }, context));
			getOrThrow(await second.idle(context));
			expect(made.effects()).toEqual(everyRound);
			expect(made.requests()).toBe(ROUNDS + 1);
			// Every request went through one host or the other, once.
			expect(first.models.paid + second.models.paid).toBe(ROUNDS + 1);

			first.setEpoch(2);
			getOrThrow(await first.retire(2, context));
			expect(await source.ended).toMatchObject({ how: "retired", exitCode: 0 });
			expect(existsSync(from.store)).toBe(false);
			second.close("done");
		});
	}, 30_000);

	it("refuses the model to a runner whose epoch the lease left behind, and that runner ends", async () => {
		await withWorld(async (made) => {
			const runner = createRunner(made.place("a"));
			const host = await linked(made, runner, 1);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			// The lease moved on: another home holds epoch 2.
			host.setEpoch(2);
			getOrThrow(await host.submit("go", undefined, context));
			expect(await runner.ended).toMatchObject({ how: "refused", exitCode: EXIT_REFUSED });
			expect(host.models.paid).toBe(0);
			expect(made.effects()).toEqual([]);
			expect(runner.home?.state).toBe("closed");
		});
	}, 30_000);

	it("gives a drain up when the link drops before the seal, and the session goes on when a host comes back", async () => {
		await withWorld(async (made) => {
			const runner = createRunner(made.place("a"));
			const host = await linked(made, runner, 1);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			await sleep(100);
			getOrThrow(await host.drain({ timeoutMs: 5_000 }, context));
			host.close("the host went away");
			// No host: held work goes on, and its model requests wait for one.
			await sleep(300);
			const again = await linked(made, runner, 1);
			getOrThrow(await again.idle(context));
			expect(made.effects()).toEqual(everyRound);
			expect(made.requests()).toBe(ROUNDS + 1);
			// The drain was given up, so there is nothing to seal.
			const sealed = await again.seal(context);
			expect(sealed.ok ? "" : sealed.error.code).toBe("wrong_state");
			again.close("done");
		});
	}, 30_000);

	it("stays sealed when the link drops after the seal, also in a runner started again, until a host says reopen", async () => {
		await withWorld(async (made) => {
			const options = made.place("a");
			const runner = createRunner(options);
			const host = await linked(made, runner, 1);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			await sleep(100);
			getOrThrow(await host.drain({ timeoutMs: 5_000 }, context));
			getOrThrow(await host.seal(context));
			host.close("the host went away");
			const ran = made.effects().length;
			expect(ran).toBeLessThan(ROUNDS);

			// The launcher starts the runner again. It opens nothing by itself.
			const restarted = createRunner(options);
			const back = await linked(made, restarted, 1);
			expect(getOrThrow(await back.status(context))).toEqual({ state: "sealed", epoch: 1 });
			const byItself = await back.resume({ epoch: 1 }, context);
			expect(byItself.ok ? "" : byItself.error.code).toBe("wrong_state");
			await sleep(200);
			expect(made.effects().length).toBe(ran);
			getOrThrow(await back.reopen(1, context));
			getOrThrow(await back.idle(context));
			expect(made.effects()).toEqual(everyRound);
			expect(made.requests()).toBe(ROUNDS + 1);
			back.close("done");
		});
	}, 30_000);

	it("names what held a drain that timed out, across the link", async () => {
		await withWorld(async (made) => {
			const runner = createRunner(made.place("a"));
			const host = await linked(made, runner, 1);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			await sleep(60);
			// Shorter than one tool call: the call that runs is not held in time.
			const drained = await host.drain({ timeoutMs: 1 }, context);
			expect(drained.ok ? "" : drained.error.code).toBe("timeout");
			expect(drained.ok ? [] : drained.error.holdouts.length).toBeGreaterThan(0);
			getOrThrow(await host.idle(context));
			expect(made.effects()).toEqual(everyRound);
			host.close("done");
		});
	}, 30_000);

	it("answers with link_lost an order that waits when the link drops, and every order after", async () => {
		await withWorld(async (made) => {
			const runner = createRunner(made.place("a"));
			const host = await linked(made, runner, 1);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			// The run takes a while: this order is still waiting for its answer when the link drops.
			const waiting = host.idle(context);
			await sleep(50);
			host.close("gone");
			const idle = await waiting;
			expect(idle.ok ? "" : idle.error.code).toBe("link_lost");
			const status = await host.status(context);
			expect(status.ok ? "" : status.error.code).toBe("link_lost");
			await runner.home?.close(context);
		});
	});
});
