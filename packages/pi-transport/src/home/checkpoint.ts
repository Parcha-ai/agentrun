import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Box, BoxError, type BoxExecOptions, type BoxFacts, type BoxProcess } from "../box/box.ts";
import { adaptChild } from "../box/child.ts";
import { downloadByExec, uploadByExec } from "../box/files.ts";
import type { LogEntry } from "./commit-log.ts";
import type { Crossing, CrossingCounter } from "./crossing.ts";
import type { DrainOptions } from "./gate.ts";
import type { CallRecord, HomeHandle } from "./host.ts";
import type { Place } from "./move.ts";
import type { RecordSink } from "./records.ts";
import type { Seal } from "./store.ts";
import {
	changedEntries,
	type Excluded,
	excludedOf,
	type Manifest,
	moveFile,
	pullContents,
	treeProblem,
	treeSince,
	type WantedContent,
	type WorkspaceOptions,
} from "./workspace.ts";

/**
 * Why a vault call failed. Returned, never thrown. `refused`: a generation an earlier version of the vault kept as a tree
 * the host unpacked; it is never read, unpacked or restored.
 */
export class VaultError extends Error {
	public code: "io" | "invalid" | "gap" | "refused";
	/** For `gap`: the highest commit the vault holds in an unbroken run. */
	public through: number | undefined;

	constructor(code: VaultError["code"], message: string, cause?: unknown, through?: number) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "VaultError";
		this.code = code;
		this.through = through;
	}
}

/**
 * One checkpoint, as the vault keeps it. The workspace is its `manifest`: every entry, with its kind, mode, time, link
 * target and, for a file, SHA-256 and size. A file's content is in the vault under its SHA-256 (`CheckpointVault.content`);
 * a directory, a link, a hard link and a named pipe are the record alone, and are made only in the box a restore goes to.
 */
export type Checkpoint = {
	readonly session: string;
	/** The generation number, 1 for the first, one more each time. */
	readonly n: number;
	/** When the session was held for it, by the host's clock, in milliseconds since 1970. */
	readonly at: number;
	/** The epoch of the lease that named the home it was taken from. */
	readonly epoch: number;
	readonly seal: Seal;
	readonly manifest: Manifest;
	/** What `exclude` left out of the workspace, absent when nothing was excluded. A restore does not bring it back. */
	readonly excluded?: Excluded;
	/** The store's file, in `CheckpointVault.box`. */
	readonly storeFile: string;
};

/** A generation being made: its store's path exists and it is not a checkpoint yet. */
export type PendingCheckpoint = {
	readonly session: string;
	readonly n: number;
	readonly storeFile: string;
	/** The latest checkpoint when it was begun, whose manifest the delta is taken against. */
	readonly previous: Checkpoint | undefined;
};

/** A file's content on its way into a vault: kept whole under its SHA-256, or not at all. */
export interface ContentWriter {
	write(bytes: Uint8Array): Promise<void>;
	/** The content is whole: kept only when it hashes to the SHA-256 and has the size it was opened with. */
	end(): Promise<Result<void, VaultError>>;
	/** Give up: nothing is kept. */
	abort(): Promise<void>;
}

/**
 * Where a host keeps the checkpoints of its sessions, as generations. A generation is a checkpoint only when `commit`
 * has recorded it; `latest` never names a half-made one.
 */
