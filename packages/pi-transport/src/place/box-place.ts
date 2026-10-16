import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box, BoxProcess, BoxProvider, BoxSpec } from "../box/box.ts";
import { finish } from "../box/files.ts";
import { type CheckpointStats, type CheckpointVault, checkpointStats, pullCheckpoint } from "../home/checkpoint.ts";
import { type Crossing, type CrossingCounter, crossingCounter } from "../home/crossing.ts";
import type { DrainOptions } from "../home/gate.ts";
import type { HomeHandle } from "../home/host.ts";
import { type Place as HomePlace, MoveError, recoverHome, type StartRunner } from "../home/move.ts";
import type { Holder, Ownership } from "../home/ownership.ts";
import type { RecordSink } from "../home/records.ts";
import { boxRunner, type RunnerProgram } from "../home/start.ts";
import { killRunner } from "../home/stop.ts";
import type { WorkspaceOptions } from "../home/workspace.ts";

/** The session's paths in the place, all in the box: its id (the session), its directory, its files and its store. */
export type RunPlace = { id: string; root: string; work: string; store: string };

/** What a runner reported on its way out: one JSON line `{"outcome":{...}}` it printed. */
export type Outcome = {
	status: string;
	generation: number | null;
	code?: string | null;
	message?: string;
	record?: unknown;
	result?: { json: unknown; title: string };
	storeSha256?: string;
};

/** How a runner ended: the exit as the box saw it, the outcome the runner reported, and the start of its error output. */
export type Exit = { exit: number | string | null; signal: string | null; outcome?: Outcome; stderr: string };

/** One runner of the session in the place. `epoch` is the lease's: a restart keeps it, a restore of a lost box raises it. */
export type Runner = { epoch: number; pid?: number; exited: Promise<Exit> };

/** What a runner is handed: its number in the run and its environment, which travels over the link and never in argv. */
export type RunnerOrder = { gen: number; env: Record<string, string>; stdin?: string };

/**
 * What the place announces to whoever drives it: a crossing the transport took (`transport.checkpoint.taken`,
 * `transport.tool.started`), or a runner's request to be killed, read from its `requestFile`, with the nonce it wrote.
 */
export type PlaceSignal = {
	kind: "crossing" | "kill-request";
	crossing: { point: string; n: number; pid?: number; info?: Record<string, unknown> };
	nonce?: string;
};

export type KillKind = "process" | "box";

/**
 * A host path an order's environment names, which the runner in the box reads or writes. The place gives the runner a
 * path in the box instead, and carries the files across. `file`: written by the runner, copied back whole when it
 * exits. `dir`: `in` files go into the box before each runner starts; the files under `once` directories come back once
 * each (by name, written whole under a temporary name, then renamed), then the files under `append` directories come
 * back as they grow (new bytes only), while the runner runs and when it exits. Paths are relative to the directory.
 */
export type CarriedPath =
	| { readonly env: string; readonly kind: "file" }
	| {
			readonly env: string;
			readonly kind: "dir";
			readonly in?: readonly string[];
			readonly once?: readonly string[];
			readonly append?: readonly string[];
	  };

export type BoxPlaceOptions = {
	/** The session: the run's id. */
	readonly session: string;
	readonly provider: BoxProvider;
	/** The box the place makes, and the one it makes again when a box is lost. */
	readonly spec: BoxSpec;
	/** Which environment of the config this place is. */
	readonly environment: string;
	/** The session's lease. */
	readonly ownership: Ownership;
	/** The runner the box runs: a file uploaded by its SHA-256, or a program the image holds. */
	readonly program: RunnerProgram;
	/** The host's models: the runner asks for them over the link, and no key goes into the box. */
	readonly models: Models;
	/** Where the session's record stream goes, for every runner of the session. */
	readonly records?: RecordSink;
	/** Where checkpoints are kept: a box that is lost is restored from the newest. */
	readonly vault: CheckpointVault;
	/** Who this host is, in the lease. Default `host`. */
	readonly host?: string;
	/** What a session restarted after a kill is told. */
	readonly notice?: string;
	readonly carry?: readonly CarriedPath[];
	readonly checkpoint?: {
		readonly drain?: DrainOptions;
		readonly holdMs?: number;
		readonly workspace?: WorkspaceOptions & { readonly maxBytes?: number };
		readonly maxPullBytes?: number;
		/** How many times a checkpoint skipped because the session is busy is tried. Default 5. */
		readonly tries?: number;
		/** The wait between those tries. Default 500 ms. */
		readonly waitMs?: number;
	};
	/** How often a running runner's carried files come back. Default 2 s; 0: only when it exits. */
	readonly followMs?: number;
	/** How often a runner's kill request is looked for in the box. Default 100 ms. */
	readonly pollMs?: number;
};

