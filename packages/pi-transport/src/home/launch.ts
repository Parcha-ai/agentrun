import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box } from "../box/box.ts";
import { finish } from "../box/files.ts";
import { LAUNCHER_SCRIPT } from "./launcher-script.ts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_PREFIX = "PI_TRANSPORT_";
const DEFAULT_RESTART_BURST = 5;
const DEFAULT_RESTART_INTERVAL_MS = 60_000;
const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;
const MIN_LOG_MAX_BYTES = 1024;
/** Bounds that keep the numbers the launcher's shell does arithmetic on small and exact. */
const MAX_LOG_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_INTERVAL_MS = 30 * MAX_DELAY_MS;
const MAX_RESTART_BURST = 1_000_000;
const START_WAIT_MS = 15_000;
const POLL_MS = 100;
const CALL_TIMEOUT_MS = 30_000;
const MAX_EXIT_CODE = 255;
const SPOOL_DIRECTORY = ".pi-transport-launch";

/** Where a launch is in its life. `lost` means its launcher is gone and its file still says the program was alive. */
export type LaunchPhase =
	| "starting"
	| "running"
	| "restarting"
	| "exited"
	| "gave_up"
	| "stopping"
	| "stopped"
	| "lost";

/** What to keep alive in a box. The program is an argv: the launcher does not know what it is. */
export type LaunchSpec = {
	readonly argv: readonly string[];
	/** Plain settings for the program. Never a secret: the launcher keeps them in a file of the box. */
	readonly env?: Readonly<Record<string, string>>;
	/** Where the program starts. A relative path resolves against the box's workspace. */
	readonly cwd?: string;
	/** Start it again when it exits, unless the exit code is in `terminalExits`. Default true. */
	readonly restart?: boolean;
	/** Wait this long before a restart. Default 0. */
	readonly restartDelayMs?: number;
	/** At most `burst` restarts in `intervalMs` (whole seconds), then the launcher gives up. Default 5 in 60 s. */
	readonly restartLimit?: { readonly burst: number; readonly intervalMs: number };
	/** Exit codes that mean "do not start me again". 0 is always one. */
	readonly terminalExits?: readonly number[];
	/** The output file keeps about this many bytes of the program's tail. Default 1 MiB. */
	readonly logMaxBytes?: number;
};

/** What the launcher's own state file says, plus whether the launcher still runs. */
export type LaunchState = {
	readonly phase: LaunchPhase;
	/** The process group leader of the running program's wrapper; absent unless `running`. */
	readonly pid?: number;
	/** How many times the program was started. */
	readonly starts: number;
	/** The last exit code: 128 + n for a signal, 137 when the wrapper itself was killed. */
	readonly lastExit?: number;
	/** When the phase was written, in milliseconds, to the second. */
	readonly since: number;
	/** Whether the launcher (its supervisor or its watchdog) is running. A terminal phase has no launcher. */
	readonly launcherAlive: boolean;
	/** The launcher's directory in the box, with `out.log`, the program's output. */
	readonly directory: string;
};

/** Why a launcher call failed. `invalid` is a bad spec or name; `box` is a failed call to the box; `timeout` is a program that did not start. */
export type LaunchErrorCode = "invalid" | "box" | "timeout" | "failed";

/** An expected failure of a launcher call. Returned, never thrown. */
export class LaunchError extends Error {
	public code: LaunchErrorCode;

	constructor(code: LaunchErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "LaunchError";
		this.code = code;
	}
}

const TERMINAL_PHASES: ReadonlySet<LaunchPhase> = new Set(["exited", "gave_up", "stopped"]);

const CLAIM_SCRIPT = [
	't=$TMPDIR; [ -n "$t" ] || t=/tmp',
	`b="$t/${SPOOL_DIRECTORY}"`,
	'mkdir -p -m 700 "$b" || exit 3',
	'if mkdir -m 700 "$b/$1" 2>/dev/null; then echo "CLAIMED $b/$1"; else echo "EXISTS $b/$1"; fi',
].join("\n");

const LOCATE_SCRIPT = [
	't=$TMPDIR; [ -n "$t" ] || t=/tmp',
	`D="$t/${SPOOL_DIRECTORY}/$1"`,
	'[ -d "$D" ] || { echo NODIR; exit 4; }',
	'echo "DIR $D"',
].join("\n");

function quote(word: string): string {
	return `'${word.replaceAll("'", "'\\''")}'`;
}

