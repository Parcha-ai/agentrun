import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import {
	type Box,
	BoxError,
	type BoxErrorCode,
	type BoxExecOptions,
	type BoxFacts,
	type BoxFile,
	type BoxProcess,
	type BoxProvider,
	type BoxRef,
	type BoxSpec,
	type BoxStatus,
	isReservedLabel,
} from "./box.ts";

/** What one Archil `exec` call is allowed to run, as the service states it: a call is cut at 300 s. */
const MAX_EXEC_MS = 300_000;
/** The deadline a command gets inside the container when the caller names none: under the platform's cut. */
const DEFAULT_EXEC_MS = 295_000;
/** How much later than the command's own deadline the host gives up on a call that never answers. */
const CALL_GRACE_MS = 15_000;
/** What one call's container offers, as measured: 2 vCPU, 3938 MiB. */
const CPUS = 2;
const MEMORY_MB = 3_938;
const DEFAULT_QUEUE_MS = 60_000;
const DEFAULT_DESTROY_WAIT_MS = 5_000;
const DEFAULT_ROOT = "boxes";
const DEFAULT_MOUNT = "work";
/** The records of a root `boxes` are files of `boxes.records/`: outside every directory a command can hold, so a box can be ended while one runs. */
const RECORDS_SUFFIX = ".records";
const META_FORMAT = "pi-transport.archil-exec/1";
/** What `cd` into a box directory that is gone prints and exits with, so no program's own exit code reads as `gone`. */
const GONE_MARK = "pi-transport: box directory is gone";
const EXIT_GONE = 253;
/** What `timeout` exits with when it ended the command at its deadline. */
const EXIT_TIMEOUT = 124;
const ID_PATTERN = /^ax-[0-9a-f]{12}$/;
/** What `list` prints in front of a box directory that has no record: left by a box ended while a command held it. */
const ORPHAN_MARK = "orphan:";

/** The part of an Archil disk this package calls: its id and the object API, with keys relative to the disk's root. */
export interface ArchilExecDisk {
	readonly id: string;
	getObject(key: string): Promise<Uint8Array>;
	putObject(key: string, body: string | Uint8Array, options?: { readonly mode?: number }): Promise<unknown>;
	deleteObject(key: string): Promise<void>;
}

/** One disk mounted for a call, at `/mnt/archil/<key of the map it is in>`. */
export interface ArchilExecMount {
	readonly disk: string;
	/** Paths, relative to the disk's root, checked out for the call: a second client that wants one waits `queueMs`. */
	readonly checkoutPaths?: string[];
	readonly queueMs?: number;
	readonly readOnly?: boolean;
}

/** What one exec answers: the command's text output and exit code, after it ended. */
export interface ArchilExecResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

/**
 * The part of the Archil SDK's `Archil` client this package calls (`new Archil({ apiKey, region })` from the `disk`
 * package, which the host installs: this package imports nothing from it). `exec` runs one shell command in a fresh
 * container with the named disks mounted under `/mnt/archil/<key>`.
 */
export interface ArchilExecClient {
	exec(options: {
		readonly disks: Record<string, ArchilExecMount>;
		readonly command: string;
	}): Promise<ArchilExecResult>;
}

export type ArchilExecBoxesOptions = {
	readonly client: ArchilExecClient;
	/** The agent's WORK disk. Never the disk of its store. */
	readonly disk: ArchilExecDisk;
	/** The directory of the disk that holds the boxes, one directory each. Default `boxes`. */
	readonly root?: string;
	/** The name the disk is mounted under in a call (`/mnt/archil/<mount>`). Default `work`. */
	readonly mount?: string;
	/**
	 * How long an exec waits for the box's directory when another process holds it, in ms. A second process that
	 * attached the same box waits this long and then fails, instead of being refused at once. Default 60 000.
	 */
	readonly queueMs?: number;
	/**
	 * How long a `destroy`, and a sweep of a directory without a record, wait for commands that hold boxes to end before
	 * they give up on removing the directory, in ms. Removing a directory needs its parent checked out (a directory
	 * cannot be removed while it is itself checked out), and a held box under it makes that wait. Default 5000.
	 */
	readonly destroyWaitMs?: number;
};