/** A session's place in a box, made by `boxPlace`. */
export type BoxPlace = {
	readonly name: string;
	readonly paths: RunPlace;
	readonly kills: ReadonlyArray<KillKind>;
	start(order: RunnerOrder): Promise<Runner>;
	requestFile(attempt: number): string;
	signals(attempt: number): AsyncIterable<PlaceSignal>;
	kill(runner: Runner, kind: KillKind): Promise<void>;
	status(): Promise<{ record: Record<string, unknown> }>;
	recover(
		last: Runner,
		kind: KillKind,
		order: RunnerOrder,
	): Promise<{
		runner: Runner;
		restored?: { checkpoint: string; head: number };
		replayed?: { from: number; to: number };
	}>;
	checkpoint(): Promise<{ taken: boolean; heldBy?: string }>;
	release(): Promise<void>;
	/** What the checkpoints of this place did. */
	readonly stats: CheckpointStats;
};

const DEFAULT_NOTICE =
	"This session was stopped and has started again in the same place; it goes on where its store left off.";

/** The paths of a session in a box: its files are the box's workspace, its directory the workspace's parent. */
function pathsIn(box: Box, session: string): RunPlace {
	const work = box.facts().workspace;
	const root = posix.dirname(work);
	return { id: session, root, work, store: posix.join(root, "session", "run.sqlite") };
}

/** A short program's standard output in the box, or `undefined` when it did not run or failed. */
async function output(box: Box, argv: readonly string[]): Promise<Uint8Array | undefined> {
	const started = await box.exec(argv, { timeoutMs: 30_000 }, BACKGROUND_CONTEXT);
	if (!started.ok) return undefined;
	const finished = await finish(started.value);
	if (!finished.ok || finished.value.exitCode !== 0) return undefined;
	return finished.value.stdout;
}

/** The files of a directory in the box, by name, with their sizes: none when it does not exist. */
async function sizesIn(box: Box, dir: string): Promise<Map<string, number>> {
	const listed = await output(box, [
		"sh",
		"-c",
		'cd "$1" 2>/dev/null || exit 0; for f in *; do [ -f "$f" ] && printf "%s\\t%s\\n" "$(wc -c < "$f" | tr -d " ")" "$f"; done; exit 0',
		"sh",
		dir,
	]);
	const sizes = new Map<string, number>();
	for (const line of new TextDecoder().decode(listed ?? new Uint8Array()).split("\n")) {
		const tab = line.indexOf("\t");
		if (tab > 0) sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)));
	}
	return sizes;
}

async function sizeHere(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).size;
	} catch {
		return undefined;
	}
}

/**
 * Make a session's place in a box: the box is made now, and the session's lease is taken when its first runner starts.
 * The place starts pi-transport's runner in the box (`boxRunner`), kills a runner by its process or by its box,
 * restarts it in the same box (`recoverHome`) or, for a lost box, in a new one from the newest checkpoint, and takes
 * checkpoints at rest (`pullCheckpoint`).
 */