function validate(name: string, spec: LaunchSpec | undefined): LaunchError | undefined {
	if (!NAME_PATTERN.test(name))
		return new LaunchError("invalid", `the launch name ${JSON.stringify(name)} is not a plain name`);
	if (spec === undefined) return undefined;
	if (spec.argv.length === 0 || spec.argv[0] === "") return new LaunchError("invalid", "argv is empty");
	for (const [key, value] of Object.entries(spec.env ?? {})) {
		if (!ENV_NAME_PATTERN.test(key) || key.startsWith(RESERVED_ENV_PREFIX)) {
			return new LaunchError("invalid", `the environment name ${JSON.stringify(key)} is not allowed`);
		}
		if (value.includes("\0")) return new LaunchError("invalid", `the value of ${key} holds a NUL byte`);
	}
	if (spec.argv.some((word) => word.includes("\0"))) return new LaunchError("invalid", "argv holds a NUL byte");
	for (const code of spec.terminalExits ?? []) {
		if (!Number.isInteger(code) || code < 1 || code > MAX_EXIT_CODE) {
			return new LaunchError(
				"invalid",
				`terminalExits holds ${code}, which is not an exit code from 1 to ${MAX_EXIT_CODE}`,
			);
		}
	}
	const limit = spec.restartLimit;
	if (limit !== undefined) {
		if (!Number.isInteger(limit.burst) || limit.burst < 0 || limit.burst > MAX_RESTART_BURST) {
			return new LaunchError("invalid", `restartLimit.burst must be a whole number from 0 to ${MAX_RESTART_BURST}`);
		}
		if (!Number.isFinite(limit.intervalMs) || limit.intervalMs <= 0 || limit.intervalMs > MAX_INTERVAL_MS) {
			return new LaunchError("invalid", `restartLimit.intervalMs must be a number from 1 to ${MAX_INTERVAL_MS}`);
		}
	}
	const delay = spec.restartDelayMs;
	if (delay !== undefined && (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_MS)) {
		return new LaunchError("invalid", `restartDelayMs must be a number from 0 to ${MAX_DELAY_MS}`);
	}
	const logMax = spec.logMaxBytes;
	if (logMax !== undefined && (!Number.isFinite(logMax) || logMax < MIN_LOG_MAX_BYTES || logMax > MAX_LOG_MAX_BYTES)) {
		return new LaunchError(
			"invalid",
			`logMaxBytes must be a number from ${MIN_LOG_MAX_BYTES} to ${MAX_LOG_MAX_BYTES}`,
		);
	}
	return undefined;
}

/** The spec as a file the launcher sources: settings, and a function that changes directory, sets the environment and execs. */
function specScript(spec: LaunchSpec): string {
	const limit = spec.restartLimit ?? { burst: DEFAULT_RESTART_BURST, intervalMs: DEFAULT_RESTART_INTERVAL_MS };
	const lines = [
		// One generation per launch: a process left over from an earlier launch of this name sees another and exits.
		`GEN='${randomBytes(8).toString("hex")}'`,
		`RESTART=${spec.restart === false ? 0 : 1}`,
		`DELAY=${((spec.restartDelayMs ?? 0) / 1000).toFixed(3)}`,
		`BURST=${limit.burst}`,
		`INTERVAL=${Math.ceil(limit.intervalMs / 1000)}`,
		`TERMINALS=${quote((spec.terminalExits ?? []).join(" "))}`,
		`LOGMAX=${Math.floor(spec.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES)}`,
		"run_program() {",
	];
	if (spec.cwd !== undefined) lines.push(`  cd ${quote(spec.cwd)} || exit 126`);
	for (const [key, value] of Object.entries(spec.env ?? {})) lines.push(`  export ${key}=${quote(value)}`);
	lines.push(`  exec ${spec.argv.map(quote).join(" ")}`, "}");
	return `${lines.join("\n")}\n`;
}

/** Run a script in the box and return its combined output, or an error. */
async function runScript(
	box: Box,
	script: string,
	args: readonly string[],
	context: Context,
): Promise<Result<{ exitCode: number; text: string }, LaunchError>> {
	const started = await box.exec(["sh", "-c", script, "sh", ...args], { timeoutMs: CALL_TIMEOUT_MS }, context);
	if (!started.ok)
		return err(
			new LaunchError("box", `could not run a command in box ${box.id}: ${started.error.message}`, started.error),
		);
	const finished = await finish(started.value);
	if (!finished.ok)
		return err(
			new LaunchError("box", `a command in box ${box.id} failed: ${finished.error.message}`, finished.error),
		);
	return ok({ exitCode: finished.value.exitCode, text: new TextDecoder().decode(finished.value.stdout) });
}

