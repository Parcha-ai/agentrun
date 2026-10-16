import { createHash } from "node:crypto";
import { appendFile, mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box, BoxProcess, BoxProvider, BoxSpec } from "../box/box.ts";
import { finish } from "../box/files.ts";
import { type BoxReceipts, boxReceipts } from "../box/receipts.ts";
import {
	type CheckpointStats,
	type CheckpointVault,
	checkpointStats,
	pullCheckpoint,
	recordSink,
} from "../home/checkpoint.ts";
import { type Crossing, type CrossingCounter, crossingCounter } from "../home/crossing.ts";
import type { DrainOptions } from "../home/gate.ts";
import type { HomeHandle } from "../home/host.ts";
import { serveModels } from "../home/models.ts";
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

/** Why a recording's files did not all come home. `BOX_GONE`: the box the runner ran in is gone. `CARRY_FAILED`: a read in a box that is still there failed (try again). `BLOB_MISMATCH`: a blob's bytes do not hash to its name; it was not brought home, the rest was. */
export class RecordHomeError extends Error {
	public code: "BOX_GONE" | "CARRY_FAILED" | "BLOB_MISMATCH";

	constructor(code: RecordHomeError["code"], message: string) {
		super(message.slice(0, 240));
		this.name = "RecordHomeError";
		this.code = code;
	}
}

/**
 * A recording the runner writes in the box, which comes home by the supervisor's calls: `dir(attempt)` is the directory
 * attempt `attempt` writes it in, and `bringHome(into)` brings what is new to the host's recording directory `into`.
 */
export type RecordHome = {
	dir(attempt: number): string;
	bringHome(into: string, options?: { final?: boolean }): Promise<void>;
};

/** The live lines a box place writes, source `transport`. */
export type PlaceLineKind = "box.created" | "box.killed" | "box.ended" | "lease" | "restore";

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
	/**
	 * Where the recorder's lines go, and how far it holds them. The commits themselves always go to `vault`'s log
	 * (`recordSink`), the one log a lost box is restored from: the host passes the lines side only.
	 */
	readonly recorder?: Pick<RecordSink, "lines"> & { held(): number };
	/**
	 * Where checkpoints and the session's shipped commits are kept. A lost box is restored from the newest checkpoint and
	 * the commits since, or, before any checkpoint, from the commits alone: a box kill needs no checkpoint at rest, which
	 * only brings the workspace's files along.
	 */
	readonly vault: CheckpointVault;
	/** Who this host is, in the lease. Default `host`. */
	readonly host?: string;
	/** What a session restarted after a kill is told. */
	readonly notice?: string;
	/**
	 * The names in an order's environment of host files the runner writes (a crossings log): the runner is given a path
	 * in the box instead, and the file comes back whole when the runner exits.
	 */
	readonly carry?: readonly string[];
	/**
	 * The name in an order's environment of the host's recording directory. The runner is given `recordHome.dir(attempt)`
	 * instead (the recording's clock comes in the order's own environment), and the supervisor brings the recording home
	 * with `recordHome.bringHome`: every `.spool/*.jsonl` up to its last whole line, the blobs before them.
	 */
	readonly recording?: string;
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
	/** How often a runner's kill request is looked for in the box. Default 100 ms. */
	readonly pollMs?: number;
	/**
	 * The host's receipts ledger (`boxReceipts`): the place makes its boxes through it, so each box has its receipt and
	 * its label in the ledger's numbering, the label every line and record of the place names it by. Pass `provider`
	 * unwrapped (one the ledger already wraps is used as it is). Without it, the place labels its boxes `box-1`, `box-2`
	 * by itself and writes no receipt.
	 */
	readonly receipts?: BoxReceipts;
	/**
	 * The place's live lines, source `transport`, for the host to write: `box.created` `{ box, environment, provider,
	 * facts }` when it makes a box; `box.killed` `{ box }` before it destroys one at `kill(runner, "box")`; `box.ended`
	 * `{ box, provider, killed }` when one is gone; `lease` `{ epoch, holder }` when the session is taken at an epoch;
	 * `restore` `{ id, kind, epoch, head, from, to, checkpoint?, replayed? }` when a lost box's session lives again in a
	 * new one. A box is named by its label in every line, never by its provider's id.
	 */
	readonly lines?: (kind: PlaceLineKind, data: Readonly<Record<string, unknown>>) => void;
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
	/** With `recording`: the recording's way home. */
	readonly recordHome?: RecordHome;
	/** How far the box's clock may be from the host's, in ms: measured when the box is made. */
	readonly clockSkewMs: number;
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

