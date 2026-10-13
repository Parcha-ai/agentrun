import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import {
	type Box,
	BoxError,
	type BoxExecOptions,
	type BoxFacts,
	type BoxFile,
	type BoxProcess,
	type BoxProvider,
	type BoxRef,
	type BoxSpec,
	type BoxStatus,
} from "./box.ts";
import { adaptChild } from "./child.ts";

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const RECORD_FILE = "box.json";
/** Every program of a box carries `PI_TRANSPORT_BOX=<box id>` in its environment, and so does what it starts. */
const BOX_MARKER = "PI_TRANSPORT_BOX";
/** The watchdog of a box carries this instead, so ending the box's programs never ends the watchdog first. */
const WATCHDOG_MARKER = "PI_TRANSPORT_WATCHDOG";
const KILL_ROUNDS = 5;
/** Labels with this prefix belong to providers. */
const RESERVED_LABEL_PREFIX = "pi-transport.";
/** Whether this system shows a process's environment under `/proc`, which is how a box's programs are found. */
const HAS_PROC = existsSync("/proc/self/environ");

/**
 * Runs detached from the host and ends the box when its lifetime has passed: `$1` seconds, `$2` the box's directory,
 * `$3` the marker its programs carry. A box that was destroyed first has no record left, and the script does nothing.
 */
const WATCHDOG_SCRIPT = `sleep "$1" || exit 0
[ -f "$2/${RECORD_FILE}" ] || exit 0
rm -f -- "$2/${RECORD_FILE}"
round=0
while [ "$round" -lt ${KILL_ROUNDS} ]; do
	round=$((round + 1))
	found=$(grep -l -a -z -F -x -e "$3" /proc/[0-9]*/environ 2>/dev/null)
	[ -n "$found" ] || break
	for environ in $found; do
		pid=\${environ#/proc/}
		kill -KILL "\${pid%/environ}" 2>/dev/null
	done
done
rm -rf -- "$2"`;

export type LocalBoxesOptions = {
	/** Directory that holds one subdirectory per box. Created when absent. */
	readonly root: string;
	/**
	 * The `PATH` of programs in a box. Default `/usr/local/bin:/usr/bin:/bin`. This process's own `PATH` is never used
	 * unless the host passes it here.
	 */
	readonly path?: string;
};

type LocalRecord = {
	readonly id: string;
	/** Inside the box's directory, or a directory the caller named, which `destroy` leaves in place. */
	readonly workspace: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly env: Readonly<Record<string, string>>;
	readonly path: string;
	readonly maxLifetimeMs: number;
	readonly expiresAt: number;
};

/** Process groups this process started, by box, for systems where `/proc` cannot find a box's programs. */
const startedHere = new Map<string, Set<number>>();

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * A box that is a directory on this machine. Invariant: a program started in it never receives this process's
 * environment, only the provider's `PATH`, a private `HOME` and `TMPDIR`, the spec's `env` and the box's marker.
 */
class LocalBox implements Box {
	readonly id: string;
	readonly #directory: string;
	readonly #record: LocalRecord;

	constructor(directory: string, record: LocalRecord) {
		this.id = record.id;
		this.#directory = directory;
		this.#record = record;
	}

	facts(): BoxFacts {
		return {
			provider: "local",
			isolation: "none",
			cpus: availableParallelism(),
			memoryMb: Math.floor(totalmem() / (1024 * 1024)),
			gpu: null,
			workspace: this.#record.workspace,
			maxLifetimeMs: this.#record.maxLifetimeMs,
			snapshot: null,
		};
	}