export interface CheckpointVault {
	/**
	 * The box the generations' store files are in: the movers copy them to and from it. The workspace never goes through
	 * it: its files are contents (`keep`, `content`) and its tree is the record.
	 */
	readonly box: Box;
	/** Whether the vault holds the content with this SHA-256 (lowercase hex) and size, for the session. */
	holds(session: string, sha256: string, bytes: number, context: Context): Promise<boolean>;
	/**
	 * Keep a file's content for the session, under its SHA-256. The bytes are opaque: the vault makes nothing of them but
	 * that one content, and keeps it only when it hashes to the name.
	 */
	keep(session: string, sha256: string, bytes: number, context: Context): Promise<Result<ContentWriter, VaultError>>;
	/** The content with this SHA-256, as the vault holds it; `undefined` when it holds none. */
	content(session: string, sha256: string): AsyncIterable<Uint8Array> | undefined;
	/** Make the path of the next generation's store. Its files are contents the vault keeps or already holds. */
	begin(session: string, context: Context): Promise<Result<PendingCheckpoint, VaultError>>;
	/** Record a generation: after this, `latest` names it. */
	commit(
		pending: PendingCheckpoint,
		meta: Pick<Checkpoint, "at" | "epoch" | "seal" | "manifest" | "excluded">,
		context: Context,
	): Promise<Result<Checkpoint, VaultError>>;
	/** Remove a generation that was begun and not committed. */
	discard(pending: PendingCheckpoint): Promise<void>;
	latest(session: string, context: Context): Promise<Result<Checkpoint | undefined, VaultError>>;
	get(session: string, n: number, context: Context): Promise<Result<Checkpoint | undefined, VaultError>>;
	/** Keep the newest `keep` generations of the session and remove the rest. Returns how many were removed. */
	prune(session: string, keep: number, context: Context): Promise<Result<number, VaultError>>;
	/**
	 * Keep the commits a runner shipped, in order and without a gap, on disk before this returns. A commit already held
	 * is not written again; one that does not follow the last is refused with `gap` and `through` says what the vault
	 * holds, so the runner sends again from there. Commits below the latest checkpoint's head are covered by it and
	 * are not kept. `through` is the highest commit held in an unbroken run from the checkpoint.
	 */
	appendLog(
		session: string,
		entries: readonly LogEntry[],
		context: Context,
	): Promise<Result<{ readonly through: number }, VaultError>>;
	/**
	 * The highest commit the vault holds in an unbroken run from the latest checkpoint (the commit before its head when
	 * no shipped commit follows it, 0 when there is neither): where the runner is to send from, asked synchronously
	 * when a link comes up.
	 */
	through(session: string): number;
	/**
	 * Forget the shipped commits above `through`: a restore that did not replay them has made them a branch that no longer
	 * exists, and the runner at the new epoch will commit those numbers again. Afterwards `through` is at most this.
	 */
	dropLogAbove(session: string, through: number, context: Context): Promise<Result<void, VaultError>>;
	/** The shipped commits from `from` on, the unbroken run only; `gap` says commits beyond a break were held. */
	readLog(
		session: string,
		from: number,
		context: Context,
	): Promise<Result<{ readonly entries: readonly LogEntry[]; readonly gap: boolean }, VaultError>>;
}

const DEFAULT_KEEP = 3;

/** A box that is this machine, for the movers to copy into and out of a directory of the vault. No watchdog, no record. */
function hostBox(directory: string): Box {
	const facts: BoxFacts = {
		provider: "vault",
		isolation: "none",
		cpus: null,
		memoryMb: null,
		gpu: null,
		workspace: directory,
		maxLifetimeMs: null,
		snapshot: null,
		bulk: "stream",
	};
	const box: Box = {
		id: `vault:${directory}`,
		facts: () => facts,
		exec(command: readonly string[], options: BoxExecOptions | undefined, context: Context) {
			if (command.length === 0) return Promise.resolve(err(new BoxError("invalid", "the command is empty")));
			const child = spawn(command[0] as string, command.slice(1), {
				cwd: directory,
				stdio: ["pipe", "pipe", "pipe"],
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory, TMPDIR: directory },
			});
			const process_ = adaptChild(child, () => child.kill("SIGKILL"), options, context);
			return Promise.resolve(ok(process_ satisfies BoxProcess));
		},
		upload: (files, context) => uploadByExec(box, files, context),
		download: (paths, context) => downloadByExec(box, paths, context),
		status: async () => ok({ state: "running" as const }),
		destroy: async () => ok(undefined),
	};
	return box;
}

const generationName = (n: number) => `gen-${String(n).padStart(8, "0")}`;
/** The records this vault writes say so; one without it was written by an earlier version, beside a tree it unpacked. */
const RECORD_FORMAT = 2;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const READ_CHUNK = 64 * 1024;

type GenerationRecord = Omit<Checkpoint, "storeFile" | "session" | "n"> & { readonly format?: number };

/**
 * A vault in a directory of this machine. A generation is `gen-<n>.json`, its record (the manifest included), and
 * `gen-<n>/store.db`; the content of every file is kept once per session in `contents/<sha256>`, a plain file of the
 * host's own, so a generation costs only what changed. Nothing a box sent becomes anything else on this machine: no
 * link, hard link, pipe, device or setuid file is ever made here. `latest` is the highest number with a record; a
 * record is written whole and renamed into place after the generation's store and contents are in, and contents no
 * kept record names are removed with the generations that named them.
 *
 * A generation an earlier version kept (a record without `format`, beside a tree the host unpacked) is `refused`: it
 * is never read, unpacked or restored, and goes when `prune` removes it.
 */
