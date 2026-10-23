import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { App } from "../src/home/app.ts";
import type { Crossing } from "../src/home/crossing.ts";
import { connectHome, type HomeHandle } from "../src/home/host.ts";
import { type Frame, linkPair } from "../src/home/link.ts";
import { serveModels } from "../src/home/models.ts";
import { createRunner, EXIT_REFUSED, type Runner, type RunnerOptions } from "../src/home/runner.ts";
import { textResult } from "../src/testing/tool-result.ts";

const context = BACKGROUND_CONTEXT;
const ROUNDS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One session's world: the host's models, the tool's effects, and the places it can run. */
function world(options?: { readonly tokensPerSecond?: number }) {
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-link-"));
	const effects = join(directory, "effects.log");
	const faux = fauxProvider({
		api: "faux",
		...(options?.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
	});
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
			return textResult(`did ${args.n}`);
		},
	});
	const app: App = (ctx) => {
		const registry = createRegistry();
		registry.install(defineExtension({ name: "work", tools: [work] }));
		return { registry, root: { agent: { model, cwd: ctx.workspace } } };
	};
	return {
		directory,
		faux,
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

async function withWorld(
	use: (made: World) => Promise<void>,
	options?: { readonly tokensPerSecond?: number },
): Promise<void> {
	const made = world(options);
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

	it("sends no order for a context that ended already, and a live one's order still goes", async () => {
		const orders: string[] = [];
		const host = connectHome(
			fakeRunner(readyFrame, (order) => {
				orders.push(order);
				return null;
			}),
			{ models, epoch: 1 },
		);
		getOrThrow(await host.ready);
		const ended = withCancel(context);
		ended.cancel();
		const submitted = await host.submit("go", undefined, ended.context);
		expect(submitted.ok ? "sent" : submitted.error.code).toBe("aborted");
		const drained = await host.drain(undefined, ended.context);
		expect(drained.ok ? "sent" : drained.error.code).toBe("aborted");
		await sleep(20);
		expect(orders).toEqual([]);
		getOrThrow(await host.idle(context));
		expect(orders).toEqual(["idle"]);
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
			const seal = getOrThrow(await host.seal(context));
			host.close("the host went away");
			const ran = made.effects().length;
			expect(ran).toBeLessThan(ROUNDS);

			// The launcher starts the runner again. It opens nothing by itself.
			const restarted = createRunner(options);
			const back = await linked(made, restarted, 1);
			// It says the seal it holds, what a recovery's take carries forward, and whose note it keeps.
			expect(getOrThrow(await back.status(context))).toEqual({
				state: "sealed",
				epoch: 1,
				sealed: seal,
				session: "session-1",
			});
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

	it("keeps an answer the host paid for across a new link when the host passes its server on, and pays once", async () => {
		await withWorld(
			async (made) => {
				// One answer of about 400 tokens at 200 a second: about 2 s on the link.
				const answer = "A long answer, streamed slowly. ".repeat(50);
				let calls = 0;
				made.faux.setResponses([
					() => {
						calls += 1;
						return fauxAssistantMessage(answer);
					},
					() => {
						calls += 1;
						return fauxAssistantMessage("asked again");
					},
				]);
				const runner = createRunner(made.place("a"));
				const server = serveModels(made.models);
				const hold = async () => {
					const [runnerEnd, hostEnd] = linkPair();
					runner.attach(runnerEnd);
					const handle = connectHome(hostEnd, { models: made.models, epoch: 1, server });
					getOrThrow(await handle.ready);
					return handle;
				};
				const first = await hold();
				getOrThrow(await first.resume({ epoch: 1 }, context));
				getOrThrow(await first.submit("go", undefined, context));
				// In the middle of the answer, the host's link to the runner goes.
				await sleep(700);
				first.close("the box's exec stream closed");
				await sleep(200);
				const second = await hold();
				getOrThrow(await second.idle(context));
				expect(calls).toBe(1);
				expect(server.paid).toBe(1);
				const home = runner.home;
				if (home === undefined) throw new Error("the runner has no home");
				const root = getOrThrow(await home.root(context));
				const said = (await root.entries({}, 100, undefined, context)).items
					.map((entry) => entry.model?.[0])
					.filter((message): message is AssistantMessage => message?.role === "assistant");
				// No error on the way: the answer was only delayed.
				expect(said.map((message) => message.stopReason)).toEqual(["stop"]);
				expect(said[0]?.content).toEqual([{ type: "text", text: answer }]);
				second.close("done");
			},
			{ tokensPerSecond: 200 },
		);
	}, 30_000);

	it("says ready only with a home, and tries to open it again for the next host when it could not", async () => {
		await withWorld(async (made) => {
			const options = made.place("a");
			const marker = `${options.store}.home.json`;
			mkdirSync(dirname(marker), { recursive: true });
			writeFileSync(marker, "not a marker");
			const runner = createRunner(options);
			for (const which of ["first", "second"]) {
				const [runnerEnd, hostEnd] = linkPair();
				runner.attach(runnerEnd);
				const host = connectHome(hostEnd, { models: made.models, epoch: 1 });
				const ready = await host.ready;
				expect(ready.ok ? "ready" : ready.error.code, which).toBe("store");
				host.close("the next host");
			}
			rmSync(marker);
			const host = await linked(made, runner, 1);
			expect(getOrThrow(await host.status(context))).toEqual({ state: "closed", epoch: null });
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			getOrThrow(await host.idle(context));
			expect(made.effects()).toEqual(everyRound);
			host.close("done");
		});
	}, 30_000);

	it("stops the runner's drain when the host gives up on it, so the gate opens again and the session goes on", async () => {
		await withWorld(async (made) => {
			const runner = createRunner(made.place("a"));
			const host = await linked(made, runner, 1);
			getOrThrow(await host.resume({ epoch: 1 }, context));
			getOrThrow(await host.submit("go", undefined, context));
			await sleep(60);
			const giving = withCancel(context);
			const drained = host.drain({ timeoutMs: 5_000 }, giving.context);
			giving.cancel();
			const given = await drained;
			expect(given.ok ? "drained" : given.error.code).toBe("aborted");
			await sleep(300);
			// Nothing is held: there is nothing to seal, and the work goes on to its end.
			const sealed = await host.seal(context);
			expect(sealed.ok ? "sealed" : sealed.error.code).toBe("wrong_state");
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

describe("transport.tool.started: the runner holds a tool until the host's crossing returns", () => {
	/** A host with `crossing`, over a runner that holds tools for at most `crossingMs`. */
	async function crossed(made: World, crossing: Crossing | undefined, crossingMs?: number) {
		const [runnerEnd, hostEnd] = linkPair();
		const runner = createRunner({ ...made.place("a"), ...(crossingMs === undefined ? {} : { crossingMs }) });
		runner.attach(runnerEnd);
		const seen: Frame[] = [];
		hostEnd.onFrame((frame) => seen.push(frame));
		const handle = connectHome(hostEnd, {
			models: made.models,
			epoch: 1,
			...(crossing === undefined ? {} : { crossing, crossingFor: { session: "session-1", box: "box-a" } }),
		});
		getOrThrow(await handle.ready);
		return { handle, runner, seen };
	}

	it("announces each tool start once with its name, the session, the epoch and the box, counting from 1, and the session goes on", async () => {
		await withWorld(async (made) => {
			const told: { tool?: string; n: number; epoch: number; box: string; session: string; effectsThen: number }[] =
				[];
			const { handle } = await crossed(made, async (point, info) => {
				expect(point).toBe("transport.tool.started");
				told.push({ ...info, effectsThen: made.effects().length } as never);
			});
			getOrThrow(await handle.resume({ epoch: 1 }, context));
			getOrThrow(await handle.submit("go", undefined, context));
			getOrThrow(await handle.idle(context));
			expect(told.map((one) => one.n)).toEqual(everyRound.map((_, at) => at + 1));
			expect(
				told.every(
					(one) => one.tool === "work" && one.epoch === 1 && one.box === "box-a" && one.session === "session-1",
				),
			).toBe(true);
			// The tool had not run when it was announced: round n starts with n effects done.
			expect(told.map((one) => one.effectsThen)).toEqual(everyRound.map((_, at) => at));
			expect(made.effects()).toEqual(everyRound);
			handle.close("done");
		});
	}, 30_000);

	it("holds the tool while the handler runs, so a handler that never lets it run leaves its effect absent, until crossingMs", async () => {
		await withWorld(async (made) => {
			const { handle } = await crossed(made, () => new Promise<void>(() => {}), 400);
			getOrThrow(await handle.resume({ epoch: 1 }, context));
			getOrThrow(await handle.submit("go", undefined, context));
			await sleep(250);
			// Held: nothing has run yet.
			expect(made.effects()).toEqual([]);
			// Past crossingMs the tool runs: a handler that hangs cannot hang the session.
			await sleep(1_200);
			expect(made.effects().length).toBeGreaterThan(0);
			handle.close("done");
		});
	}, 30_000);

	it("lets the tool run at once when the handler calls release, and the handler goes on after it", async () => {
		await withWorld(async (made) => {
			let afterRelease: number | undefined;
			const { handle } = await crossed(
				made,
				async (_point, info) => {
					if (info.n !== 1) return;
					info.release?.();
					await sleep(150);
					afterRelease = made.effects().length;
					await new Promise<void>(() => {});
				},
				10_000,
			);
			getOrThrow(await handle.resume({ epoch: 1 }, context));
			getOrThrow(await handle.submit("go", undefined, context));
			await sleep(400);
			expect(afterRelease).toBeGreaterThan(0);
			handle.close("done");
		});
	}, 30_000);

	it("treats a handler that throws as returned: the tool runs", async () => {
		await withWorld(async (made) => {
			const { handle } = await crossed(made, () => {
				throw new Error("the handler failed");
			});
			getOrThrow(await handle.resume({ epoch: 1 }, context));
			getOrThrow(await handle.submit("go", undefined, context));
			getOrThrow(await handle.idle(context));
			expect(made.effects()).toEqual(everyRound);
			handle.close("done");
		});
	}, 30_000);

	it("sends no hold and no acknowledgement when the host names no crossing", async () => {
		await withWorld(async (made) => {
			const { handle, seen } = await crossed(made, undefined);
			getOrThrow(await handle.resume({ epoch: 1 }, context));
			getOrThrow(await handle.submit("go", undefined, context));
			getOrThrow(await handle.idle(context));
			expect(seen.some((frame) => frame.t === "call-ack")).toBe(false);
			expect(made.effects()).toEqual(everyRound);
			handle.close("done");
		});
	}, 30_000);
});
