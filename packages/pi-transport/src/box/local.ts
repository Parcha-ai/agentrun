import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	isReservedLabel,
} from "./box.ts";
import { adaptChild } from "./child.ts";
import { refuseMounts, refuseNetworkFields } from "./network.ts";

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const RECORD_FILE = "box.json";
/** Every program of a box carries `PI_TRANSPORT_BOX=<box id>` in its environment, and so does what it starts. */
const BOX_MARKER = "PI_TRANSPORT_BOX";
/** The watchdog of a box carries this instead, so ending the box's programs never ends the watchdog first. */
const WATCHDOG_MARKER = "PI_TRANSPORT_WATCHDOG";
const KILL_ROUNDS = 5;

/** Whether this system shows a process's environment under `/proc`, which is how a box's programs are found. */
const HAS_PROC = existsSync("/proc/self/environ");

/**
 * Runs detached from the host and ends the box when its lifetime has passed: `$1` seconds, `$2` the box's directory,
 * `$3` the marker its programs carry, `$4` the process group of the host that made the box, which it never ends. A box that was destroyed first has no record left, and the script does nothing.
 * It ends the recorded programs whose start time still matches, then every process that carries the marker, then every
 * process working in a directory inside the box's, with its process group.
 */
const WATCHDOG_SCRIPT = `sleep "$1" || exit 0
[ -f "$2/${RECORD_FILE}" ] || exit 0
# The box's directory as /proc shows a process working in it, every link resolved.
dir=$(cd -P -- "$2" 2>/dev/null && pwd -P) || dir=$2
# end_group <group> <host's group>: ends the group unless it is 1 or less, this watchdog's own, or the host's ($4, the
# group of the process that made the box).
end_group() {
	[ -n "$1" ] && [ "$1" -gt 1 ] 2>/dev/null && [ "$1" != "$2" ] && [ "$1" != "$$" ] && kill -KILL "-$1" 2>/dev/null
}
group_of() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f3; }
chmod u+rwx -- "$2" "$2/pids" 2>/dev/null
rm -f -- "$2/${RECORD_FILE}"
for file in "$2"/pids/*; do
	[ -f "$file" ] || continue
	pid=\${file##*/}
	started=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | cut -d' ' -f20)
	[ -n "$started" ] && [ "$started" = "$(cat "$file")" ] && end_group "$pid" "$4"
done
round=0
while [ "$round" -lt ${KILL_ROUNDS} ]; do
	round=$((round + 1))
	found=$(grep -l -a -z -F -x -e "$3" /proc/[0-9]*/environ 2>/dev/null)
	[ -n "$found" ] || break
	# Their groups first: a runner killed alone leaves its program in the group, with nothing left that leads back to it.
	groups=
	for environ in $found; do
		pid=\${environ#/proc/}
		groups="$groups $(group_of "\${pid%/environ}")"
	done
	for group in $(printf '%s\\n' $groups | sort -u); do end_group "$group" "$4"; done
	for environ in $found; do
		pid=\${environ#/proc/}
		kill -KILL "\${pid%/environ}" 2>/dev/null
	done
done
# One listing of every working directory, so a machine with thousands of processes costs two processes, not thousands.
found=$(ls -l /proc/[0-9]*/cwd 2>/dev/null | awk -v d="$dir" -v self="$$" '{
	at = index($0, " -> "); if (!at) next
	path = substr($0, at + 4); sub(/ \\(deleted\\)$/, "", path)
	if (path != d && index(path, d "/") != 1) next
	name = substr($0, 1, at - 1); sub(/.*\\/proc\\//, "", name); sub(/\\/cwd$/, "", name)
	if (name != self) print name
}')
groups=
for pid in $found; do groups="$groups $(group_of "$pid")"; done
for group in $(printf '%s\\n' $groups | sort -u); do end_group "$group" "$4"; done
for pid in $found; do kill -KILL "$pid" 2>/dev/null; done
rm -rf -- "$2" 2>/dev/null || { chmod -R u+rwX -- "$2" 2>/dev/null; rm -rf -- "$2"; }`;