function parseState(text: string, directory: string): LaunchState | "none" | undefined {
	const lines = text.split("\n");
	const alive =
		lines
			.find((line) => line.startsWith("ALIVE "))
			?.slice("ALIVE ".length)
			.trim() === "1";
	const json = lines.find((line) => line.startsWith("{"));
	if (json === undefined) return lines.includes("NOSTATE") ? "none" : undefined;
	try {
		const raw = JSON.parse(json) as {
			phase: LaunchPhase;
			pid: number | null;
			starts: number;
			lastExit: number | null;
			since: number;
		};
		const lost = !alive && !TERMINAL_PHASES.has(raw.phase) && text.includes("ALIVE ");
		return {
			phase: lost ? "lost" : raw.phase,
			...(raw.pid === null || lost ? {} : { pid: raw.pid }),
			starts: raw.starts,
			...(raw.lastExit === null ? {} : { lastExit: raw.lastExit }),
			since: raw.since,
			launcherAlive: alive,
			directory,
		};
	} catch {
		return undefined;
	}
}

async function directoryOf(
	box: Box,
	name: string,
	context: Context,
): Promise<Result<{ directory: string; claimed: boolean }, LaunchError>> {
	const claimed = await runScript(box, CLAIM_SCRIPT, [name], context);
	if (!claimed.ok) return claimed;
	const line = claimed.value.text.split("\n").find((text) => /^(CLAIMED|EXISTS) /.test(text));
	if (claimed.value.exitCode !== 0 || line === undefined) {
		return err(
			new LaunchError(
				"failed",
				`could not claim a launch directory in box ${box.id}: ${claimed.value.text.trim().slice(0, 200)}`,
			),
		);
	}
	return ok({ directory: line.slice(line.indexOf(" ") + 1).trim(), claimed: line.startsWith("CLAIMED") });
}

async function readState(
	box: Box,
	directory: string,
	context: Context,
): Promise<Result<LaunchState | "none", LaunchError>> {
	const answered = await runScript(
		box,
		// A launch another caller has claimed but not yet filled has no launcher script: it is still starting.
		'D=$1; [ -d "$D" ] || { echo NODIR; exit 4; }; [ -r "$D/launcher.sh" ] || { echo NOSTATE; exit 0; }; sh "$D/launcher.sh" status "$D"',
		[directory],
		context,
	);
	if (!answered.ok) return answered;
	if (answered.value.exitCode === 4) return ok("none");
	const state = parseState(answered.value.text, directory);
	if (state === undefined)
		return err(new LaunchError("failed", `the launcher's state in box ${box.id} cannot be read`));
	return ok(state);
}