export async function boxPlace(options: BoxPlaceOptions, context: Context): Promise<Result<BoxPlace, MoveError>> {
	const made = await options.provider.create(options.spec, context);
	if (!made.ok) return err(new MoveError("prepare", `could not make the place's box: ${made.error.message}`));
	const { session, environment } = options;
	const host = options.host ?? "host";
	const boxes: Box[] = [made.value];
	let box = made.value;
	let paths = pathsIn(box, session);
	const homePlace = (): HomePlace => ({
		environment,
		provider: options.provider.name,
		box,
		store: paths.store,
		workspace: paths.work,
	});
	const counter: CrossingCounter = crossingCounter();
	const stats = checkpointStats();
	const queues = new Map<number, PlaceSignal[]>();
	let attempt = 0;
	let epoch = 0;
	let handle: HomeHandle | undefined;
	let released = false;

	const crossing: Crossing = (point, info) => {
		const { release: _release, ...told } = info;
		const queue = queues.get(attempt) ?? [];
		queue.push({ kind: "crossing", crossing: { point, n: info.n, info: { ...told } } });
		queues.set(attempt, queue);
	};

	/** The order's environment with every carried host path made a path in the box. */
	const inBox = (order: RunnerOrder): { env: Record<string, string>; carried: Map<CarriedPath, string> } => {
		const env = { ...order.env };
		const carried = new Map<CarriedPath, string>();
		for (const path of options.carry ?? []) {
			const there = env[path.env];
			if (there === undefined) continue;
			carried.set(path, there);
			env[path.env] =
				path.kind === "file"
					? posix.join(paths.root, "carried", `${path.env.toLowerCase()}-${order.gen}${posix.extname(there)}`)
					: posix.join(paths.root, "carried", path.env.toLowerCase());
		}
		return { env, carried };
	};

	/** The `in` files of each carried directory, into the box at the paths the runner is given. */
	const carryIn = async (target: Box, env: Record<string, string>, carried: Map<CarriedPath, string>) => {
		const files: { path: string; bytes: Uint8Array }[] = [];
		for (const [path, hostDir] of carried) {
			if (path.kind !== "dir") continue;
			const boxDir = env[path.env] as string;
			for (const relative of path.in ?? []) {
				try {
					files.push({ path: posix.join(boxDir, relative), bytes: await readFile(join(hostDir, relative)) });
				} catch {
					// Not on the host: the runner goes without it.
				}
			}
		}
		if (files.length > 0) {
			const uploaded = await target.upload(files, BACKGROUND_CONTEXT);
			if (!uploaded.ok) throw new Error(`could not carry files into ${target.id}: ${uploaded.error.message}`);
		}
	};

	/** The carried files back to the host: what is new since the last time, from the box the runner ran in. */
	const carryOut = async (from: Box, env: Record<string, string>, carried: Map<CarriedPath, string>) => {
		for (const [path, hostPath] of carried) {
			const boxPath = env[path.env] as string;
			if (path.kind === "file") {
				const read = await from.download([boxPath], BACKGROUND_CONTEXT);
				if (!read.ok || read.value[0] === undefined) continue;
				await mkdir(dirname(hostPath), { recursive: true });
				await writeFile(`${hostPath}.carry`, read.value[0].bytes);
				await rename(`${hostPath}.carry`, hostPath);
				continue;
			}
			// Whole files first (a blob is read by name), then the lines that name them.
			for (const relative of path.once ?? []) {
				const here = join(hostPath, relative);
				const there = posix.join(boxPath, relative);
				for (const name of (await sizesIn(from, there)).keys()) {
					const target = join(here, name);
					if ((await sizeHere(target)) !== undefined) continue;
					const read = await from.download([posix.join(there, name)], BACKGROUND_CONTEXT);
					if (!read.ok || read.value[0] === undefined) continue;
					await mkdir(here, { recursive: true });
					await writeFile(`${target}.carry`, read.value[0].bytes);
					await rename(`${target}.carry`, target);
				}
			}
			const skip = new Set(path.in ?? []);
			for (const relative of path.append ?? []) {
				const here = join(hostPath, relative);
				const there = posix.join(boxPath, relative);
				for (const [name, size] of await sizesIn(from, there)) {
					if (skip.has(posix.join(relative, name))) continue;
					const target = join(here, name);
					const have = (await sizeHere(target)) ?? 0;
					if (size <= have) continue;
					const tail = await output(from, [
						"sh",
						"-c",
						'tail -c +"$2" "$1"',
						"sh",
						posix.join(there, name),
						String(have + 1),
					]);
					if (tail === undefined || tail.length === 0) continue;
					await mkdir(here, { recursive: true });
					await appendFile(target, tail.subarray(0, size - have));
				}
			}
		}
	};

	/**
	 * Start a runner in `at` at `epochAt` and hold it: what it writes on its error output is kept for its exit, a line
	 * `{"outcome":...}` ends it in order (the link closes, the home closes, the process exits 0), and its carried files
	 * come back while it runs and when it exits.
	 */
	const runnerOf = (env: Record<string, string>, carried: Map<CarriedPath, string>) => {
		let stderr = "";
		let outcome: Outcome | undefined;
		let started: BoxProcess | undefined;
		let held: HomeHandle | undefined;
		let ranIn: Box | undefined;
		const startRunner = boxRunner({
			program: options.program,
			session,
			models: options.models,
			...(options.records === undefined ? {} : { records: options.records }),
			crossing,
			crossingCount: counter,
			onProcess: (process) => {
				started = process;
			},
			onErrors: (text) => {
				stderr += text;
				if (outcome !== undefined) return;
				for (const line of stderr.split("\n")) {
					if (!line.startsWith('{"outcome"')) continue;
					try {
						outcome = (JSON.parse(line) as { outcome: Outcome }).outcome;
						held?.close("the runner reported its outcome");
					} catch {
						// The line is not whole yet.
					}
				}
			},
		});
		const start: StartRunner = async (at, epochAt, startContext) => {
			ranIn = at.box;
			await carryIn(at.box, env, carried);
			const begun = await startRunner(at, epochAt, startContext);
			if (begun.ok) held = begun.value;
			return begun;
		};
		const exited = async (): Promise<Exit> => {
			const followMs = options.followMs ?? 2_000;
			let following = false;
			const timer =
				followMs > 0
					? setInterval(() => {
							if (following || ranIn === undefined) return;
							following = true;
							void carryOut(ranIn, env, carried)
								.catch(() => {})
								.finally(() => {
									following = false;
								});
						}, followMs)
					: undefined;
			const waited = started === undefined ? undefined : await started.wait();
			if (timer !== undefined) clearInterval(timer);
			held?.close("the runner ended");
			if (ranIn !== undefined) await carryOut(ranIn, env, carried).catch(() => {});
			const code = waited?.ok ? waited.value : null;
			const signal =
				code !== null && code > 128
					? code === 137
						? "SIGKILL"
						: code === 143
							? "SIGTERM"
							: `signal ${code - 128}`
					: null;
			const said = stderr
				.split("\n")
				.filter((line) => !line.startsWith('{"outcome"'))
				.join("\n")
				.trim();
			return {
				exit: signal ?? code,
				signal,
				...(outcome === undefined ? {} : { outcome }),
				stderr: said.slice(0, 600),
			};
		};
		return { start, exited, handle: () => held };
	};

	const holder = (): Holder => ({ environment, provider: options.provider.name, box: box.id, host });

	const place: BoxPlace = {
		name: `box:${options.provider.name}`,
		get paths() {
			return paths;
		},
		kills: ["process", "box"],
		stats,
		requestFile: (n) => posix.join(paths.root, `kill-${n}.json`),
		async start(order) {
			attempt = order.gen;
			const { env, carried } = inBox(order);
			const taken = await options.ownership.take(session, holder(), 0, undefined, context);
			if (!taken.ok) throw new Error(`could not take the session's lease: ${taken.error.message}`);
			epoch = taken.value.epoch;
			const runner = runnerOf(env, carried);
			const begun = await runner.start(homePlace(), epoch, context);
			if (!begun.ok) throw begun.error;
			handle = begun.value;
			const ready = await handle.ready;
			if (!ready.ok) throw new Error(`the runner did not answer: ${ready.error.message}`);
			const resumed = await handle.resume({ epoch, env }, context);
			if (!resumed.ok) throw new Error(`the runner did not resume the session: ${resumed.error.message}`);
			return { epoch, exited: runner.exited() };
		},
		signals(n) {
			const file = place.requestFile(n);
			const pollMs = options.pollMs ?? 100;
			let closed = false;
			let last: string | undefined;
			let wake: (() => void) | undefined;
			const nap = () =>
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, pollMs);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			// A custom iterator, not a generator: `return()` must end a pending `next()`.
			const iterator: AsyncIterator<PlaceSignal> = {
				async next() {
					for (;;) {
						if (closed) return { done: true, value: undefined };
						const queued = queues.get(n)?.shift();
						if (queued !== undefined) return { done: false, value: queued };
						const read = await output(box, ["sh", "-c", 'cat "$1" 2>/dev/null; exit 0', "sh", file]);
						const text = new TextDecoder().decode(read ?? new Uint8Array());
						if (!closed && text !== "" && text !== last) {
							try {
								const { nonce, ...asked } = JSON.parse(text) as { nonce?: unknown } & PlaceSignal["crossing"];
								last = text;
								return {
									done: false,
									value: {
										kind: "kill-request",
										crossing: asked,
										...(typeof nonce === "string" ? { nonce } : {}),
									},
								};
							} catch {
								// Written whole by rename: a half read is read again.
							}
						}
						await nap();
					}
				},
				async return() {
					closed = true;
					wake?.();
					return { done: true, value: undefined };
				},
			};
			return { [Symbol.asyncIterator]: () => iterator };
		},
		async kill(runner, kind) {
			if (kind === "process") {
				const stopped = await killRunner(homePlace(), context);
				if (!stopped.ok) throw stopped.error;
			} else {
				const destroyed = await box.destroy(context);
				if (!destroyed.ok) throw destroyed.error;
			}
			await runner.exited;
		},
		async status() {
			const record: Record<string, unknown> = {
				run: session,
				generation: epoch,
				holder: { host: box.id, bootId: `epoch-${epoch}` },
			};
			const read = handle === undefined ? undefined : await handle.status(context);
			if (read?.ok) {
				record.status = read.value.state;
				if (read.value.sealed !== undefined) record.sealedSeq = read.value.sealed.head;
			} else {
				record.status = "stopped";
			}
			return { record };
		},
		async recover(last, kind, order) {
			await last.exited;
			attempt = order.gen;
			const { env, carried } = inBox(order);
			const runner = runnerOf(env, carried);
			const recovered = await recoverHome(
				{
					session,
					ownership: options.ownership,
					places: { [environment]: homePlace() },
					start: runner.start,
					notice: options.notice ?? DEFAULT_NOTICE,
					host,
					env,
					...(kind === "box"
						? {
								vault: options.vault,
								replace: async (_gone: HomePlace, replaceContext: Context) => {
									const next = await options.provider.create(options.spec, replaceContext);
									if (!next.ok) {
										return err(
											new MoveError(
												"prepare",
												`could not make a box in place of the lost one: ${next.error.message}`,
											),
										);
									}
									boxes.push(next.value);
									box = next.value;
									paths = pathsIn(box, session);
									return ok(homePlace());
								},
							}
						: {}),
				},
				context,
			);
			if (!recovered.ok) throw recovered.error;
			handle = recovered.value.home;
			epoch = recovered.value.lease.epoch;
			const { restored, replayed } = recovered.value;
			return {
				runner: { epoch, exited: runner.exited() },
				...(restored === undefined
					? {}
					: { restored: { checkpoint: String(restored.n), head: restored.seal.head } }),
				...(replayed === undefined ? {} : { replayed: { from: replayed.from, to: replayed.to } }),
			};
		},
		async checkpoint() {
			if (handle === undefined) return { taken: false, heldBy: "no runner" };
			const tries = options.checkpoint?.tries ?? 5;
			let heldBy = "busy";
			for (let n = 0; n < tries; n += 1) {
				const pulled = await pullCheckpoint(
					{
						session,
						place: homePlace(),
						home: handle,
						epoch,
						vault: options.vault,
						stats,
						crossing,
						crossingCount: counter,
						...(options.checkpoint?.drain === undefined ? {} : { drain: options.checkpoint.drain }),
						...(options.checkpoint?.holdMs === undefined ? {} : { holdMs: options.checkpoint.holdMs }),
						...(options.checkpoint?.workspace === undefined ? {} : { workspace: options.checkpoint.workspace }),
						...(options.checkpoint?.maxPullBytes === undefined
							? {}
							: { maxPullBytes: options.checkpoint.maxPullBytes }),
					},
					context,
				);
				if (pulled.ok) return { taken: true };
				heldBy =
					pulled.error.holdouts.length === 0
						? pulled.error.reason
						: `${pulled.error.reason}: ${pulled.error.holdouts.map(({ kind, count }) => `${count} ${kind}`).join(", ")}`;
				if (pulled.error.reason !== "busy") break;
				await new Promise((resolve) => setTimeout(resolve, options.checkpoint?.waitMs ?? 500));
			}
			return { taken: false, heldBy };
		},
		async release() {
			if (released) return;
			released = true;
			handle?.close("the place is released");
			for (const made of boxes) await made.destroy(context).catch(() => {});
		},
	};
	return ok(place);
}