export type LocalBoxesOptions = {
	/** Directory that holds one subdirectory per box. Created when absent. */
	readonly root: string;
	/**
	 * The `PATH` of programs in a box. Default `/usr/local/bin:/usr/bin:/bin`. This process's own `PATH` is never used
	 * unless the host passes it here.
	 */
	readonly path?: string;
	/** The POSIX shell that runs a box's watchdog. Default `sh`. */
	readonly shell?: string;
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
			bulk: "stream",
			secretsVia: "fd",
			// A directory on this machine uses its network; it reports no ports, disk or Yama setting.
			network: "open",
			startedAt: new Date(this.#record.expiresAt - this.#record.maxLifetimeMs).toISOString(),
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
		// Listeners attach before anything else: a short program can exit at once.
		const started = adaptChild(child, () => killGroup(pid), options, context);
		if (pid !== undefined) this.#remember(pid, child);
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
			await destroyDirectory(this.#directory, this.id);
			return ok(undefined);
		} catch (error) {
			return err(new BoxError("unknown", `could not remove box ${this.id}: ${(error as Error).message}`, error));
		}
	}

	/**
	 * Remember a program the box started until it closes, so a later `destroy` or the watchdog can end its process
	 * group even when the program replaced its environment and lost the box's marker.
	 */
	#remember(pid: number, child: ChildProcess): void {
		if (!HAS_PROC) {
			const groups = startedHere.get(this.id) ?? new Set<number>();
			startedHere.set(this.id, groups.add(pid));
			child.once("close", () => groups.delete(pid));
			return;
		}
		const started = startTime(pid);
		if (started === undefined) return;
		const file = join(this.#directory, "pids", String(pid));
		try {
			writeFileSync(file, started);
		} catch {
			// The box was destroyed while the program started; the destroy has ended it or the marker will.
			return;
		}
		child.once("close", () => {
			try {
				rmSync(file, { force: true });
			} catch {
				// A program may have locked the box's directories; `destroy` unlocks them and removes the record.
			}
		});
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

/** How long `destroy` waits for the processes it killed to be gone. */
const GONE_WAIT_MS = 5_000;
const GONE_POLL_MS = 5;

/** Whether the process is gone from `/proc`, or is a zombie that only waits to be reaped. */
function isGone(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
		// The state letter follows the command name, which is in parentheses and may itself hold parentheses.
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
	} catch {
		return true;
	}
}

/**
 * Wait, with the event loop running so that Node can reap its own children, until every process is gone or a zombie.
 * Bounded: a process that does not die within five seconds is left, as before.
 */
async function waitGone(pids: readonly number[]): Promise<void> {
	if (!HAS_PROC) return;
	const deadline = Date.now() + GONE_WAIT_MS;
	while (pids.some((pid) => !isGone(pid)) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, GONE_POLL_MS));
	}
}

/** When a process started, in the kernel's clock ticks, or `undefined` when it is gone. */
function startTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
		// The second field is the program's name in parentheses and may hold spaces; the start time is field 22.
		return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

/**
 * Every process in the process group `pgid`, read from `/proc/<pid>/stat`. A member that cleared its environment has
 * no marker, so the group is the only way to find it.
 */
function groupMembers(pgid: number): number[] {
	const members: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, "latin1");
			// After the name: state, parent, then the process group.
			if (Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]) === pgid) members.push(Number(name));
		} catch {
			// It ended while the directory was read.
		}
	}
	return members;
}

/**
 * End the process groups of the programs a box recorded. A record is trusted only while the process it names still
 * has the start time it recorded, so a process id the system reused is never killed.
 */