type BoxRecord = {
	readonly format: typeof META_FORMAT;
	readonly id: string;
	readonly facts: BoxFacts;
	readonly labels: Readonly<Record<string, string>>;
	readonly env: Readonly<Record<string, string>>;
	readonly expiresAt: number;
};

/** `text` in single quotes, for a shell. */
function quote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

function statusOf(cause: unknown): number | undefined {
	const status = (cause as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

function describe(what: string, cause: unknown): string {
	const name = (cause as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
	const text = cause instanceof Error ? cause.message : String(cause);
	return `${what}: ${name === "" ? "" : `${name}: `}${text}`.replace(/\s+/g, " ").slice(0, 300);
}

/** An SDK failure as a box error. A call the platform cut (the SDK reports `fetch failed`) is a timeout. */
function failure(what: string, cause: unknown): BoxError {
	const status = statusOf(cause);
	let code: BoxErrorCode = "unknown";
	if (status === 401 || status === 403) code = "unauthorized";
	else if (status === 404) code = "gone";
	else if (status === 429) code = "capacity";
	else if (status === undefined && cause instanceof Error && /fetch failed|timed? ?out/i.test(cause.message)) {
		code = "timeout";
	}
	return new BoxError(code, describe(what, cause), cause);
}

function notFound(cause: unknown): boolean {
	return statusOf(cause) === 404;
}

function parseRecord(text: string): BoxRecord | undefined {
	try {
		const value = JSON.parse(text) as Partial<BoxRecord> | null;
		if (value === null || typeof value !== "object" || value.format !== META_FORMAT) return undefined;
		if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return undefined;
		if (typeof value.expiresAt !== "number" || value.facts === undefined || value.facts.provider !== "archil-exec") {
			return undefined;
		}
		return value as BoxRecord;
	} catch {
		return undefined;
	}
}

type Settled = { readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly code: number };

/** What `archilExecBoxes` needs from the provider, shared by every box. */
type Shared = {
	readonly client: ArchilExecClient;
	readonly disk: ArchilExecDisk;
	readonly root: string;
	readonly mount: string;
	readonly queueMs: number;
	readonly destroyWaitMs: number;
};

const recordsOf = (shared: Pick<Shared, "root">) => `${shared.root}${RECORDS_SUFFIX}`;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `call`, again while the service answers 409: another client holds a write delegation of the path, for the length of its command. */
async function settle<T>(shared: Shared, call: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + shared.queueMs;
	for (;;) {
		try {
			return await call();
		} catch (cause) {
			if (statusOf(cause) !== 409 || Date.now() >= deadline) throw cause;
			await pause(200);
		}
	}
}

const encoder = new TextEncoder();

/** One command in a box's local queue: `began` settles when its request is on its way or it was skipped. */
type Entry = { cancelled: boolean; started: () => void; readonly began: Promise<void> };

function newEntry(): Entry {
	let started: () => void = () => {};
	const began = new Promise<void>((resolve) => {
		started = resolve;
	});
	return { cancelled: false, started, began };
}

/**
 * A box that is one directory of the agent's work disk. Every `exec` is one Archil `exec` call.
 * Limits, all stated in the facts or refused with a typed error: a call is cut at 300 s (`maxExecMs`; a longer
 * `timeoutMs` is `invalid`), a command's output arrives after it ended and as text (bytes that are not UTF-8 are
 * replaced; use `download` for bytes), stdin is `unsupported`, and no program keeps running between calls
 * (`liveProcesses` is false), so a box like this is never a home.
 */
class ArchilExecBox implements Box {
	readonly id: string;
	readonly #shared: Shared;
	readonly #record: BoxRecord;
	#tail: Promise<unknown> = Promise.resolve();
	#ended = false;

	constructor(shared: Shared, record: BoxRecord) {
		this.#shared = shared;
		this.#record = record;
		this.id = record.id;
	}

	get #key(): string {
		return `${this.#shared.root}/${this.id}`;
	}

	get #recordKey(): string {
		return `${recordsOf(this.#shared)}/${this.id}.json`;
	}

	facts(): BoxFacts {
		return this.#record.facts;
	}

	#expired(): boolean {
		return Date.now() >= this.#record.expiresAt;
	}

	/** Whether the box still exists: not destroyed here, not past its lifetime. A box past it is removed. */
	async #alive(): Promise<boolean> {
		if (this.#ended) return false;
		if (this.#expired()) {
			this.#ended = true;
			await settle(this.#shared, () => this.#shared.disk.deleteObject(this.#recordKey)).catch(() => {});
			await this.#remove().catch(() => {});
			return false;
		}
		return true;
	}

	/** Whether the box's record is still there: the box is gone for every client when it is not. */
	async #recorded(): Promise<Result<void, BoxError>> {
		try {
			await this.#shared.disk.getObject(this.#recordKey);
			return ok(undefined);
		} catch (cause) {
			if (!notFound(cause)) return err(failure(`could not read the state of box ${this.id}`, cause));
			this.#ended = true;
			return err(new BoxError("gone", `box ${this.id} has ended`));
		}
	}

	/** One call with the box's directory checked out, after every call this process already asked for. */
	#call(command: string, context: Context, entry: Entry): Promise<Result<Settled, BoxError>> {
		const run = async (): Promise<Result<Settled, BoxError>> => {
			// A command whose caller gave up while it waited its turn is never sent: it would run after the caller retried it.
			if (entry.cancelled || context.abortSignal?.aborted) {
				entry.cancelled = true;
				entry.started();
				return err(new BoxError("aborted", "the call was given up before it started"));
			}
			// A box destroyed while the command waited has its receipt closed: sending it now would bill a call no receipt counts.
			if (this.#ended) {
				entry.cancelled = true;
				entry.started();
				return err(new BoxError("gone", `box ${this.id} has ended`));
			}
			entry.started();
			try {
				const result = await this.#shared.client.exec({
					disks: {
						[this.#shared.mount]: {
							disk: this.#shared.disk.id,
							checkoutPaths: [this.#key],
							queueMs: this.#shared.queueMs,
						},
					},
					command,
				});
				return ok({
					stdout: encoder.encode(result.stdout),
					stderr: encoder.encode(result.stderr),
					code: result.exitCode,
				});
			} catch (cause) {
				return err(failure("the call to Archil failed", cause));
			}
		};
		const turn = this.#tail.then(run, run);
		this.#tail = turn;
		return turn;
	}

	async exec(
		command: readonly string[],
		options: BoxExecOptions | undefined,
		context: Context,
	): Promise<Result<BoxProcess, BoxError>> {
		if (command.length === 0) return err(new BoxError("invalid", "the command is empty"));
		if (command[0]?.includes("=")) {
			return err(new BoxError("invalid", "the program's name has an = in it: a shell would read it as a setting"));
		}
		const timeoutMs = options?.timeoutMs;
		if (timeoutMs !== undefined && !(timeoutMs > 0))
			return err(new BoxError("invalid", "timeoutMs must be positive"));
		if (timeoutMs !== undefined && timeoutMs > MAX_EXEC_MS) {
			return err(
				new BoxError(
					"invalid",
					`an Archil exec is cut at ${MAX_EXEC_MS} ms: ${timeoutMs} ms is more than a call may run`,
				),
			);
		}
		if (!(await this.#alive())) return err(new BoxError("gone", `box ${this.id} has ended`));
		const seconds = (timeoutMs ?? DEFAULT_EXEC_MS) / 1000;
		const env = Object.entries(this.#record.env).map(([name, value]) => `${name}=${quote(value)}`);
		const line = [
			// The box is gone when its record is, whatever is left of its directory.
			`[ -f ${quote(`/mnt/archil/${this.#shared.mount}/${this.#recordKey}`)} ] && cd ${quote(this.#record.facts.workspace)} 2>/dev/null || { echo ${quote(GONE_MARK)} >&2; exit ${EXIT_GONE}; }`,
			// `env --` first: a program whose name starts with a dash is a name, never an option of timeout or env.
			`exec timeout -k 1 ${seconds} env -- ${env.length === 0 ? "" : `${env.join(" ")} `}${command.map(quote).join(" ")}`,
		].join("; ");
		// The call is accepted once its request is on its way: a caller that gives up while it waits behind this process's
		// earlier commands (aborts, or passes its own deadline) has run nothing and is billed nothing.
		const entry = newEntry();
		const done = this.#call(line, context, entry);
		const signal = context.abortSignal;
		let release: () => void = () => {};
		const gaveUp = new Promise<BoxError>((resolve) => {
			const onAbort = () => resolve(new BoxError("aborted", "the call was aborted"));
			const timer =
				timeoutMs === undefined
					? undefined
					: setTimeout(
							() => resolve(new BoxError("timeout", `the command did not start in ${timeoutMs} ms`)),
							timeoutMs,
						);
			release = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		const first = await Promise.race([entry.began.then(() => undefined), gaveUp]);
		release();
		if (first !== undefined) {
			entry.cancelled = true;
			return err(first);
		}
		if (entry.cancelled) {
			if (this.#ended) return err(new BoxError("gone", `box ${this.id} has ended`));
			return err(new BoxError("aborted", "the call was given up before it started"));
		}
		return ok(this.#process(done, timeoutMs, context));
	}

	#process(done: Promise<Result<Settled, BoxError>>, timeoutMs: number | undefined, context: Context): BoxProcess {
		const signal = context.abortSignal;
		const settled = new Promise<Result<Settled, BoxError>>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const onAbort = () => finish(err(new BoxError("aborted", "the call was aborted")));
			const finish = (result: Result<Settled, BoxError>) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			// The platform answers after the command's own deadline; a call that never answers is given up on a little after.
			if (timeoutMs !== undefined) {
				timer = setTimeout(
					() => finish(err(new BoxError("timeout", `the command did not end in ${timeoutMs} ms`))),
					timeoutMs + CALL_GRACE_MS,
				);
			}
			void done.then(finish);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		const outcome = settled.then((result): Result<Settled, BoxError> => {
			if (!result.ok) return result;
			const { code, stderr } = result.value;
			if (code === EXIT_GONE && new TextDecoder().decode(stderr).includes(GONE_MARK)) {
				this.#ended = true;
				return err(new BoxError("gone", `box ${this.id} has ended`));
			}
			// `timeout` exits 124 when it ended the command: the caller's deadline, or the 295 s every command has.
			if (code === EXIT_TIMEOUT) {
				return err(new BoxError("timeout", `the command did not end in ${timeoutMs ?? DEFAULT_EXEC_MS} ms`));
			}
			return result;
		});
		const stream = (pick: "stdout" | "stderr"): AsyncIterable<Uint8Array> => ({
			async *[Symbol.asyncIterator]() {
				const result = await outcome;
				if (result.ok && result.value[pick].length > 0) yield result.value[pick];
			},
		});
		return {
			stdin: {
				write: () => Promise.reject(new BoxError("unsupported", "an Archil exec takes no stdin")),
				close: async () => {},
			},
			stdout: stream("stdout"),
			stderr: stream("stderr"),
			wait: async () => {
				const result = await outcome;
				return result.ok ? ok(result.value.code) : result;
			},
		};
	}

	/** A path in the box as a key on the disk: relative to the workspace, or absolute inside it, never above it. */
	#keyOf(path: string): Result<string, BoxError> {
		const workspace = this.#record.facts.workspace;
		const relative = path.startsWith("/")
			? path.startsWith(`${workspace}/`)
				? path.slice(workspace.length + 1)
				: undefined
			: path;
		const segments = relative?.split("/").filter((part) => part !== "" && part !== ".");
		if (relative === undefined || segments === undefined || segments.length === 0 || segments.includes("..")) {
			return err(new BoxError("invalid", `${path} is not a file inside the box's workspace`));
		}
		return ok(`${this.#key}/${segments.join("/")}`);
	}

	async upload(files: readonly BoxFile[], context: Context): Promise<Result<void, BoxError>> {
		if (!(await this.#alive())) return err(new BoxError("gone", `box ${this.id} has ended`));
		const keyed: { key: string; file: BoxFile }[] = [];
		for (const file of files) {
			const key = this.#keyOf(file.path);
			if (!key.ok) return key;
			keyed.push({ key: key.value, file });
		}
		// After the commands this process already asked for: a write to a directory a command holds is refused by the service.
		const turn = this.#tail.then(async (): Promise<Result<void, BoxError>> => {
			// Checked when its turn comes: another client may have ended the box while this waited, and a write would
			// recreate the directory only for the next list to remove it.
			// A caller that gave up while this waited behind a command is not served late: its write would change a file it already stopped waiting for.
			if (context.abortSignal?.aborted)
				return err(new BoxError("aborted", "the call was given up before it started"));
			const recorded = await this.#recorded();
			if (!recorded.ok) return recorded;
			for (const { key, file } of keyed) {
				try {
					await settle(this.#shared, () =>
						this.#shared.disk.putObject(
							key,
							file.bytes,
							file.mode === undefined ? undefined : { mode: file.mode },
						),
					);
				} catch (cause) {
					return err(failure(`could not write ${file.path}`, cause));
				}
			}
			return ok(undefined);
		});
		this.#tail = turn;
		return turn;
	}

	async download(paths: readonly string[], context: Context): Promise<Result<readonly BoxFile[], BoxError>> {
		if (!(await this.#alive())) return err(new BoxError("gone", `box ${this.id} has ended`));
		const keyed: { path: string; key: string }[] = [];
		for (const path of paths) {
			const key = this.#keyOf(path);
			if (!key.ok) return key;
			keyed.push({ path, key: key.value });
		}
		// After the commands this process already asked for, as `upload`: what they wrote is what a read returns.
		const turn = this.#tail.then(async (): Promise<Result<readonly BoxFile[], BoxError>> => {
			if (context.abortSignal?.aborted)
				return err(new BoxError("aborted", "the call was given up before it started"));
			const recorded = await this.#recorded();
			if (!recorded.ok) return recorded;
			const files: BoxFile[] = [];
			for (const { path, key } of keyed) {
				try {
					files.push({ path, bytes: await this.#shared.disk.getObject(key) });
				} catch (cause) {
					if (notFound(cause)) return err(new BoxError("not_found", `${path} does not exist`, cause));
					return err(failure(`could not read ${path}`, cause));
				}
			}
			return ok(files);
		});
		this.#tail = turn;
		return turn;
	}

	async status(): Promise<Result<BoxStatus, BoxError>> {
		if (!(await this.#alive())) return ok({ state: "ended", exitCode: null });
		try {
			await this.#shared.disk.getObject(this.#recordKey);
		} catch (cause) {
			if (notFound(cause)) {
				this.#ended = true;
				return ok({ state: "ended", exitCode: null });
			}
			return err(failure(`could not read the state of box ${this.id}`, cause));
		}
		return ok({ state: "running" });
	}

	/** Remove the directory: through its parent, which is checked out for the call (the directory itself cannot be removed while it is). */
	async #remove(): Promise<void> {
		const result = await this.#shared.client.exec({
			disks: {
				[this.#shared.mount]: {
					disk: this.#shared.disk.id,
					checkoutPaths: [this.#shared.root],
					queueMs: this.#shared.destroyWaitMs,
				},
			},
			command: `rm -rf -- ${quote(this.#record.facts.workspace)}`,
		});
		if (result.exitCode !== 0) throw new Error(`rm exited ${result.exitCode}: ${result.stderr.trim()}`);
	}

	/**
	 * The box ends for every client the moment its record is gone, whatever still runs in it. Its directory goes with it
	 * when no command holds it; a directory a running command held is removed by the next `list`, which sweeps every
	 * directory that has no record.
	 */
	async destroy(): Promise<Result<void, BoxError>> {
		if (this.#ended) return ok(undefined);
		try {
			await settle(this.#shared, () => this.#shared.disk.deleteObject(this.#recordKey));
		} catch (cause) {
			if (!notFound(cause)) return err(failure(`could not end box ${this.id}`, cause));
		}
		this.#ended = true;
		await this.#remove().catch(() => {});
		return ok(undefined);
	}
}

/**
 * Boxes that are directories of an agent's Archil work disk, run by Archil's serverless `exec`: one request per
 * command, in a fresh container with the disk mounted, answering when the command ends. A box has no machine of its
 * own and keeps no program running between calls (`facts().liveProcesses` is false), so it fits tool calls and never a
 * home; the box place refuses it with `no_live_processes`.
 *
 * The box is the directory `<root>/<id>/` of the disk. Its labels, env, facts and end time are the file
 * `<root>.records/<id>.json`, outside every directory a command can hold, so `attach` and `list` find the box after a restart
 * and a box can be ended while a command still runs in it. Archil has no timer that ends a directory: a box past its
 * `maxLifetimeMs` is ended, and its directory removed, by the first call that looks at it (`attach`, `list`, `exec`,
 * `status`, `upload`, `download`). Every `exec` checks out the box's directory with a queue, so two processes that
 * attached the same box run one command at a time and neither loses a write; this process also orders its own calls.
 * Files go through the object API, which takes no checkout: write a box's files from one process at a time.
 * Refused before any call: a GPU, a snapshot, a `workspace`, an isolation other than `vm`, more than 2 vCPU or 3938 MiB,
 * a label key in the providers' namespace, an env name that is not a shell name, and a lifetime that is not positive.
 */
export function archilExecBoxes(options: ArchilExecBoxesOptions): BoxProvider {
	const safe = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
	for (const [name, value] of [
		["root", options.root ?? DEFAULT_ROOT],
		["mount", options.mount ?? DEFAULT_MOUNT],
	] as const) {
		if (!safe.test(value) || value.split("/").includes(".."))
			throw new Error(`archilExecBoxes: ${name} ${value} is not a plain path`);
	}
	if (options.mount?.includes("/")) throw new Error("archilExecBoxes: mount is one name, not a path");
	const shared: Shared = {
		client: options.client,
		disk: options.disk,
		root: options.root ?? DEFAULT_ROOT,
		mount: options.mount ?? DEFAULT_MOUNT,
		queueMs: options.queueMs ?? DEFAULT_QUEUE_MS,
		destroyWaitMs: options.destroyWaitMs ?? DEFAULT_DESTROY_WAIT_MS,
	};
	const keyOf = (id: string) => `${shared.root}/${id}`;
	const recordKeyOf = (id: string) => `${recordsOf(shared)}/${id}.json`;
	const readRecord = async (id: string): Promise<Result<BoxRecord | undefined, BoxError>> => {
		try {
			const bytes = await shared.disk.getObject(recordKeyOf(id));
			return ok(parseRecord(new TextDecoder().decode(bytes)));
		} catch (cause) {
			if (notFound(cause)) return ok(undefined);
			return err(failure(`could not look up box ${id}`, cause));
		}
	};
	const sweepDirectory = async (directory: string): Promise<void> => {
		await shared.client
			.exec({
				disks: {
					[shared.mount]: { disk: shared.disk.id, checkoutPaths: [shared.root], queueMs: shared.destroyWaitMs },
				},
				command: `rm -rf -- ${quote(directory)}`,
			})
			.catch(() => {});
	};
	const sweep = async (record: BoxRecord): Promise<void> => {
		// The record goes first: an expired box that keeps its record is swept, and paid for, by every later list.
		await settle(shared, () => shared.disk.deleteObject(recordKeyOf(record.id))).catch(() => {});
		await sweepDirectory(record.facts.workspace);
	};

	return {
		name: "archil-exec",

		async create(spec: BoxSpec, context: Context): Promise<Result<Box, BoxError>> {
			if (!(spec.maxLifetimeMs > 0)) return err(new BoxError("invalid", "maxLifetimeMs must be positive"));
			const reserved = Object.keys(spec.labels ?? {}).find(isReservedLabel);
			if (reserved !== undefined) {
				return err(new BoxError("invalid", `the label ${reserved} is in the providers' own namespace`));
			}
			for (const name of Object.keys(spec.env ?? {})) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
					return err(new BoxError("invalid", `the env name ${name} is not a shell name`));
				}
			}
			if (spec.gpu !== undefined) return err(new BoxError("unsupported", "an Archil exec has no GPU"));
			if (spec.snapshot !== undefined) return err(new BoxError("unsupported", "an archil-exec box starts empty"));
			if (spec.workspace !== undefined) {
				return err(
					new BoxError("unsupported", "the workspace of an archil-exec box is its directory on the work disk"),
				);
			}
			if (spec.isolation !== undefined && spec.isolation !== "vm") {
				return err(new BoxError("unsupported", `an archil-exec box is a vm, the spec asks for ${spec.isolation}`));
			}
			if ((spec.cpus ?? 0) > CPUS || (spec.memoryMb ?? 0) > MEMORY_MB) {
				return err(new BoxError("unsupported", `an Archil exec container has ${CPUS} vCPU and ${MEMORY_MB} MiB`));
			}
			if (context.abortSignal?.aborted) return err(new BoxError("aborted", "the call was aborted"));
			const id = `ax-${randomBytes(6).toString("hex")}`;
			const facts: BoxFacts = {
				provider: "archil-exec",
				isolation: "vm",
				cpus: CPUS,
				memoryMb: MEMORY_MB,
				gpu: null,
				workspace: `/mnt/archil/${shared.mount}/${keyOf(id)}`,
				maxLifetimeMs: spec.maxLifetimeMs,
				snapshot: null,
				bulk: "files",
				maxExecMs: MAX_EXEC_MS,
				liveProcesses: false,
			};
			const record: BoxRecord = {
				format: META_FORMAT,
				id,
				facts,
				labels: { ...spec.labels },
				env: { ...spec.env },
				expiresAt: Date.now() + spec.maxLifetimeMs,
			};
			try {
				await shared.disk.putObject(recordKeyOf(id), JSON.stringify(record));
				// The directory is a marker object; the service refuses it for a moment while a removal holds the parent.
				await settle(shared, () => shared.disk.putObject(`${keyOf(id)}/`, ""));
			} catch (cause) {
				await shared.disk.deleteObject(recordKeyOf(id)).catch(() => {});
				return err(failure("could not make a box directory", cause));
			}
			return ok(new ArchilExecBox(shared, record));
		},

		async attach(id: string, _context: Context): Promise<Result<Box | undefined, BoxError>> {
			if (!ID_PATTERN.test(id)) return ok(undefined);
			const read = await readRecord(id);
			if (!read.ok || read.value === undefined) return read.ok ? ok(undefined) : read;
			if (Date.now() >= read.value.expiresAt) {
				await sweep(read.value);
				return ok(undefined);
			}
			return ok(new ArchilExecBox(shared, read.value));
		},

		async list(labels, _context: Context): Promise<Result<readonly BoxRef[], BoxError>> {
			const base = `/mnt/archil/${shared.mount}/${shared.root}`;
			const records = `/mnt/archil/${shared.mount}/${recordsOf(shared)}`;
			let listed: ArchilExecResult;
			try {
				listed = await shared.client.exec({
					disks: { [shared.mount]: { disk: shared.disk.id, readOnly: true } },
					command: `for f in ${records}/ax-*.json; do [ -f "$f" ] && { cat "$f"; echo; }; done; for d in ${base}/ax-*; do [ -d "$d" ] && [ ! -f "${records}/$(basename "$d").json" ] && echo "${ORPHAN_MARK}$d"; done; true`,
				});
			} catch (cause) {
				return err(failure("could not list boxes", cause));
			}
			const refs: BoxRef[] = [];
			for (const text of listed.stdout.split("\n")) {
				if (text.startsWith(ORPHAN_MARK)) {
					const directory = text.slice(ORPHAN_MARK.length).trim();
					if (directory.startsWith(`${base}/ax-`)) await sweepDirectory(directory);
					continue;
				}
				const record = text.trim() === "" ? undefined : parseRecord(text);
				if (record === undefined) continue;
				if (Date.now() >= record.expiresAt) {
					await sweep(record);
					continue;
				}
				if (Object.entries(labels).every(([key, value]) => record.labels[key] === value)) {
					refs.push({ id: record.id, labels: record.labels });
				}
			}
			return ok(refs);
		},
	};
}