	async exec(
		command: readonly string[],
		options: BoxExecOptions | undefined,
		context: Context,
	): Promise<Result<BoxProcess, BoxError>> {
		const [program, ...args] = command;
		if (program === undefined) return err(new BoxError("invalid", "the command is empty"));
		if (!(await this.#live())) return err(new BoxError("gone", `box ${this.id} has ended`));
		const child = spawn(program, args, {
			cwd: this.#record.workspace,
			env: {
				PATH: this.#record.path,
				HOME: join(this.#directory, "home"),
				TMPDIR: join(this.#directory, "tmp"),
				...this.#record.env,
				[BOX_MARKER]: this.id,
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const pid = child.pid;
		if (pid !== undefined && !HAS_PROC) {
			const groups = startedHere.get(this.id) ?? new Set<number>();
			startedHere.set(this.id, groups.add(pid));
			child.once("close", () => groups.delete(pid));
		}
		return ok(adaptChild(child, () => killGroup(pid), options, context));
	}

	async upload(files: readonly BoxFile[], _context: Context): Promise<Result<void, BoxError>> {
		if (!(await this.#live())) return err(new BoxError("gone", `box ${this.id} has ended`));
		try {
			for (const file of files) {
				const path = this.#path(file.path);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, file.bytes);
				if (file.mode !== undefined) await chmod(path, file.mode);
			}
			return ok(undefined);
		} catch (error) {
			return err(new BoxError("unknown", `could not write: ${(error as Error).message}`, error));
		}
	}

	async download(paths: readonly string[], _context: Context): Promise<Result<readonly BoxFile[], BoxError>> {
		if (!(await this.#live())) return err(new BoxError("gone", `box ${this.id} has ended`));
		const files: BoxFile[] = [];
		for (const path of paths) {
			try {
				files.push({ path, bytes: new Uint8Array(await readFile(this.#path(path))) });
			} catch (error) {
				if (errorCode(error) === "ENOENT") return err(new BoxError("not_found", `${path} does not exist`));
				if (errorCode(error) === "EISDIR") return err(new BoxError("invalid", `${path} is a directory`));
				return err(new BoxError("unknown", `could not read ${path}: ${(error as Error).message}`, error));
			}
		}
		return ok(files);
	}

	async status(_context: Context): Promise<Result<BoxStatus, BoxError>> {
		return ok((await this.#live()) ? { state: "running" } : { state: "ended", exitCode: null });
	}

	async destroy(_context: Context): Promise<Result<void, BoxError>> {
		try {
			await destroyDirectory(this.#directory, this.id);
			return ok(undefined);
		} catch (error) {
			return err(new BoxError("unknown", `could not remove box ${this.id}: ${(error as Error).message}`, error));
		}
	}

	#path(path: string): string {
		return isAbsolute(path) ? path : join(this.#record.workspace, path);
	}

	async #live(): Promise<boolean> {
		return (await readRecord(this.#directory)) !== undefined && Date.now() < this.#record.expiresAt;
	}
}

function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The group already ended.
	}
}

/** Every process whose environment holds `entry`, a whole `NAME=value` pair. Empty where `/proc` cannot say. */
async function processesWith(entry: string): Promise<number[]> {
	const names = await readdir("/proc").catch(() => [] as string[]);
	const found: number[] = [];
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const environ = await readFile(`/proc/${name}/environ`, "utf8").catch(() => "");
		if (environ.split("\0").includes(entry)) found.push(Number(name));
	}
	return found;
}

/**
 * End every program of a box, also one that left its process group or outlived the program that started it: each is
 * found by the marker in its own environment, so a process id the system reused is never killed. Where `/proc` is
 * missing, only the process groups this process started are ended.
 */
async function endPrograms(id: string): Promise<void> {
	if (!HAS_PROC) {
		for (const pid of startedHere.get(id) ?? []) killGroup(pid);
		startedHere.delete(id);
		return;
	}
	// The watchdog goes first, so it cannot start to end a box that is being ended here.
	for (const entry of [`${WATCHDOG_MARKER}=${id}`, `${BOX_MARKER}=${id}`]) {
		for (let round = 0; round < KILL_ROUNDS; round += 1) {
			const pids = await processesWith(entry);
			if (pids.length === 0) break;
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// It ended between the scan and the kill.
				}
			}
		}
	}
}

async function readRecord(directory: string): Promise<LocalRecord | undefined> {
	try {
		return JSON.parse(await readFile(join(directory, RECORD_FILE), "utf8")) as LocalRecord;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
		throw error;
	}
}

/**
 * End a box: its record, its programs and its watchdog, then its own directory. A workspace the caller named lies
 * outside that directory and is never removed.
 */
async function destroyDirectory(directory: string, id: string): Promise<void> {
	// The record goes first: from then on every handle of this box reports it ended.
	await rm(join(directory, RECORD_FILE), { force: true });
	await endPrograms(id);
	await rm(directory, { recursive: true, force: true });
}

/** The first spec field a directory on this machine cannot honour, or `undefined`. */
function unsupportedField(spec: BoxSpec): string | undefined {
	const fields = ["image", "snapshot", "cpus", "memoryMb", "gpu", "region"] as const;
	return fields.find((field) => spec[field] !== undefined);
}

/**
 * Boxes that are directories on this machine: no isolation, no account, for development and for tests.
 *
 * A spec that names an `image`, a `snapshot`, `cpus`, `memoryMb`, a `gpu`, a `region` or an `isolation` other than
 * `none` is refused with `unsupported`: a directory cannot give them. A detached watchdog ends a box when its
 * lifetime has passed, whatever happened to the process that created it. On Linux `destroy` and the watchdog end every
 * program of the box, found by a marker in its environment. Where `/proc` is missing they end only the programs this
 * process started and their process groups, and the watchdog removes the box's directory only.
 */
export function localBoxes(options: LocalBoxesOptions): BoxProvider {
	const root = resolve(options.root);

	/** The live box in `directory`, after ending it when its lifetime has passed. */
	async function open(directory: string, id: string): Promise<LocalBox | undefined> {
		const record = await readRecord(directory);
		if (record === undefined) return undefined;
		if (Date.now() >= record.expiresAt) {
			await destroyDirectory(directory, id);
			return undefined;
		}
		return new LocalBox(directory, record);
	}

	return {
		name: "local",

		async create(spec: BoxSpec, _context: Context): Promise<Result<Box, BoxError>> {
			if (spec.workspace !== undefined && !isAbsolute(spec.workspace)) {
				return err(new BoxError("invalid", "workspace must be an absolute path"));
			}
			if (!(spec.maxLifetimeMs > 0)) return err(new BoxError("invalid", "maxLifetimeMs must be positive"));
			const unsupported = unsupportedField(spec);
			if (unsupported !== undefined) {
				return err(new BoxError("unsupported", `a local box is a directory and cannot honour ${unsupported}`));
			}
			if (spec.isolation !== undefined && spec.isolation !== "none") {
				return err(
					new BoxError("unsupported", `a local box has no isolation, the spec asks for ${spec.isolation}`),
				);
			}
			const reserved = Object.keys(spec.labels ?? {}).find((key) => key.startsWith(RESERVED_LABEL_PREFIX));
			if (reserved !== undefined) {
				return err(new BoxError("invalid", `the label ${reserved} is in the providers' own namespace`));
			}
			const id = `local-${randomBytes(6).toString("hex")}`;
			const directory = join(root, id);
			const record: LocalRecord = {
				id,
				workspace: spec.workspace ?? join(directory, "workspace"),
				labels: spec.labels ?? {},
				env: spec.env ?? {},
				path: options.path ?? DEFAULT_PATH,
				maxLifetimeMs: spec.maxLifetimeMs,
				expiresAt: Date.now() + spec.maxLifetimeMs,
			};
			try {
				for (const name of ["home", "tmp"]) await mkdir(join(directory, name), { recursive: true });
				await mkdir(record.workspace, { recursive: true });
				await writeFile(join(directory, RECORD_FILE), JSON.stringify(record));
			} catch (error) {
				return err(
					new BoxError("unknown", `could not create a box in ${root}: ${(error as Error).message}`, error),
				);
			}
			const seconds = (spec.maxLifetimeMs / 1000).toFixed(3);
			spawn("sh", ["-c", WATCHDOG_SCRIPT, "sh", seconds, directory, `${BOX_MARKER}=${id}`], {
				env: { PATH: DEFAULT_PATH, [WATCHDOG_MARKER]: id },
				stdio: "ignore",
				detached: true,
			}).unref();
			return ok(new LocalBox(directory, record));
		},

		async attach(id: string, _context: Context): Promise<Result<Box | undefined, BoxError>> {
			if (!/^local-[0-9a-f]+$/.test(id)) return ok(undefined);
			return ok(await open(join(root, id), id));
		},

		async list(labels, _context: Context): Promise<Result<readonly BoxRef[], BoxError>> {
			const names = await readdir(root).catch(() => [] as string[]);
			const refs: BoxRef[] = [];
			for (const name of names) {
				if (!name.startsWith("local-")) continue;
				const record = await readRecord(join(root, name));
				if (record === undefined || Date.now() >= record.expiresAt) continue;
				if (Object.entries(labels).every(([key, value]) => record.labels[key] === value)) {
					refs.push({ id: record.id, labels: record.labels });
				}
			}
			return ok(refs);
		},
	};
}
