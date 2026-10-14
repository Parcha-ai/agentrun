import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { type LeaseSeal, leaseIn, type Ownership, OwnershipError } from "../home/ownership.ts";
import { boxRunner, type RunnerProgram } from "../home/start.ts";
import { textResult } from "./tool-result.ts";

const context: Context = BACKGROUND_CONTEXT;
const SESSION = "move-conformance";
const NOTICE = "System notice: you now run in another box.";
const ROUNDS = 6;
const STEPS: readonly MoveStep[] = ["prepare", "drain", "seal", "ship", "take", "resume", "retire"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where in a target's resume the suite kills its runner. */
type KillPoint = "build" | "open" | "start" | "tool";

/** The file beside a store that names the one point where that home's runner kills itself, once. */
const killFile = (store: string) => `${store}.kill-at`;

/** As a crash at `point`, when the file beside the store names it. The file goes first: a restart runs on. */
function dieAt(store: string, point: KillPoint): void {
	let wanted: string;
	try {
		wanted = readFileSync(killFile(store), "utf8").trim();
	} catch {
		return;
	}
	if (wanted !== point) return;
	rmSync(killFile(store), { force: true });
	process.kill(process.pid, "SIGKILL");
}

/**
 * The app the move suite runs: one tool, `work`, that appends its round to `effects.log` in the conversation's
 * directory, which is the workspace. A runner file for the suite is `runMain(moveConformanceApp)`; its model is the
 * host's `faux/faux-1`. When the file `<store>.kill-at` names a point, the runner kills itself there, once: `build`
 * (the marker is written, the store not open), `open` (the conversations point here, the notice is not admitted),
 * `start` (a tool has started and made no effect yet) or `tool` (between a tool's effect and its result).
 */
export const moveConformanceApp: App = (ctx) => {
	dieAt(ctx.store, "build");
	const work = defineTool({
		name: "work",
		description: "Do one unit of work with an effect.",
		parameters: Type.Object({ n: Type.Number() }),
		async execute(args, api) {
			// Through the conversation's own directory: after a move it must be the new home's workspace.
			if (api.env === undefined) throw new Error("the tool has no environment");
			dieAt(ctx.store, "start");
			const appended = await api.env.appendFile("effects.log", `${args.n}\n`, BACKGROUND_CONTEXT);
			if (!appended.ok) throw appended.error;
			dieAt(ctx.store, "tool");
			return textResult(`did ${args.n}`);
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "work", tools: [work] }));
	return {
		registry,
		root: { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: ctx.workspace } },
		onOpen: () => dieAt(ctx.store, "open"),
	};
};

/** Two places of the provider under test, empty, and the runner program that runs `moveConformanceApp` there. */
export type MovePair = { readonly a: Place; readonly b: Place; readonly program: RunnerProgram };

/** Calls `use` once with a fresh pair, then ends the boxes. */
export type MovePairProvider = (use: (pair: MovePair) => Promise<void>) => Promise<void>;

type Said = { readonly role: string; readonly content?: unknown };

/** A message's text, whether its content is a string or a list of parts. */
const textOf = (message: Said) =>
	typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content.map((part) => (part as { text?: unknown }).text ?? "").join("")
			: "";

/**
 * The host's models: a stateless model that calls `work` once a round and then says it is done. From the third round
 * on it waits until a move has come to its drain, or 3 s, so that every move takes a session in the middle of its run.
 * It counts the move's notice in every transcript it is sent: the most it saw is what the session holds.
 */