/** Wait until the launch has a state that is not `starting` and, if it is not over, a launcher that runs. */
async function waitForStart(box: Box, directory: string, context: Context): Promise<Result<LaunchState, LaunchError>> {
	const deadline = Date.now() + START_WAIT_MS;
	for (;;) {
		const state = await readState(box, directory, context);
		if (!state.ok) return state;
		if (state.value !== "none" && state.value.phase !== "starting" && state.value.phase !== "lost")
			return ok(state.value);
		if (Date.now() >= deadline)
			return err(
				new LaunchError("timeout", `the program in box ${box.id} did not start within ${START_WAIT_MS} ms`),
			);
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

/**
 * Keep a program alive in a box, whatever happens to the host: the launcher is a `sh` supervisor in its own session that
 * restarts the program when it exits. It outlives the call and the host. A second `launch` with the same name starts
 * nothing and returns the first one's state, unless that one has ended (`exited`, `gave_up`, `stopped`), when it starts
 * again. The spec's `env` is plain settings kept in a file of the box and never a secret. Needs POSIX `sh`, `setsid`,
 * `sed`, `cut`, `awk`, `wc`, `tail`, `date` and `sleep` in the box.
 */
export async function launch(
	box: Box,
	name: string,
	spec: LaunchSpec,
	context: Context,
): Promise<Result<LaunchState, LaunchError>> {
	const invalid = validate(name, spec);
	if (invalid !== undefined) return err(invalid);
	const claimed = await directoryOf(box, name, context);
	if (!claimed.ok) return claimed;
	if (!claimed.value.claimed) {
		const existing = await readState(box, claimed.value.directory, context);
		if (!existing.ok) return existing;
		if (existing.value !== "none" && !TERMINAL_PHASES.has(existing.value.phase)) {
			if (existing.value.phase !== "lost") return ok(existing.value);
			// Its launcher is gone and nothing in the box restarts it: start the supervisor again, which adopts the file.
			const revived = await runScript(box, 'sh "$1/launcher.sh" start "$1"', [claimed.value.directory], context);
			if (!revived.ok) return revived;
			return waitForStart(box, claimed.value.directory, context);
		}
		if (existing.value === "none") return waitForStart(box, claimed.value.directory, context);
		const removed = await runScript(box, 'sh "$1/launcher.sh" clear "$1"', [claimed.value.directory], context);
		if (!removed.ok) return removed;
		if (removed.value.exitCode !== 0) return err(new LaunchError("failed", `could not clear the old launch ${name}`));
	}
	const directory = claimed.value.directory;
	const uploaded = await box.upload(
		[
			{ path: `${directory}/launcher.sh.part`, bytes: new TextEncoder().encode(LAUNCHER_SCRIPT), mode: 0o700 },
			{ path: `${directory}/spec.sh.part`, bytes: new TextEncoder().encode(specScript(spec)), mode: 0o600 },
		],
		context,
	);
	if (!uploaded.ok)
		return err(new LaunchError("box", `could not upload the launcher: ${uploaded.error.message}`, uploaded.error));
	// The files appear under their names in one step, the script last: a caller that sees the script sees a whole launcher.
	const started = await runScript(
		box,
		'mv "$1/spec.sh.part" "$1/spec.sh" && mv "$1/launcher.sh.part" "$1/launcher.sh" && sh "$1/launcher.sh" start "$1"',
		[directory],
		context,
	);
	if (!started.ok) return started;
	if (started.value.exitCode !== 0)
		return err(new LaunchError("failed", `the launcher did not start: ${started.value.text.trim().slice(0, 200)}`));
	return waitForStart(box, directory, context);
}

/** The state of a launch, read from its state file. `undefined` when no launch of that name exists in the box. */
export async function launchStatus(
	box: Box,
	name: string,
	context: Context,
): Promise<Result<LaunchState | undefined, LaunchError>> {
	const invalid = validate(name, undefined);
	if (invalid !== undefined) return err(invalid);
	const located = await runScript(box, LOCATE_SCRIPT, [name], context);
	if (!located.ok) return located;
	if (located.value.exitCode === 4) return ok(undefined);
	const directory = located.value.text
		.split("\n")
		.find((line) => line.startsWith("DIR "))
		?.slice(4)
		.trim();
	if (directory === undefined) return err(new LaunchError("failed", "the launch directory cannot be found"));
	const state = await readState(box, directory, context);
	if (!state.ok) return state;
	if (state.value === "none") return ok({ phase: "starting", starts: 0, since: 0, launcherAlive: false, directory });
	return ok(state.value);
}

/**
 * End the program and everything in its process group: TERM first, KILL after `graceMs` (default 5 s), then the
 * launcher itself, and report `stopped`. A launch that already ended keeps its terminal phase. A launch that does not exist
 * is `invalid`.
 */
export async function stopLaunch(
	box: Box,
	name: string,
	options: { readonly graceMs?: number } | undefined,
	context: Context,
): Promise<Result<LaunchState, LaunchError>> {
	const current = await launchStatus(box, name, context);
	if (!current.ok) return current;
	if (current.value === undefined) return err(new LaunchError("invalid", `no launch named ${name} in box ${box.id}`));
	const tenths = Math.ceil((options?.graceMs ?? DEFAULT_GRACE_MS) / 100);
	const stopped = await runScript(
		box,
		'sh "$1/launcher.sh" stop "$1" "$2"',
		[current.value.directory, String(tenths)],
		context,
	);
	if (!stopped.ok) return stopped;
	// The stop script prints the state and exits 0. Any other end means it did not finish: the program may still run.
	if (stopped.value.exitCode !== 0) {
		const said = stopped.value.text.trim().slice(0, 200);
		return err(
			new LaunchError("failed", `the stop of ${name} did not finish (exit ${stopped.value.exitCode}): ${said}`),
		);
	}
	const after = await launchStatus(box, name, context);
	if (!after.ok) return after;
	if (after.value === undefined)
		return err(new LaunchError("failed", `the launch ${name} vanished while it was stopped`));
	return ok(after.value);
}