function endRecorded(directory: string): number[] {
	const ended: number[] = [];
	let names: string[];
	try {
		names = readdirSync(join(directory, "pids"));
	} catch {
		return ended;
	}
	for (const name of names) {
		let recorded: string;
		try {
			recorded = readFileSync(join(directory, "pids", name), "latin1");
		} catch {
			continue;
		}
		if (recorded !== "" && recorded === startTime(Number(name))) {
			// Listed first: the members that cleared their environment are found by their group alone.
			ended.push(Number(name), ...groupMembers(Number(name)));
			killGroup(Number(name));
		}
	}
	return ended;
}

/**
 * The processes of this box, as its programs or as its watchdog: those whose environment names it, and those working in a
 * directory inside the box's own, which finds a program that cleared its environment and outlived what started it. One
 * pass over `/proc`, read synchronously: a pass of awaited reads is twenty times slower on a machine with thousands of
 * processes.
 */
function processesOf(directory: string, id: string): { programs: number[]; watchdogs: number[] } {
	const programs: number[] = [];
	const watchdogs: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
		let entries: string[];
		try {
			entries = readFileSync(`/proc/${name}/environ`, "latin1").split("\0");
		} catch {
			// Another user's process, or one that has ended.
			continue;
		}
		if (entries.includes(`${WATCHDOG_MARKER}=${id}`)) watchdogs.push(Number(name));
		else if (entries.includes(`${BOX_MARKER}=${id}`) || worksIn(Number(name), directory)) programs.push(Number(name));
	}
	return { programs, watchdogs };
}

/** Whether `pid` works in `directory` or a directory under it (a removed one reads with " (deleted)" after it). */
function worksIn(pid: number, directory: string): boolean {
	let cwd: string;
	try {
		cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
	} catch {
		return false;
	}
	return cwd === directory || cwd.startsWith(`${directory}/`);
}

/** The process group of `pid`, from `/proc/<pid>/stat`, or undefined once it has ended. */
function groupOf(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
		const pgid = Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]);
		return pgid > 1 ? pgid : undefined;
	} catch {
		return undefined;
	}
}

/** This process's own group, which a box's end never kills: every program a box starts runs in a group of its own. */
const OWN_GROUP = HAS_PROC ? groupOf(process.pid) : undefined;

/**
 * End every program of a box and its watchdog. Two ways find them: the record of each program the box started and
 * that still runs, whose process group is ended even when it replaced its environment; and the marker in a
 * process's own environment, which also finds a program that left its group or outlived the one that started it.
 * A third way finds a program that did both, replaced its environment and outlived its starter: it works in a directory
 * inside the box's. Each program found takes its process group with it. None kills a reused process id or this process's
 * own group. Where `/proc` is missing, only the process groups this process started are ended.
 */
