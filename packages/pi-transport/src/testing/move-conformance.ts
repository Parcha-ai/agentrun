import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { err, getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import type { StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import { Type } from "typebox";
import { finish } from "../box/files.ts";
import type { App } from "../home/app.ts";
import { dirStore } from "../home/dir-store.ts";
import type { HomeHandle } from "../home/host.ts";
import { type MoveStep, moveHome, type Place, recoverHome, type StartRunner } from "../home/move.ts";
import { leaseIn, type Ownership, OwnershipError } from "../home/ownership.ts";
import { boxRunner, type RunnerProgram } from "../home/start.ts";

const context: Context = BACKGROUND_CONTEXT;
const SESSION = "move-conformance";
const NOTICE = "System notice: you now run in another box.";
const ROUNDS = 6;
const STEPS: readonly MoveStep[] = ["prepare", "drain", "seal", "ship", "take", "resume", "retire"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The app the move suite runs: one tool, `work`, that appends its round to `effects.log` in the conversation's
 * directory, which is the workspace. A runner
 * file for the suite is `runMain(moveConformanceApp)`; its model is the host's `faux/faux-1`.
 */
export const moveConformanceApp: App = (ctx) => {
	const work = defineTool({
		name: "work",
		description: "Do one unit of work with an effect.",
		parameters: Type.Object({ n: Type.Number() }),
		async execute(args, api) {
			// Through the conversation's own directory: after a move it must be the new home's workspace.
			if (api.env === undefined) throw new Error("the tool has no environment");
			const appended = await api.env.appendFile("effects.log", `${args.n}\n`, BACKGROUND_CONTEXT);
			if (!appended.ok) throw appended.error;
			return { content: [{ type: "text", text: `did ${args.n}` }] };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "work", tools: [work] }));
	return { registry, root: { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: ctx.workspace } } };
};

/** Two places of the provider under test, empty, and the runner program that runs `moveConformanceApp` there. */
export type MovePair = { readonly a: Place; readonly b: Place; readonly program: RunnerProgram };

/** Calls `use` once with a fresh pair, then ends the boxes. */
export type MovePairProvider = (use: (pair: MovePair) => Promise<void>) => Promise<void>;

/**
 * The host's models: a stateless model that calls `work` once a round and then says it is done. From the third round
 * on it waits until a move has come to its drain, or 3 s, so that every move takes a session in the middle of its run.
 */
function hostModels(drainCame: Promise<void>) {
	const faux = fauxProvider({ api: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 200 }, () => async (transcript: { messages: readonly { role: string }[] }) => {
			await sleep(60);
			const done = transcript.messages.filter((message) => message.role === "toolResult").length;
			if (done >= 2) await Promise.race([drainCame, sleep(3_000)]);
			if (done >= ROUNDS) return fauxAssistantMessage("done");
			return fauxAssistantMessage(fauxToolCall("work", { n: done }), { stopReason: "toolUse" });
		}),
	);
	return models;
}

/** A program's output in a box, or `undefined` when it failed. */
async function read(place: Place, argv: readonly string[]): Promise<string | undefined> {
	const started = await place.box.exec(argv, { timeoutMs: 60_000 }, context);
	if (!started.ok) return undefined;
	const done = await finish(started.value);
	return done.ok && done.value.exitCode === 0 ? new TextDecoder().decode(done.value.stdout) : undefined;
}

type Run = {
	/** The host's lease, in a directory of this machine that only this run uses. */
	readonly lease: Ownership;
	/** The lease's epoch and the environment of its holder, as `current` reads them. */
	held(): Promise<{ epoch: number; environment: string } | undefined>;
	readonly start: StartRunner;
	readonly home: HomeHandle;
	effects(place: Place): Promise<string[]>;
	/** The move came to its drain: the rest of the run may go on. */
	drainCame(): void;
	kill(place: Place): Promise<void>;
	/** As the host's death: every hold on a home goes. */
	dropAll(): void;
	/** Lets go of every home and removes the lease's directory. */
	end(): void;
};

/** A session that started at `a` on epoch 1 and is busy with its run. */
async function begin(pair: MovePair): Promise<Run> {
	const leases = mkdtempSync(join(tmpdir(), "pi-transport-lease-"));
	const lease = leaseIn(dirStore(leases));
	let drainCame: () => void = () => {};
	const came = new Promise<void>((resolve) => {
		drainCame = resolve;
	});
	const models = hostModels(came);
	const handles: HomeHandle[] = [];
	const base = boxRunner({ program: pair.program, session: SESSION, models });
	const start: StartRunner = async (place, epoch, startContext) => {
		const started = await base(place, epoch, startContext);
		if (started.ok) handles.push(started.value);
		return started;
	};
	const holder = { environment: pair.a.environment, provider: pair.a.provider, box: pair.a.box.id, host: "host-1" };
	getOrThrow(await lease.take(SESSION, holder, 0, undefined, context));
	const home = getOrThrow(await start(pair.a, 1, context));
	getOrThrow(await home.ready);
	getOrThrow(await home.resume({ epoch: 1 }, context));
	getOrThrow(await home.submit("go", undefined, context));
	return {
		lease,
		async held() {
			const record = getOrThrow(await lease.current(SESSION, context));
			return record === undefined ? undefined : { epoch: record.epoch, environment: record.holder.environment };
		},
		start,
		home,
		drainCame,
		async effects(place) {
			const text = await read(place, [
				"sh",
				"-c",
				'cat "$1" 2>/dev/null || true',
				"sh",
				`${place.workspace}/effects.log`,
			]);
			return (text ?? "").split("\n").filter(Boolean);
		},
		async kill(place) {
			// As a crash: the runner's own process id, killed with no warning.
			await read(place, ["sh", "-c", 'kill -9 "$(cat "$1")"', "sh", `${place.store}.pid`]);
			await sleep(300);
		},
		dropAll() {
			for (const handle of handles) handle.close("the host died");
		},
		end() {
			for (const handle of handles) handle.close("the run ended");
			rmSync(leases, { recursive: true, force: true });
		},
	};
}

/** Runs `use` with a session begun at `a`, and ends the run whatever happens. */
async function withRun(pair: MovePair, use: (run: Run) => Promise<void>): Promise<void> {
	const run = await begin(pair);
	try {
		await use(run);
	} finally {
		run.end();
	}
}

/**
 * Where the lease is after a kill just before `step`. The take is the point of no return. A source killed once it
 * sealed is not needed any more: its store is whole in its box, and the move goes on. A target killed before the
 * take is found out at the take, and the move is given up.
 */
function epochAfter(step: MoveStep, who: "host" | "source" | "target"): number {
	const at = STEPS.indexOf(step);
	if (who === "source" && at > STEPS.indexOf("seal")) return 2;
	return at > STEPS.indexOf("take") ? 2 : 1;
}

/**
 * The handoff on a pair of places of one provider: a move with nothing cut, a move given up, and a kill of the
 * host, the source or the target just before each of the seven steps, each followed by a host that recovers the
 * session from the lease. Every case ends with the session finished, no round's effect twice, and every round's
 * effect once whenever the kill came after the session was held still.
 */
export function registerMoveConformance(
	runner: StorageConformanceRunner,
	name: string,
	withPair: MovePairProvider,
	options?: { readonly timeoutMs?: number },
): void {
	const timeoutMs = options?.timeoutMs ?? 120_000;
	const every = Array.from({ length: ROUNDS }, (_, n) => String(n));
	const equal = (actual: unknown, expected: unknown, message: string) => {
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			throw new Error(`${message}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
		}
	};
	runner.describe(name, () => {
		runner.it(
			"moves a running session with nothing cut, one notice, and the first home retired",
			() =>
				withPair((pair) =>
					withRun(pair, async (run) => {
						await sleep(150);
						const moved = getOrThrow(
							await moveHome(
								{
									session: SESSION,
									host: "host-1",
									ownership: run.lease,
									from: { place: pair.a, home: run.home, epoch: 1 },
									to: pair.b,
									start: run.start,
									notice: NOTICE,
									onStep: (step) => {
										if (step === "drain") run.drainCame();
									},
								},
								context,
							),
						);
						equal([moved.epoch, moved.retired], [2, true], "the receipt");
						getOrThrow(await moved.home.idle(context));
						equal(await run.effects(pair.b), every, "the rounds in the new home");
						equal(await run.held(), { epoch: 2, environment: pair.b.environment }, "the lease");
					}),
				),
			timeoutMs,
		);

		runner.it(
			"gives a move up when the session does not come to rest, names what held it, and cuts nothing",
			() =>
				withPair((pair) =>
					withRun(pair, async (run) => {
						const moved = await moveHome(
							{
								session: SESSION,
								host: "host-1",
								ownership: run.lease,
								from: { place: pair.a, home: run.home, epoch: 1 },
								to: pair.b,
								start: run.start,
								notice: "unused",
								drain: { timeoutMs: 1 },
								// A new input keeps the session busy when the drain starts, however long the target took.
								onStep: async (step) => {
									if (step !== "drain") return;
									run.drainCame();
									getOrThrow(await run.home.submit("go on", undefined, context));
								},
							},
							context,
						);
						equal(moved.ok ? "moved" : moved.error.code, "drain", "the move's outcome");
						getOrThrow(await run.home.idle(context));
						equal(await run.effects(pair.a), every, "the rounds in the home that stayed");
						equal(await run.held(), { epoch: 1, environment: pair.a.environment }, "the lease");
					}),
				),
			timeoutMs,
		);

		runner.it(
			"gives a move up when the store cannot be shipped, and the source runs on",
			() =>
				withPair((pair) =>
					withRun(pair, async (run) => {
						await sleep(150);
						// A store path under a file: no box can make that directory.
						const nowhere = { ...pair.b, store: "/dev/null/session/run.sqlite" };
						const moved = await moveHome(
							{
								session: SESSION,
								host: "host-1",
								ownership: run.lease,
								from: { place: pair.a, home: run.home, epoch: 1 },
								to: nowhere,
								start: async (place, epoch, startContext) =>
									run.start({ ...place, store: pair.b.store }, epoch, startContext),
								notice: "unused",
								onStep: (step) => {
									if (step === "drain") run.drainCame();
								},
							},
							context,
						);
						equal(moved.ok ? "moved" : moved.error.code, "ship", "the move's outcome");
						getOrThrow(await run.home.idle(context));
						equal(await run.effects(pair.a), every, "the rounds in the home that stayed");
						equal(await run.held(), { epoch: 1, environment: pair.a.environment }, "the lease");
					}),
				),
			timeoutMs,
		);

		runner.it(
			"completes a move whose take was written and whose answer was lost",
			() =>
				withPair((pair) =>
					withRun(pair, async (run) => {
						await sleep(150);
						// The write lands and the host hears an error, as from a storage call that timed out after it committed.
						const lossy: Ownership = {
							current: (session, currentContext) => run.lease.current(session, currentContext),
							async take(session, holder, expected, details, takeContext) {
								const taken = await run.lease.take(session, holder, expected, details, takeContext);
								return taken.ok
									? err(new OwnershipError("unavailable", "the answer of the write was lost"))
									: taken;
							},
						};
						const moved = getOrThrow(
							await moveHome(
								{
									session: SESSION,
									host: "host-1",
									ownership: lossy,
									from: { place: pair.a, home: run.home, epoch: 1 },
									to: pair.b,
									start: run.start,
									notice: NOTICE,
									onStep: (step) => {
										if (step === "drain") run.drainCame();
									},
								},
								context,
							),
						);
						equal([moved.epoch, moved.retired], [2, true], "the receipt");
						getOrThrow(await moved.home.idle(context));
						equal(await run.effects(pair.b), every, "the rounds in the new home");
						equal(await run.held(), { epoch: 2, environment: pair.b.environment }, "the lease");
					}),
				),
			timeoutMs,
		);

		for (const step of STEPS) {
			for (const who of ["host", "source", "target"] as const) {
				if (who === "target" && step === "prepare") continue;
				runner.it(
					`finishes the session when the ${who} is killed just before ${step}`,
					() =>
						withPair((pair) =>
							withRun(pair, async (run) => {
								await sleep(150);
								const hostDied = new Error("the host died");
								const moved = await moveHome(
									{
										session: SESSION,
										host: "host-1",
										ownership: run.lease,
										from: { place: pair.a, home: run.home, epoch: 1 },
										to: pair.b,
										start: run.start,
										notice: NOTICE,
										onStep: async (at) => {
											if (at === "drain") run.drainCame();
											if (at !== step) return;
											if (who === "host") {
												run.dropAll();
												throw hostDied;
											}
											await run.kill(who === "source" ? pair.a : pair.b);
										},
									},
									context,
								).catch((error: unknown): Result<never, Error> | undefined => {
									if (error !== hostDied) throw error;
									return undefined;
								});
								const lease = await run.held();
								equal(lease?.epoch, epochAfter(step, who), "the lease after the kill");
								const holder = lease?.environment === pair.b.environment ? pair.b : pair.a;
								let home = moved?.ok === true ? moved.value.home : undefined;
								if (home === undefined || !(await home.status(context)).ok) {
									await sleep(300);
									const places = { [pair.a.environment]: pair.a, [pair.b.environment]: pair.b };
									const recovered = await recoverHome(
										{ session: SESSION, ownership: run.lease, places, start: run.start, notice: NOTICE },
										context,
									);
									home = getOrThrow(recovered).home;
								}
								getOrThrow(await home.idle(context));
								const effects = await run.effects(holder);
								equal(new Set(effects).size, effects.length, `no round twice (${effects.join(",")})`);
								// A kill while the session ran, before the drain held it, may cut the round that was running.
								if (STEPS.indexOf(step) > STEPS.indexOf("drain") || who === "target") {
									equal(effects, every, "every round once");
								}
							}),
						),
					timeoutMs,
				);
			}
		}
	});
}