function hostModels(drainCame: Promise<void>) {
	const faux = fauxProvider({ api: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	let notices = 0;
	// The tool results of the longest transcript sent: what each round's call came back with, for a failure's message.
	let results: readonly string[] = [];
	faux.setResponses(
		Array.from({ length: 200 }, () => async (transcript: { messages: readonly Said[] }) => {
			const seen = transcript.messages.filter((message) => message.role === "user" && textOf(message) === NOTICE);
			notices = Math.max(notices, seen.length);
			const said = transcript.messages
				.filter((message) => message.role === "toolResult")
				.map(
					(message) => `${(message as { isError?: boolean }).isError === true ? "error: " : ""}${textOf(message)}`,
				);
			if (said.length >= results.length) results = said;
			await sleep(60);
			const done = transcript.messages.filter((message) => message.role === "toolResult").length;
			if (done >= 2) await Promise.race([drainCame, sleep(3_000)]);
			if (done >= ROUNDS) return fauxAssistantMessage("done");
			return fauxAssistantMessage(fauxToolCall("work", { n: done }), { stopReason: "toolUse" });
		}),
	);
	return { models, notices: () => notices, results: () => results };
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
	/** The most notices of the move the model saw in one transcript. */
	notices(): number;
	/** The tool results the model was sent, round by round, in its longest transcript. */
	results(): readonly string[];
	/** Makes the runner at `place` kill itself at `point` of its next resume or run. */
	killAt(place: Place, point: KillPoint): Promise<void>;
	/** Whether the kill point set at `place` is still waiting: a runner that died there removed it. */
	killPending(place: Place): Promise<boolean>;
	/** Whether the store file is at `place`. */
	stored(place: Place): Promise<boolean>;
	/** The seal the home at `place` wrote beside its store when it sealed. */
	sealed(place: Place): Promise<LeaseSeal>;
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
	const { models, notices, results } = hostModels(came);
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
		notices,
		results,
		async killAt(place, point) {
			const argv = [
				"sh",
				"-c",
				'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"',
				"sh",
				killFile(place.store),
				point,
			];
			if ((await read(place, argv)) === undefined)
				throw new Error(`could not set the kill point in ${place.environment}`);
		},
		async stored(place) {
			return (await read(place, ["sh", "-c", 'test -e "$1"', "sh", place.store])) !== undefined;
		},
		async sealed(place) {
			const text = await read(place, ["sh", "-c", 'cat "$1"', "sh", `${place.store}.home.json`]);
			const seal = text === undefined ? undefined : (JSON.parse(text) as { sealed?: LeaseSeal }).sealed;
			if (seal === undefined) throw new Error(`the home in ${place.environment} has not sealed`);
			return seal;
		},
		async killPending(place) {
			return (await read(place, ["sh", "-c", 'test -e "$1"', "sh", killFile(place.store)])) !== undefined;
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
 * Whether a kill just before `step` came while the session ran: the host or the source before the drain held it, or the
 * host or the target once the target had resumed it (just before retire). From the seal on the source is sealed, so
 * its death cuts nothing. A kill while the session ran may cut the round that ran.
 */
function whileRunning(step: MoveStep, who: "host" | "source" | "target"): boolean {
	if (step === "retire") return who !== "source";
	return who !== "target" && STEPS.indexOf(step) <= STEPS.indexOf("drain");
}

/** The rounds whose call came back cut: pi does not run a call twice that was running when its process died. */
const cutRounds = (results: readonly string[]) =>
	results.flatMap((result, n) => (/ was (interrupted|aborted)/.test(result) ? [String(n)] : []));

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
 * The handoff on a pair of places of one provider: a move with nothing cut, a move given up, a take another host
 * won (to another place: the shipped copy goes; to the same place: it stays and the session finishes there), a kill of the host, the
 * source or the target just before each of the seven steps, and a kill of the target inside its own resume (its
 * marker written and the store not open; the conversations pointed at it and the notice not admitted; between a
 * tool's effect and its result), each followed by a host that recovers the session from the lease. Every case ends
 * with the session finished, no round's effect twice, every round's effect once whenever the kill came while the
 * session was held still (after the drain, before the target ran it), a round with no effect only when the model was
 * told its call was cut, and the move's notice in the transcript once when the session moved and never when it stayed.
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
	/**
	 * The rounds' effects in `holder`: none twice, and a round with no effect only when its call came back cut, which is
	 * at most once, as pi promises for a call that was running when its process died. `strict`: every round once, for a
	 * kill while the session was held still. A failure names what the model was told and what the other place holds.
	 */
	const checkRounds = async (run: Run, holder: Place, other: Place, strict: boolean): Promise<readonly string[]> => {
		const effects = await run.effects(holder);
		const evidence = `the tool results the model saw: ${JSON.stringify(run.results())}; effects in ${other.environment}: ${JSON.stringify(await run.effects(other))}`;
		equal(new Set(effects).size, effects.length, `no round twice (${effects.join(",")}; ${evidence})`);
		const missing = every.filter((n) => !effects.includes(n));
		if (strict) equal(missing, [], `every round once (${evidence})`);
		const cut = cutRounds(run.results());
		equal(
			missing.filter((n) => !cut.includes(n)),
			[],
			`a round with no effect and no word that its call was cut (${evidence})`,
		);
		return missing;
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
						equal(run.notices(), 1, "the notices the model saw");
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
						equal(run.notices(), 0, "the notices the model saw");
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
						equal(run.notices(), 0, "the notices the model saw");
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
						equal(run.notices(), 1, "the notices the model saw");
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
								const other = holder === pair.a ? pair.b : pair.a;
								await checkRounds(run, holder, other, !whileRunning(step, who));
								equal(run.notices(), lease?.epoch === 2 ? 1 : 0, "the notices the model saw");
							}),
						),
					timeoutMs,
				);
			}
		}

		runner.it(
			"gives a move up when another host took the session first, deletes the copy it shipped, and the source waits",
			() =>
				withPair((pair) =>
					withRun(pair, async (run) => {
						await sleep(150);
						const elsewhere = {
							environment: "elsewhere",
							provider: pair.b.provider,
							box: "box-x",
							host: "host-2",
						};
						const moved = await moveHome(
							{
								session: SESSION,
								host: "host-1",
								ownership: run.lease,
								from: { place: pair.a, home: run.home, epoch: 1 },
								to: pair.b,
								start: run.start,
								notice: NOTICE,
								onStep: async (step) => {
									if (step === "drain") run.drainCame();
									if (step !== "take") return;
									getOrThrow(await run.lease.take(SESSION, elsewhere, 1, { move: "move-of-host-2" }, context));
								},
							},
							context,
						);
						equal(moved.ok ? "moved" : moved.error.code, "lost", "the move's outcome");
						equal(await run.stored(pair.b), false, "the copy in the target");
						// The session is the other host's: the source stays sealed and runs nothing until a host says so.
						equal(getOrThrow(await run.home.status(context)).state, "sealed", "the source");
						const effects = await run.effects(pair.a);
						equal(new Set(effects).size, effects.length, `no round twice (${effects.join(",")})`);
						equal(run.notices(), 0, "the notices the model saw");
					}),
				),
			timeoutMs,
		);

		runner.it(
			"keeps the copy when the host that took first named the same place, and the session finishes there",
			() =>
				withPair((pair) =>
					withRun(pair, async (run) => {
						await sleep(150);
						const moved = await moveHome(
							{
								session: SESSION,
								host: "host-1",
								ownership: run.lease,
								from: { place: pair.a, home: run.home, epoch: 1 },
								to: pair.b,
								start: run.start,
								notice: NOTICE,
								onStep: async (step) => {
									if (step === "drain") run.drainCame();
									if (step !== "take") return;
									const holder = {
										environment: pair.b.environment,
										provider: pair.b.provider,
										box: pair.b.box.id,
										host: "host-2",
									};
									const seal = await run.sealed(pair.a);
									getOrThrow(
										await run.lease.take(SESSION, holder, 1, { move: "move-of-host-2", seal }, context),
									);
								},
							},
							context,
						);
						equal(moved.ok ? "moved" : moved.error.code, "lost", "the move's outcome");
						equal(await run.stored(pair.b), true, "the copy in the target");
						const places = { [pair.a.environment]: pair.a, [pair.b.environment]: pair.b };
						const recovered = getOrThrow(
							await recoverHome(
								{ session: SESSION, ownership: run.lease, places, start: run.start, notice: NOTICE },
								context,
							),
						);
						getOrThrow(await recovered.home.idle(context));
						equal(await run.effects(pair.b), every, "every round once");
						equal(run.notices(), 1, "the notices the model saw");
					}),
				),
			timeoutMs,
		);

		// Inside the target's own steps: after the take, so the session is the target's whatever the move answered.
		const inside: readonly (readonly [KillPoint, string])[] = [
			["build", "after it wrote its marker and before it opened the store"],
			["open", "after it pointed the conversations at its workspace and before the notice"],
			["start", "once it runs, between a tool's start and its effect"],
			["tool", "once it runs, between a tool's effect and its result"],
		];
		for (const [point, when] of inside) {
			runner.it(
				`finishes the session when the target is killed ${when}`,
				() =>
					withPair((pair) =>
						withRun(pair, async (run) => {
							await sleep(150);
							await run.killAt(pair.b, point);
							const moved = await moveHome(
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
							);
							if (point === "build" || point === "open") {
								equal(moved.ok ? "moved" : moved.error.code, "resume", "the move's outcome");
							}
							equal(await run.held(), { epoch: 2, environment: pair.b.environment }, "the lease");
							let home = moved.ok ? moved.value.home : undefined;
							let restarted = false;
							if (home === undefined || !(await home.idle(context)).ok) {
								// The runner died: a host starts it again from the lease, once.
								restarted = true;
								await sleep(300);
								const places = { [pair.a.environment]: pair.a, [pair.b.environment]: pair.b };
								const recovered = await recoverHome(
									{ session: SESSION, ownership: run.lease, places, start: run.start, notice: NOTICE },
									context,
								);
								home = getOrThrow(recovered).home;
								getOrThrow(await home.idle(context));
							}
							equal(
								[await run.killPending(pair.b), restarted],
								[false, true],
								"the target died at the kill point",
							);
							// Before the target runs, nothing is in flight; a tool that started and made no effect is cut, and said so.
							const missing = await checkRounds(run, pair.b, pair.a, point !== "start");
							if (point === "start") equal(missing, cutRounds(run.results()), "the one round the kill cut");
							if (point === "start") equal(missing.length, 1, "rounds cut");
							equal(run.notices(), 1, "the notices the model saw");
						}),
					),
				timeoutMs,
			);
		}
	});
}