function endPrograms(directory: string, id: string): number[] {
	if (!HAS_PROC) {
		for (const pid of startedHere.get(id) ?? []) killGroup(pid);
		startedHere.delete(id);
		return [];
	}
	const ended = endRecorded(directory);
	// What /proc shows a process working in: the directory with every link resolved.
	let real = directory;
	try {
		real = realpathSync(directory);
	} catch {
		// Gone already: the environment's marker and the records still find what is left.
	}
	for (let round = 0; round < KILL_ROUNDS; round += 1) {
		const { programs, watchdogs } = processesOf(real, id);
		for (const pid of [...watchdogs, ...programs]) {
			// A program's group goes with it: a member that cleared its environment and works elsewhere is found by it alone,
			// and once the program is killed the group has no other way back to the box.
			const group = groupOf(pid);
			if (programs.includes(pid) && group !== undefined && group !== OWN_GROUP) {
				ended.push(...groupMembers(group));
				killGroup(group);
			}
			try {
				process.kill(pid, "SIGKILL");
				ended.push(pid);
			} catch {
				// It ended between the scan and the kill.
			}
		}
		// A program may have started another between the scan and its end, so programs get one more look.
		if (programs.length === 0) break;
	}
	return ended;
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
 * outside that directory and is never removed. Returns once every process it killed is gone or a zombie, for up to a
 * second.
 */
async function destroyDirectory(directory: string, id: string): Promise<void> {
	// A program may have taken its own write permission from the box's directories. They are this user's.
	for (const path of [directory, join(directory, "pids")]) await chmod(path, 0o700).catch(() => {});
	// The record goes first: from then on every handle of this box reports it ended.
	await rm(join(directory, RECORD_FILE), { force: true });
	const ended = endPrograms(directory, id);
	await waitGone(ended);
	try {
		await rm(directory, { recursive: true, force: true });
	} catch {
		// A program may have taken its own write permission from a directory of the box. They are this user's.
		await new Promise<void>((resolve) => {
			const unlock = spawn("chmod", ["-R", "u+rwX", directory], { env: { PATH: DEFAULT_PATH }, stdio: "ignore" });
			unlock.once("error", () => resolve());
			unlock.once("close", () => resolve());
		});
		await rm(directory, { recursive: true, force: true });
	}
}

/** The first spec field a directory on this machine cannot honour, or `undefined`. */
function unsupportedField(spec: BoxSpec): string | undefined {
	const fields = ["image", "snapshot", "cpus", "memoryMb", "gpu", "region"] as const;
	return fields.find((field) => spec[field] !== undefined);
}

/**
 * Boxes that are directories on this machine: no isolation, no account, for development and for tests.
 *
 * A spec that names an `image`, a `snapshot`, `cpus`, `memoryMb`, a `gpu`, a `region`, any `mounts` or an `isolation`
 * other than `none` is refused with `unsupported`: a directory cannot give them. A detached watchdog ends a box when its
 * lifetime has passed, whatever happened to the process that created it. `destroy` returns once the processes it killed
 * are gone (up to five seconds). On Linux `destroy` and the watchdog end the
 * process group of every program the box started and that still runs, and every process that carries the box's marker
 * in its environment. A program that both replaced its environment and outlived its starter is not found. Where
 * `/proc` is missing they end only the programs this process started and their process groups, and the watchdog
 * removes the box's directory only.
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
			const refusedNetwork = refuseNetworkFields(spec, "local");
			if (refusedNetwork !== undefined) return err(refusedNetwork);
			// A local box shares this machine's files: a mount would bind nothing and promise a separation it does not have.
			const refusedMounts = refuseMounts(spec, "local");
			if (refusedMounts !== undefined) return err(refusedMounts);
			const reserved = Object.keys(spec.labels ?? {}).find(isReservedLabel);
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
				// Its user's alone, whatever the umask: the launcher refuses a spool below a directory another user can write.
				for (const name of ["home", "tmp", "pids"])
					await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
				await mkdir(record.workspace, { recursive: true });
				await writeFile(join(directory, RECORD_FILE), JSON.stringify(record));
			} catch (error) {
				return err(
					new BoxError("unknown", `could not create a box in ${root}: ${(error as Error).message}`, error),
				);
			}
			const seconds = (spec.maxLifetimeMs / 1000).toFixed(3);
			const shell = options.shell ?? "sh";
			const watchdog = spawn(
				shell,
				["-c", WATCHDOG_SCRIPT, "sh", seconds, directory, `${BOX_MARKER}=${id}`, String(OWN_GROUP ?? 0)],
				{
					env: { PATH: DEFAULT_PATH, [WATCHDOG_MARKER]: id },
					stdio: "ignore",
					detached: true,
				},
			);
			const failure = await new Promise<Error | undefined>((resolve) => {
				watchdog.once("spawn", () => resolve(undefined));
				watchdog.once("error", resolve);
			});
			if (failure !== undefined) {
				// A box with no watchdog would outlive its lifetime, so there is no box.
				await rm(directory, { recursive: true, force: true }).catch(() => {});
				return err(new BoxError("spawn", `could not start the box's watchdog: ${failure.message}`, failure));
			}
			watchdog.unref();
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