export function localVault(directory: string): CheckpointVault {
	const box = hostBox(directory);
	const dirOf = (session: string) => join(directory, encodeURIComponent(session));
	const contentsOf = (session: string) => join(dirOf(session), "contents");
	const contentPath = (session: string, sha256: string) =>
		SHA256_HEX.test(sha256) ? join(contentsOf(session), sha256) : undefined;
	const numbers = (session: string): number[] => {
		try {
			return readdirSync(dirOf(session))
				.map((name) => /^gen-(\d{8})\.json$/.exec(name)?.[1])
				.filter((value): value is string => value !== undefined)
				.map(Number)
				.sort((a, b) => a - b);
		} catch {
			return [];
		}
	};
	const recordOf = (session: string, n: number): GenerationRecord | undefined => {
		try {
			return JSON.parse(readFileSync(join(dirOf(session), `${generationName(n)}.json`), "utf8")) as GenerationRecord;
		} catch {
			return undefined;
		}
	};
	const read = (session: string, n: number): Checkpoint | "refused" | undefined => {
		const record = recordOf(session, n);
		if (record === undefined) return undefined;
		if (record.format !== RECORD_FORMAT) return "refused";
		const { format: _format, ...meta } = record;
		return { session, n, ...meta, storeFile: join(dirOf(session), generationName(n), "store.db") };
	};
	const refused = (session: string, n: number) =>
		new VaultError(
			"refused",
			`generation ${n} of ${session} was kept by an earlier version of the vault, as a tree the host unpacked: it is refused, never read, unpacked or restored`,
		);
	/** The contents no readable record of this vault names, and the halves of contents that were never finished, go. */
	const sweep = (session: string) => {
		const named = new Set<string>();
		for (const n of numbers(session)) {
			const found = read(session, n);
			if (typeof found !== "object") continue;
			for (const entry of found.manifest.entries) if (entry.sha256 !== undefined) named.add(entry.sha256);
		}
		let names: string[];
		try {
			names = readdirSync(contentsOf(session));
		} catch {
			return;
		}
		for (const name of names) if (!named.has(name)) rmSync(join(contentsOf(session), name), { force: true });
	};
	const io = (what: string, cause: unknown) =>
		new VaultError("io", `${what}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);

	const logFile = (session: string) => join(dirOf(session), "commits.jsonl");
	const readEntries = (session: string): LogEntry[] => {
		let text: string;
		try {
			text = readFileSync(logFile(session), "utf8");
		} catch {
			return [];
		}
		// A last line without its newline is a write the host did not finish: it was never acknowledged.
		const end = text.lastIndexOf("\n");
		if (end < 0) return [];
		return text
			.slice(0, end)
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as LogEntry);
	};
	const heldThrough = new Map<string, number | undefined>();
	/** The highest commit that is in an unbroken run from the latest checkpoint, or `undefined` when nothing anchors it. */
	const through = (session: string): number | undefined => {
		if (!heldThrough.has(session)) {
			const entries = readEntries(session);
			heldThrough.set(session, entries.length === 0 ? undefined : (entries.at(-1) as LogEntry).commit);
		}
		const all = numbers(session);
		const head = all.length === 0 ? undefined : recordOf(session, all.at(-1) as number)?.seal.head;
		const held = heldThrough.get(session);
		if (head === undefined) return held;
		return held === undefined ? head - 1 : Math.max(held, head - 1);
	};

	return {
		box,
		async begin(session) {
			try {
				mkdirSync(dirOf(session), { recursive: true });
				const all = numbers(session);
				let previous: Checkpoint | undefined;
				for (const n of [...all].reverse()) {
					const found = read(session, n);
					if (typeof found === "object") {
						previous = found;
						break;
					}
				}
				// Numbers are never reused, also over a generation that was removed or never committed.
				let n = (all.at(-1) ?? 0) + 1;
				while (readdirSync(dirOf(session)).includes(generationName(n))) n += 1;
				const base = join(dirOf(session), generationName(n));
				mkdirSync(base, { recursive: true });
				return ok({ session, n, storeFile: join(base, "store.db"), previous });
			} catch (cause) {
				return err(io("could not begin a generation", cause));
			}
		},
		async commit(pending, meta) {
			try {
				const record: GenerationRecord = {
					format: RECORD_FORMAT,
					at: meta.at,
					epoch: meta.epoch,
					seal: meta.seal,
					manifest: meta.manifest,
					...(meta.excluded === undefined ? {} : { excluded: meta.excluded }),
				};
				const file = join(dirOf(pending.session), `${generationName(pending.n)}.json`);
				writeFileSync(`${file}.partial`, JSON.stringify(record));
				renameSync(`${file}.partial`, file);
				return ok({ session: pending.session, n: pending.n, ...meta, storeFile: pending.storeFile });
			} catch (cause) {
				return err(io("could not record the generation", cause));
			}
		},
		async discard(pending) {
			rmSync(join(dirOf(pending.session), generationName(pending.n)), { recursive: true, force: true });
			sweep(pending.session);
		},
		async latest(session) {
			// The newest record that reads: one that was damaged on disk does not hide the generations before it. An
			// earlier version's generation is older than every one this version made, so it is the newest only alone.
			for (const n of numbers(session).reverse()) {
				const found = read(session, n);
				if (found === "refused") return err(refused(session, n));
				if (found !== undefined) return ok(found);
			}
			return ok(undefined);
		},
		async get(session, n) {
			const found = read(session, n);
			return found === "refused" ? err(refused(session, n)) : ok(found);
		},
		async holds(session, sha256, bytes) {
			const path = contentPath(session, sha256);
			const found = path === undefined ? undefined : statSync(path, { throwIfNoEntry: false });
			return found?.isFile() === true && found.size === bytes;
		},
		async keep(session, sha256, bytes) {
			const path = contentPath(session, sha256);
			if (path === undefined || !Number.isSafeInteger(bytes) || bytes < 0) {
				return err(new VaultError("invalid", `${JSON.stringify(sha256)} is not a SHA-256 to keep a content under`));
			}
			const partial = join(contentsOf(session), `.in-${randomUUID()}`);
			let handle: Awaited<ReturnType<typeof open>>;
			try {
				mkdirSync(contentsOf(session), { recursive: true });
				handle = await open(
					partial,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				);
			} catch (cause) {
				return err(io("could not keep a content", cause));
			}
			const hash = createHash("sha256");
			let size = 0;
			let closed = false;
			const close = async () => {
				if (closed) return;
				closed = true;
				await handle.close();
			};
			return ok({
				async write(chunk) {
					hash.update(chunk);
					size += chunk.length;
					for (let at = 0; at < chunk.length; ) at += (await handle.write(chunk, at)).bytesWritten;
				},
				async end() {
					try {
						await close();
						const got = hash.digest("hex");
						if (size !== bytes || got !== sha256) {
							rmSync(partial, { force: true });
							return err(
								new VaultError(
									"invalid",
									`the content is ${size} bytes with SHA-256 ${got}, not ${bytes} with ${sha256}`,
								),
							);
						}
						renameSync(partial, path);
						return ok(undefined);
					} catch (cause) {
						rmSync(partial, { force: true });
						return err(io("could not keep a content", cause));
					}
				},
				async abort() {
					await close().catch(() => {});
					rmSync(partial, { force: true });
				},
			});
		},
		content(session, sha256) {
			const path = contentPath(session, sha256);
			if (path === undefined || statSync(path, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
			return (async function* () {
				const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					for (;;) {
						const buffer = Buffer.allocUnsafe(READ_CHUNK);
						const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, null);
						if (bytesRead === 0) return;
						yield buffer.subarray(0, bytesRead);
					}
				} finally {
					await handle.close();
				}
			})();
		},
		async prune(session, keep) {
			try {
				const all = numbers(session);
				const gone = all.slice(0, Math.max(0, all.length - Math.max(1, keep)));
				for (const n of gone) {
					// The record first: a generation without its record is not a checkpoint any more.
					rmSync(join(dirOf(session), `${generationName(n)}.json`), { force: true });
					rmSync(join(dirOf(session), generationName(n)), { recursive: true, force: true });
				}
				// What no kept generation needs any more: commits below the oldest kept head.
				const kept = numbers(session)
					.map((n) => recordOf(session, n)?.seal.head)
					.filter((head): head is number => head !== undefined);
				if (kept.length > 0) {
					const oldest = Math.min(...kept);
					const entries = readEntries(session);
					if (entries.some((entry) => entry.commit < oldest)) {
						const file = logFile(session);
						writeFileSync(
							`${file}.partial`,
							entries
								.filter((entry) => entry.commit >= oldest)
								.map((entry) => `${JSON.stringify(entry)}\n`)
								.join(""),
						);
						renameSync(`${file}.partial`, file);
					}
				}
				sweep(session);
				return ok(gone.length);
			} catch (cause) {
				return err(io("could not remove old generations", cause));
			}
		},
		async appendLog(session, entries) {
			try {
				mkdirSync(dirOf(session), { recursive: true });
				let last = through(session);
				const accepted: LogEntry[] = [];
				let refused: LogEntry | undefined;
				for (const entry of entries) {
					if (last !== undefined && entry.commit <= last) continue;
					if (last !== undefined && entry.commit !== last + 1) {
						refused = entry;
						break;
					}
					accepted.push(entry);
					last = entry.commit;
				}
				if (accepted.length > 0) {
					const descriptor = openSync(logFile(session), "a");
					try {
						appendFileSync(descriptor, accepted.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
						fsyncSync(descriptor);
					} finally {
						closeSync(descriptor);
					}
					heldThrough.set(session, last);
				}
				if (refused !== undefined) {
					return err(
						new VaultError(
							"gap",
							`commit ${refused.commit} came where ${(last ?? -1) + 1} was next`,
							undefined,
							last,
						),
					);
				}
				return ok({ through: last ?? -1 });
			} catch (cause) {
				return err(io("could not keep the shipped commits", cause));
			}
		},
		through: (session) => Math.max(0, through(session) ?? 0),
		async dropLogAbove(session, limit) {
			try {
				const entries = readEntries(session);
				if (entries.some((entry) => entry.commit > limit)) {
					const file = logFile(session);
					writeFileSync(
						`${file}.partial`,
						entries
							.filter((entry) => entry.commit <= limit)
							.map((entry) => `${JSON.stringify(entry)}\n`)
							.join(""),
					);
					renameSync(`${file}.partial`, file);
				}
				const kept = entries.filter((entry) => entry.commit <= limit);
				heldThrough.set(session, kept.length === 0 ? undefined : (kept.at(-1) as LogEntry).commit);
				return ok(undefined);
			} catch (cause) {
				return err(io("could not drop the shipped commits above the restore", cause));
			}
		},
		async readLog(session, from) {
			try {
				const entries = readEntries(session)
					.filter((entry) => entry.commit >= from)
					.sort((a, b) => a.commit - b.commit);
				const run: LogEntry[] = [];
				for (const entry of entries) {
					if (entry.commit !== from + run.length) break;
					run.push(entry);
				}
				return ok({ entries: run, gap: run.length < entries.length });
			} catch (cause) {
				return err(io("could not read the shipped commits", cause));
			}
		},
	};
}

/** Why a checkpoint was not taken. `busy`: the session did not come to rest in time. `changed`: the workspace changed while it was pulled. */
export type SkipReason = "busy" | "changed" | "too_large" | "failed";

/** What the host knows of its checkpoints, for a panel to show: how many were taken and why the others were not. */
export type CheckpointStats = {
	taken: number;
	skipped: Record<SkipReason, number>;
	/** The newest checkpoint taken. */
	last?: { n: number; at: number; ms: number; bytes: number; heldMs: number };
	/** The longest the session was held for a pull, in ms, whether it was kept or skipped. */
	longestHeldMs?: number;
	/** The newest skip, with what held it. */
	lastSkip?: { reason: SkipReason; message: string; at: number; holdouts: readonly { kind: string; count: number }[] };
};

/** A fresh count. */
export function checkpointStats(): CheckpointStats {
	return { taken: 0, skipped: { busy: 0, changed: 0, too_large: 0, failed: 0 } };
}

/** A checkpoint that was not taken, and why. The session went on where it was; the previous checkpoint is still the latest. */
export class CheckpointSkipped extends Error {
	public reason: SkipReason;
	public holdouts: readonly { kind: string; count: number }[];

	constructor(reason: SkipReason, message: string, holdouts: CheckpointSkipped["holdouts"] = [], cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CheckpointSkipped";
		this.reason = reason;
		this.holdouts = holdouts;
	}
}

export type PullOptions = {
	readonly session: string;
	/** The home's place and the host's hold on it. */
	readonly place: Place;
	readonly home: HomeHandle;
	/** The epoch of the lease that names it. */
	readonly epoch: number;
	readonly vault: CheckpointVault;
	/** How long the session may take to come to rest. Default 10 s: a checkpoint is skipped, never waited for long. */
	readonly drain?: DrainOptions;
	/**
	 * `exclude`: paths or globs (see `WorkspaceOptions`) never pulled, never hashed and not restored, e.g. a media cache
	 * the session downloads again. `maxBytes`: the most the workspace may hold, excluded paths not counted.
	 */
	readonly workspace?: WorkspaceOptions & { readonly maxBytes?: number };
	/**
	 * The most one pull may move: the store's copy and the files that changed since the previous checkpoint. A pull
	 * over it is skipped as `too_large` before any file moves, and the session goes on.
	 */
	readonly maxPullBytes?: number;
	/** The longest the session may be held, from the moment it came to rest, to have the checkpoint on the host. Default 2 minutes. */
	readonly holdMs?: number;
	/** Generations kept. Default 3. */
	readonly keep?: number;
	readonly stats?: CheckpointStats;
	/**
	 * The host's model server. Once a checkpoint is kept, the paid answers below the oldest kept generation's head are
	 * let go: a restore never asks for them again, even when it falls back to that generation.
	 */
	readonly answers?: { covered(head: number): void };
	/**
	 * Announced, awaited, once the checkpoint is committed, the session is let go and the stats are updated:
	 * `transport.checkpoint.taken`. A caller that kills the box does it here; the checkpoint is then the latest. A pull that
	 * is skipped announces nothing. A handler that throws makes the pull return `failed` with the error, and the
	 * checkpoint stays taken.
	 */
	readonly crossing?: Crossing;
	/** The place's counter. Default: the number of checkpoints these stats count as taken (1 without stats). */
	readonly crossingCount?: CrossingCounter;
};

const DEFAULT_PULL_DRAIN_MS = 10_000;
const DEFAULT_HOLD_MS = 120_000;

/**
 * Take a checkpoint of the session now. The session is held (a drain) for the store's copy and the workspace's manifest,
 * and stays held until the store and the changed files are on the host and checked, so that they are of one moment;
 * `holdMs` bounds that. A checkpoint is whole (store, workspace, one moment) or it is skipped: `busy` when the session
 * did not come to rest, `changed` when a file no longer matched its manifest, `too_large` over `maxBytes` or
 * `maxPullBytes`, `failed` for the rest. A skipped checkpoint leaves the previous one the latest and the session running.
 *
 * Checkpoint at rest. A drain cannot hold a model request that was already sent, nor a tool already running past its
 * hook: a pull asked for during one is skipped as `busy` (with what held it, in `CheckpointStats.lastSkip`), and the
 * next turn end tries again. A host that wants its checkpoints calls this when the session is idle, not on a timer.
 */
export async function pullCheckpoint(
	options: PullOptions,
	context: Context,
): Promise<Result<Checkpoint, CheckpointSkipped>> {
	const started = performance.now();
	let bytes = 0;
	const { session, place, home, vault } = options;
	const skip = (
		reason: SkipReason,
		message: string,
		holdouts: CheckpointSkipped["holdouts"] = [],
		cause?: unknown,
	) => {
		const skipped = new CheckpointSkipped(reason, message, holdouts, cause);
		if (options.stats !== undefined) {
			options.stats.skipped[reason] += 1;
			options.stats.lastSkip = { reason, message, at: Date.now(), holdouts };
		}
		return { ok: false as const, error: skipped };
	};
	const latest = await vault.latest(session, context);
	// A generation an earlier version kept is never read: the pull takes the workspace afresh.
	if (!latest.ok && latest.error.code !== "refused") return skip("failed", latest.error.message, [], latest.error);
	const previous = latest.ok ? latest.value : undefined;

	const held = await home.checkpoint(options.drain ?? { timeoutMs: DEFAULT_PULL_DRAIN_MS }, context);
	if (!held.ok) {
		return skip(
			held.error.code === "timeout" ? "busy" : "failed",
			held.error.message,
			held.error.holdouts,
			held.error,
		);
	}
	const at = Date.now();
	// The session stays held until everything of this moment is on the host, so that the files and the store are of one
	// moment; it is let go whatever happens, and no longer than `holdMs` after it came to rest.
	const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
	const heldFrom = performance.now();
	/** What is left of the hold, for the call about to start: every phase of the pull draws on the same `holdMs`. */
	const left = () => Math.max(1, Math.floor(holdMs - (performance.now() - heldFrom)));
	const over = () => performance.now() - heldFrom >= holdMs;
	const timedOut = (phase: string) =>
		skip("failed", `the session was held ${holdMs} ms and the checkpoint was not done: it ran out before ${phase}`);
	const calls = () => ({
		...options.workspace,
		callTimeoutMs: Math.min(options.workspace?.callTimeoutMs ?? left(), left()),
	});
	let committed: Result<Checkpoint, CheckpointSkipped>;
	try {
		committed = await (async (): Promise<Result<Checkpoint, CheckpointSkipped>> => {
			const manifest = await treeSince(place.box, place.workspace, previous?.manifest, calls(), context);
			if (!manifest.ok)
				return skip(
					manifest.error.code === "too_large" ? "too_large" : "failed",
					manifest.error.message,
					[],
					manifest.error,
				);
			if (options.workspace?.maxBytes !== undefined && manifest.value.bytes > options.workspace.maxBytes) {
				return skip(
					"too_large",
					`the workspace holds ${manifest.value.bytes} bytes, the limit is ${options.workspace.maxBytes}`,
				);
			}
			// The box made the listing: a path outside the tree, or through a link, is never kept.
			const problem = treeProblem(manifest.value);
			if (problem !== undefined) return skip("failed", `the box listed a tree the host does not keep: ${problem}`);
			if (over()) return timedOut("the files were listed");
			// What moves: each file the listing says changed (also one whose mode or time changed with the same content),
			// and each whose content the vault does not hold. A content moves once.
			const changed = new Set(changedEntries(previous?.manifest, manifest.value).map((entry) => entry.path));
			const wanted: WantedContent[] = [];
			const moving = new Set<string>();
			for (const entry of manifest.value.entries) {
				if (entry.kind !== "file" || entry.sha256 === undefined || moving.has(entry.sha256)) continue;
				if (changed.has(entry.path) || !(await vault.holds(session, entry.sha256, entry.bytes, context))) {
					moving.add(entry.sha256);
					wanted.push({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes });
				}
			}
			if (options.maxPullBytes !== undefined) {
				const delta = wanted.reduce((sum, entry) => sum + entry.bytes, 0);
				if (delta + held.value.seal.bytes > options.maxPullBytes) {
					return skip(
						"too_large",
						`this pull would move ${delta + held.value.seal.bytes} bytes (${delta} of files, ${held.value.seal.bytes} of store), the limit is ${options.maxPullBytes}`,
					);
				}
			}
			let excluded: Excluded | undefined;
			if ((options.workspace?.exclude?.length ?? 0) > 0) {
				const found = await excludedOf(place.box, place.workspace, calls(), context);
				if (!found.ok) return skip("failed", found.error.message, [], found.error);
				if (found.value.files > 0 || found.value.entries.length > 0) excluded = found.value;
			}
			const begun = await vault.begin(session, context);
			if (!begun.ok) return skip("failed", begun.error.message, [], begun.error);
			const pending = begun.value;
			const fail = async (error: Error, reason: SkipReason) => {
				await vault.discard(pending);
				return skip(reason, error.message, [], error);
			};
			if (over()) {
				await vault.discard(pending);
				return timedOut("the store was copied");
			}
			const file = await moveFile(
				place.box,
				held.value.path,
				vault.box,
				pending.storeFile,
				held.value.seal,
				{ stallMs: left(), deadlineMs: left() },
				context,
			);
			if (!file.ok) return fail(file.error, "failed");
			if (over()) {
				await vault.discard(pending);
				return timedOut("the files were pulled");
			}
			// The box sends the bytes of those files and nothing else: the vault keeps each under its SHA-256, and the
			// tree (directories, links, pipes, modes) is the record alone.
			const files = await pullContents(
				place.box,
				place.workspace,
				wanted,
				(sha256, size) => vault.keep(session, sha256, size, context),
				{ stallMs: left(), deadlineMs: left() },
				context,
			);
			if (!files.ok) return fail(files.error, files.error.code === "mismatch" ? "changed" : "failed");
			const recorded = await vault.commit(
				pending,
				{
					at,
					epoch: options.epoch,
					seal: held.value.seal,
					manifest: manifest.value,
					...(excluded === undefined ? {} : { excluded }),
				},
				context,
			);
			if (!recorded.ok) return fail(recorded.error, "failed");
			bytes = held.value.seal.bytes + files.value.bytes;
			return ok(recorded.value);
		})();
	} finally {
		await home.abandon(withoutAbortSignal(context));
	}
	const heldMs = Math.round(performance.now() - heldFrom);
	if (options.stats !== undefined) options.stats.longestHeldMs = Math.max(options.stats.longestHeldMs ?? 0, heldMs);
	if (!committed.ok) return committed;
	const keep = Math.max(1, options.keep ?? DEFAULT_KEEP);
	await vault.prune(session, keep, context);
	if (options.answers !== undefined) {
		for (let n = Math.max(1, committed.value.n - keep + 1); n <= committed.value.n; n++) {
			const oldest = await vault.get(session, n, context);
			if (oldest.ok && oldest.value !== undefined) {
				options.answers.covered(oldest.value.seal.head);
				break;
			}
		}
	}
	if (options.stats !== undefined) {
		options.stats.taken += 1;
		options.stats.last = { n: committed.value.n, at, ms: Math.round(performance.now() - started), bytes, heldMs };
	}
	if (options.crossing !== undefined) {
		try {
			await options.crossing("transport.checkpoint.taken", {
				session,
				epoch: options.epoch,
				box: place.box.id,
				n: options.crossingCount?.("transport.checkpoint.taken") ?? options.stats?.taken ?? 1,
			});
		} catch (cause) {
			return skip(
				"failed",
				`the crossing handler failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				[],
				cause,
			);
		}
	}
	return ok(committed.value);
}

