import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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

export type LocalBoxesOptions = {
	/** Directory that holds one subdirectory per box. Created when absent. */
	readonly root: string;
};

type LocalRecord = {
	readonly id: string;
	/** Inside the box's directory, or a directory the caller named, which `destroy` leaves in place. */
	readonly workspace: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly env: Readonly<Record<string, string>>;
	readonly maxLifetimeMs: number;
	readonly expiresAt: number;
};

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * A box that is a directory on this machine. Invariant: a program started in it never receives this process's
 * environment, only a fixed `PATH`, a private `HOME` and `TMPDIR`, and the spec's `env`.
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
				PATH: process.env.PATH ?? DEFAULT_PATH,
				HOME: join(this.#directory, "home"),
				TMPDIR: join(this.#directory, "tmp"),
				...this.#record.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const pid = child.pid;
		// Listeners attach before anything is awaited: a short program can exit during the first await.
		const started = adaptChild(child, () => killGroup(pid), options, context);
		if (pid !== undefined) {
			// The file lets a later `destroy`, from any process, find and end this program's group.
			const marker = join(this.#directory, "pids", String(pid));
			const written = processStartTime(pid)
				.then((startTime) => writeFile(marker, startTime ?? ""))
				.catch(() => {});
			child.once("close", () => void written.then(() => rm(marker, { force: true })).catch(() => {}));
			await written;
		}
		return ok(started);
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
			await destroyDirectory(this.#directory);
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

/** When the process started, in the kernel's clock ticks, or `undefined` where `/proc` cannot say. */
async function processStartTime(pid: number): Promise<string | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		// The second field is the program name in parentheses and may hold spaces; the start time is field 22.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

/**
 * End the programs a box's marker files name. A marker is trusted only when the process it names still has the start
 * time the marker recorded, so a process id the system reused is never killed.
 */
async function killMarked(directory: string): Promise<void> {
	const names = await readdir(join(directory, "pids")).catch(() => [] as string[]);
	for (const name of names) {
		const recorded = await readFile(join(directory, "pids", name), "utf8").catch(() => "");
		if (recorded !== "" && recorded === (await processStartTime(Number(name)))) killGroup(Number(name));
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
 * End a box: its programs, then its own directory. A workspace the caller named lies outside that directory and is
 * never removed.
 */
async function destroyDirectory(directory: string): Promise<void> {
	// The record goes first: from then on every handle of this box reports it ended.
	await rm(join(directory, RECORD_FILE), { force: true });
	await killMarked(directory);
	await rm(directory, { recursive: true, force: true });
}

/** Boxes that are directories on this machine: no isolation, no account, for development and for tests. */
export function localBoxes(options: LocalBoxesOptions): BoxProvider {
	const root = resolve(options.root);

	/** The live box in `directory`, after ending it when its lifetime has passed. */
	async function open(directory: string): Promise<LocalBox | undefined> {
		const record = await readRecord(directory);
		if (record === undefined) return undefined;
		if (Date.now() >= record.expiresAt) {
			await destroyDirectory(directory);
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
			if (spec.isolation !== undefined && spec.isolation !== "none") {
				return err(
					new BoxError("unsupported", `a local box has no isolation, the spec asks for ${spec.isolation}`),
				);
			}
			const id = `local-${randomBytes(6).toString("hex")}`;
			const directory = join(root, id);
			const record: LocalRecord = {
				id,
				workspace: spec.workspace ?? join(directory, "workspace"),
				labels: spec.labels ?? {},
				env: spec.env ?? {},
				maxLifetimeMs: spec.maxLifetimeMs,
				expiresAt: Date.now() + spec.maxLifetimeMs,
			};
			try {
				for (const name of ["home", "tmp", "pids"]) await mkdir(join(directory, name), { recursive: true });
				await mkdir(record.workspace, { recursive: true });
				await writeFile(join(directory, RECORD_FILE), JSON.stringify(record));
			} catch (error) {
				return err(
					new BoxError("unknown", `could not create a box in ${root}: ${(error as Error).message}`, error),
				);
			}
			return ok(new LocalBox(directory, record));
		},

		async attach(id: string, _context: Context): Promise<Result<Box | undefined, BoxError>> {
			if (!/^local-[0-9a-f]+$/.test(id)) return ok(undefined);
			return ok(await open(join(root, id)));
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