/** How far `box`'s clock is from this machine's at most, in ms: one round trip to its node, less half the trip. */
async function skewOf(box: Box): Promise<number> {
	const before = Date.now();
	const said = await output(box, ["node", "-e", "process.stdout.write(String(Date.now()))"]);
	const after = Date.now();
	const there = Number(new TextDecoder().decode(said ?? new Uint8Array()));
	if (!Number.isFinite(there) || there <= 0) return 0;
	return Math.max(0, Math.round(Math.abs(there - (before + after) / 2) - (after - before) / 2));
}

/** Write `bytes` whole under a temporary name in its directory, sync it, and rename it into place. */
async function writeWhole(path: string, bytes: Uint8Array): Promise<void> {
	const temp = join(dirname(path), `.${path.slice(dirname(path).length + 1)}.tmp-${process.pid}`);
	const file = await open(temp, "w");
	try {
		await file.writeFile(bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temp, path);
}

/**
 * Make a session's place in a box: the box is made now, and the session's lease is taken when its first runner starts.
 * The place starts pi-transport's runner in the box (`boxRunner`), kills a runner by its process or by its box,
 * restarts it in the same box (`recoverHome`) or, for a lost box, in a new one from the newest checkpoint and the
 * commits since, or from the commits alone before any checkpoint (`restoreFromLog`), and takes checkpoints at rest
 * (`pullCheckpoint`), which a box kill does not need: they bring the workspace's files along.
 */
export async function boxPlace(options: BoxPlaceOptions, context: Context): Promise<Result<BoxPlace, MoveError>> {
	const { session, environment } = options;
	// Every box of the place is on a ledger, so that each has one label: the receipts', or the place's own.
	const ledger = options.receipts ?? boxReceipts({ prices: [], write: () => {} });
	const provider = ledger.wrap(options.provider);
	const labelOf = (one: Box) => ledger.labelOf(provider.name, one.id) ?? "a box with no label";
	const line = (kind: PlaceLineKind, data: Record<string, unknown>) => {
		try {
			options.lines?.(kind, data);
		} catch {
			// A recording line never fails the place.
		}
	};
	const where = (one: Box) => ({ environment, provider: provider.name, box: labelOf(one) });
	const announce = (one: Box) => {
		const { isolation, gpu, cpus } = one.facts();
		line("box.created", { ...where(one), facts: { isolation, gpu, cpus } });
	};
	const ended = new Set<Box>();
	const gone = (one: Box, killed: boolean) => {
		if (ended.has(one)) return;
		ended.add(one);
		line("box.ended", { box: labelOf(one), provider: provider.name, killed });
	};
	const made = await provider.create(options.spec, context);
	if (!made.ok) return err(new MoveError("prepare", `could not make the place's box: ${made.error.message}`));
	announce(made.value);
	const host = options.host ?? "host";
	const boxes: Box[] = [made.value];
	let box = made.value;
	let paths = pathsIn(box, session);
	let clockSkewMs = await skewOf(box);
	const homePlace = (): HomePlace => ({
		environment,
		provider: options.provider.name,
		box,
		store: paths.store,
		workspace: paths.work,
		// A move's or a restore's durable record names the box as the place's lines do.
		label: labelOf(box),
	});
	const counter: CrossingCounter = crossingCounter();
	const stats = checkpointStats();
	// One record stream and one model server for every runner of the session, whatever box it runs in: the vault's log
	// holds every commit, and a runner that comes back is answered what was paid for, not charged again.
	const records = recordSink(options.vault, session, BACKGROUND_CONTEXT, options.recorder);
	const server = serveModels(options.models);
	const queues = new Map<number, PlaceSignal[]>();
	let attempt = 0;
	let epoch = 0;
	let handle: HomeHandle | undefined;
	let released = false;
	// The checkpoint being taken: a call while one runs gets its answer, and never holds the session a second time.
	let taking: Promise<{ taken: boolean; heldBy?: string }> | undefined;

	const crossing: Crossing = (point, info) => {
		const { release: _release, box: id, ...told } = info;
		// A crossing that names a box names it by its label, as every line of the place does.
		const one = typeof id === "string" ? boxes.find((each) => each.id === id) : undefined;
		const queue = queues.get(attempt) ?? [];
		queue.push({
			kind: "crossing",
			crossing: { point, n: info.n, info: { ...told, ...(one === undefined ? {} : { box: labelOf(one) }) } },
		});
		queues.set(attempt, queue);
	};

	// Each attempt's recording directory: where it is, in which box, and the host's directory its clock came from.
	const recordings = new Map<number, { dir: string; into: string; box?: Box }>();
	// How many bytes of each spool file are home, by attempt and name.
	const spooled = new Map<string, number>();
	const recordDir = (n: number) => recordings.get(n)?.dir ?? posix.join(paths.root, `record-${n}`);

	/** The order's environment with every carried host path made a path in the box. */
	const inBox = (order: RunnerOrder, root: string): { env: Record<string, string>; carried: Map<string, string> } => {
		const env = { ...order.env };
		const carried = new Map<string, string>();
		for (const name of options.carry ?? []) {
			const there = env[name];
			if (there === undefined) continue;
			carried.set(name, there);
			env[name] = posix.join(root, "carried", `${name.toLowerCase()}-${order.gen}${posix.extname(there)}`);
		}
		const into = options.recording === undefined ? undefined : env[options.recording];
		if (options.recording !== undefined && into !== undefined) {
			const dir = posix.join(root, `record-${order.gen}`);
			recordings.set(order.gen, { dir, into });
			env[options.recording] = dir;
		}
		return { env, carried };
	};

	/** The box ready for attempt `n`'s runner: the directory of its carried files; its recording is kept to that box. */
	const prepareBox = async (target: Box, n: number) => {
		if ((options.carry ?? []).length > 0) {
			await output(target, ["mkdir", "-p", posix.join(pathsIn(target, session).root, "carried")]);
		}
		const recording = recordings.get(n);
		if (recording !== undefined) recording.box = target;
	};

	/** The carried files back to the host, whole, from the box the runner ran in. */
	const carryOut = async (from: Box, env: Record<string, string>, carried: Map<string, string>) => {
		for (const [name, hostPath] of carried) {
			const read = await from.download([env[name] as string], BACKGROUND_CONTEXT);
			if (!read.ok || read.value[0] === undefined) continue;
			await mkdir(dirname(hostPath), { recursive: true });
			await writeFile(`${hostPath}.carry`, read.value[0].bytes);
			await rename(`${hostPath}.carry`, hostPath);
		}
	};

	/** What is new of one attempt's recording, home: whole blobs first, then the spool's whole lines. */
	const bringAttempt = async (n: number, from: Box, dir: string, into: string) => {
		const mismatched: string[] = [];
		const blobs = posix.join(dir, "blobs");
		const listedBlobs = await output(from, ["sh", "-c", 'cd "$1" 2>/dev/null || exit 0; ls -A', "sh", blobs]);
		if (listedBlobs === undefined)
			throw new RecordHomeError("CARRY_FAILED", `the blobs of attempt ${n} could not be listed`);
		for (const name of new TextDecoder().decode(listedBlobs).split("\n")) {
			const hash = /^([0-9a-f]{64})(\..+)?$/.exec(name)?.[1];
			if (hash === undefined) continue;
			const target = join(into, "blobs", name);
			if ((await sizeHere(target)) !== undefined) continue;
			const read = await from.download([posix.join(blobs, name)], BACKGROUND_CONTEXT);
			if (!read.ok || read.value[0] === undefined) {
				throw new RecordHomeError("CARRY_FAILED", `a blob of attempt ${n} could not be read`);
			}
			const bytes = read.value[0].bytes;
			if (createHash("sha256").update(bytes).digest("hex") !== hash) {
				mismatched.push(name);
				continue;
			}
			await mkdir(join(into, "blobs"), { recursive: true });
			await writeWhole(target, bytes);
		}
		const spool = posix.join(dir, ".spool");
		for (const [name, size] of await sizesIn(from, spool)) {
			if (!name.endsWith(".jsonl")) continue;
			const key = `${n}/${name}`;
			const have = spooled.get(key) ?? 0;
			if (size <= have) continue;
			const tail = await output(from, [
				"sh",
				"-c",
				'tail -c +"$2" "$1"',
				"sh",
				posix.join(spool, name),
				String(have + 1),
			]);
			if (tail === undefined)
				throw new RecordHomeError("CARRY_FAILED", `a spool file of attempt ${n} could not be read`);
			const bytes = tail.subarray(0, size - have);
			// Up to the last whole line: a line being written comes with the next call.
			const end = bytes.lastIndexOf(0x0a);
			if (end < 0) continue;
			await mkdir(join(into, ".spool"), { recursive: true });
			await appendFile(join(into, ".spool", name), bytes.subarray(0, end + 1));
			spooled.set(key, have + end + 1);
		}
		if (mismatched.length > 0) {
			throw new RecordHomeError(
				"BLOB_MISMATCH",
				`${mismatched.length} blob(s) of attempt ${n} do not hash to their names`,
			);
		}
	};

	const recordHome: RecordHome = {
		dir: recordDir,
		async bringHome(into) {
			for (const [n, recording] of recordings) {
				if (recording.box === undefined || recording.into !== into) continue;
				// An attempt of a box the place left behind (a lost box replaced) brought home what it could at its end.
				if (recording.box !== box) continue;
				const there = await provider.attach(recording.box.id, BACKGROUND_CONTEXT);
				if (there.ok && there.value === undefined) {
					throw new RecordHomeError("BOX_GONE", `the box of attempt ${n} is gone`);
				}
				await bringAttempt(n, recording.box, recording.dir, recording.into);
			}
		},
	};

	/**
	 * Start a runner in `at` at `epochAt` and hold it: what it writes on its error output is kept for its exit, a line
	 * `{"outcome":...}` ends it in order (the link closes, the home closes, the process exits 0), and its carried files
	 * come back while it runs and when it exits.
	 */
	const runnerOf = (gen: number, env: Record<string, string>, carried: Map<string, string>) => {
		let stderr = "";
		let outcome: Outcome | undefined;
		let started: BoxProcess | undefined;
		let held: HomeHandle | undefined;
		let ranIn: Box | undefined;
		const startRunner = boxRunner({
			program: options.program,
			session,
			models: options.models,
			server,
			records,
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
			await prepareBox(at.box, gen);
			const begun = await startRunner(at, epochAt, startContext);
			if (begun.ok) held = begun.value;
			return begun;
		};
		const exited = async (): Promise<Exit> => {
			const waited = started === undefined ? undefined : await started.wait();
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

	/** One checkpoint at rest, tried again while the session is busy, as many times as the options say. */
	const takeCheckpoint = async (): Promise<{ taken: boolean; heldBy?: string }> => {
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
					answers: server,
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
	};

	const holder = (): Holder => ({ environment, provider: options.provider.name, box: box.id, host });

	const place: BoxPlace = {
		name: `box:${options.provider.name}`,
		get paths() {
			return paths;
		},
		kills: ["process", "box"],
		stats,
		get clockSkewMs() {
			return clockSkewMs;
		},
		...(options.recording === undefined ? {} : { recordHome }),
		requestFile: (n) => posix.join(paths.root, `kill-${n}.json`),
		async start(order) {
			attempt = order.gen;
			const { env, carried } = inBox(order, paths.root);
			const taken = await options.ownership.take(session, holder(), 0, undefined, context);
			if (!taken.ok) throw new Error(`could not take the session's lease: ${taken.error.message}`);
			epoch = taken.value.epoch;
			line("lease", { epoch, holder: where(box) });
			const runner = runnerOf(order.gen, env, carried);
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
				const lost = box;
				// A planned loss: written before the box is destroyed, and the box ended once it is.
				line("box.killed", { box: labelOf(lost) });
				const destroyed = await lost.destroy(context);
				if (!destroyed.ok) throw destroyed.error;
				gone(lost, true);
			}
			await runner.exited;
		},
		async status() {
			const record: Record<string, unknown> = {
				run: session,
				generation: epoch,
				holder: { host: labelOf(box), bootId: `epoch-${epoch}` },
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
			// The place the lease names: a lost box is found gone there, and its replacement is made first, so that the
			// order's paths are the new box's.
			const named = homePlace();
			let next: Box | undefined;
			if (kind === "box") {
				// A box lost other than by `kill` ended too: the session waits for its next box.
				gone(named.box, false);
				const made = await provider.create(options.spec, context);
				if (!made.ok)
					throw new MoveError("prepare", `could not make a box in place of the lost one: ${made.error.message}`);
				next = made.value;
				boxes.push(next);
				announce(next);
			}
			const { env, carried } = inBox(order, (next === undefined ? paths : pathsIn(next, session)).root);
			const runner = runnerOf(order.gen, env, carried);
			const recovered = await recoverHome(
				{
					session,
					ownership: options.ownership,
					places: { [environment]: named },
					start: runner.start,
					notice: options.notice ?? DEFAULT_NOTICE,
					host,
					env,
					...(next === undefined
						? {}
						: {
								vault: options.vault,
								// Before any checkpoint, the session is rebuilt from the vault's log alone: a box kill needs no rest.
								restoreFromLog: true,
								replace: async () => {
									box = next;
									paths = pathsIn(next, session);
									clockSkewMs = await skewOf(next);
									return ok(homePlace());
								},
							}),
				},
				context,
			);
			if (!recovered.ok) throw recovered.error;
			handle = recovered.value.home;
			epoch = recovered.value.lease.epoch;
			const { restored, replayed } = recovered.value;
			if (next !== undefined) {
				// The hop: from the lost box to the one the session lives in now, each by its label.
				const head = replayed !== undefined ? replayed.to + 1 : restored?.seal.head;
				line("lease", { epoch, holder: where(box) });
				line("restore", {
					id: recovered.value.lease.move ?? `restore-${epoch}`,
					kind: "restore",
					epoch,
					...(head === undefined ? {} : { head }),
					from: where(named.box),
					to: where(box),
					...(restored === undefined ? {} : { checkpoint: { n: restored.n, head: restored.seal.head } }),
					...(replayed === undefined ? {} : { replayed: { from: replayed.from, to: replayed.to } }),
				});
			}
			return {
				runner: { epoch, exited: runner.exited() },
				...(restored === undefined
					? {}
					: { restored: { checkpoint: String(restored.n), head: restored.seal.head } }),
				...(replayed === undefined ? {} : { replayed: { from: replayed.from, to: replayed.to } }),
			};
		},
		checkpoint() {
			taking ??= takeCheckpoint().finally(() => {
				taking = undefined;
			});
			return taking;
		},
		async release() {
			if (released) return;
			released = true;
			handle?.close("the place is released");
			server.close();
			for (const made of boxes) {
				const destroyed = await made.destroy(context).catch(() => undefined);
				if (destroyed?.ok === true) gone(made, false);
			}
		},
	};
	return ok(place);
}