/**
 * What a session is told once it was restored from the host's log alone: no checkpoint existed, the history is whole, no
 * file of the lost machine came back, and the calls the host saw are named.
 */
function restoreFromLogNotice(
	calls: readonly CallRecord[],
	replayed?: { readonly from: number; readonly to: number; readonly count: number },
): string {
	const names = (list: readonly CallRecord[]) => [...new Set(list.map((call) => call.tool))].join(", ");
	const again = calls.filter((call) => call.replay === "safe");
	const maybe = calls.filter((call) => call.replay !== "safe");
	const lines = [
		"System notice: this session was restored after its machine was lost. No checkpoint existed: your history was rebuilt from the host's log, and no file of the lost machine came back (the workspace is empty). Effects outside the machine (a push, an API call, a message) may or may not have happened: check before you repeat one. Programs that were running did not come along.",
	];
	if (replayed !== undefined) {
		lines.push(
			`The log held ${replayed.count} commit${replayed.count === 1 ? "" : "s"} (${replayed.from} to ${replayed.to}), with the calls they admitted.`,
		);
	}
	if (calls.length > 0) {
		lines.push(
			`The host saw ${calls.length} tool call${calls.length === 1 ? "" : "s"} begin.${
				maybe.length > 0 ? ` These may have had an effect that is not repeated for you: ${names(maybe)}.` : ""
			}${again.length > 0 ? ` These are safe to run again: ${names(again)}.` : ""}`,
		);
	}
	return lines.join(" ");
}

/**
 * What a session is told once it was restored from a checkpoint after its machine was lost. It says when the
 * checkpoint was taken, and which tool calls the host saw begin after it: a call that may run again, and one that must
 * not be assumed not to have happened.
 */
export function restoreNotice(
	checkpoint: Pick<Checkpoint, "at" | "excluded"> | undefined,
	calls: readonly CallRecord[],
	replayed?: { readonly from: number; readonly to: number; readonly count: number },
): string {
	if (checkpoint === undefined) return restoreFromLogNotice(calls, replayed);
	const since = calls.filter((call) => call.startedAt >= checkpoint.at);
	const when = new Date(checkpoint.at).toISOString();
	const names = (list: readonly CallRecord[]) => [...new Set(list.map((call) => call.tool))].join(", ");
	const again = since.filter((call) => call.replay === "safe");
	const maybe = since.filter((call) => call.replay !== "safe");
	const lines = [
		`System notice: this session was restored from a checkpoint taken at ${when}, after its machine was lost.`,
		"Files changed and commands run after that time did not survive. Effects outside the machine (a push, an API call, a message) may or may not have happened: check before you repeat one. Programs that were running did not come along.",
	];
	if (replayed !== undefined) {
		lines.push(
			`The host's log brought your history up to date: ${replayed.count} commit${replayed.count === 1 ? "" : "s"} made after the checkpoint (${replayed.from} to ${replayed.to}) were kept, with the calls they admitted. The files those calls changed did not survive.`,
		);
	}
	if (since.length > 0) {
		lines.push(
			`After that checkpoint the host saw ${since.length} tool call${since.length === 1 ? "" : "s"} begin.${
				maybe.length > 0 ? ` These may have had an effect that is not repeated for you: ${names(maybe)}.` : ""
			}${again.length > 0 ? ` These are safe to run again: ${names(again)}.` : ""}`,
		);
	}
	const left = checkpoint.excluded;
	if (left !== undefined && left.entries.length > 0) {
		const more = left.more > 0 ? `, and ${left.more} more` : "";
		lines.push(
			`Not restored: ${left.entries.join(", ")}${more} (${left.files} file${left.files === 1 ? "" : "s"}, ${left.bytes} bytes) are left out of checkpoints. Fetch them again if you need them.`,
		);
	}
	return lines.join(" ");
}

/**
 * The record sink of a session whose commits a host keeps beside its checkpoints: `held` is where the vault's log is
 * (the runner sends from the commit after it), and `append` keeps a commit's writes on disk before it settles, so that
 * the runner's acknowledgement means the host holds it. The recorder's lines are not the vault's: a host that records
 * passes `lines`, the sink that keeps them, with how far it holds them.
 */
export function recordSink(
	vault: CheckpointVault,
	session: string,
	context: Context,
	recorder?: Pick<RecordSink, "lines"> & { held(): number },
): RecordSink {
	return {
		held: () => {
			const after = vault.through(session);
			return { after, linesAfter: recorder === undefined ? after : recorder.held() };
		},
		async append(commit, writes) {
			const kept = await vault.appendLog(session, [{ commit, writes }], context);
			if (!kept.ok) throw kept.error;
		},
		lines: (commit, lines, snapshot) =>
			recorder === undefined ? Promise.resolve() : recorder.lines(commit, lines, snapshot),
	};
}
