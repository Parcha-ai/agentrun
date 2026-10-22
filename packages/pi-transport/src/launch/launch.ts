import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box } from "../box/box.ts";
import { finish } from "../box/files.ts";
import { LAUNCHER_SCRIPT } from "./launcher-script.ts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_PREFIX = "PI_TRANSPORT_";
/** The names the launcher sets for every incarnation itself. */
const LAUNCHER_ENV = new Set(["PATH", "HOME", "LANG", "PI_TRANSPORT_INCARNATION", "PI_TRANSPORT_SECRETS_FD"]);
/** A user name or a numeric uid, as `user` names one. */
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
/** The most a launch's stdin, or its secrets as JSON, may be: each part of the frame, decoded. */
const MAX_FRAME_PART = 64 * 1024;
/** The first line of the launch frame (README, "The launch frame"). */
const FRAME_MAGIC = "PI-TRANSPORT-LAUNCH/1";
/** A stop hook's default bound, and the longest one may be. */
const DEFAULT_HOOK_MS = 30_000;
const MAX_HOOK_MS = 120_000;
/** A name one of whose `_`-separated segments says it holds a key: refused in `env`, which rests in a file of the box. */
const KEY_SEGMENT = /^(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)$/i;
const keyShaped = (name: string): boolean => name.split("_").some((segment) => KEY_SEGMENT.test(segment));
const DEFAULT_RESTART_BURST = 5;
const DEFAULT_RESTART_INTERVAL_MS = 60_000;
const DEFAULT_GRACE_MS = 5_000;
/** A stop waits this long for the program at most, and its call to the box is given that much time and more. */
const MAX_GRACE_MS = 10 * 60_000;
/** A claimed directory nobody has filled for this long was abandoned by a caller that died or failed to upload. */
const ABANDONED_CLAIM_S = 60;
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

/** A launch as its caller keeps it: JSON with no secret in it (a host may store it), found again in the box by its name. */
export type Launch = { readonly v: 1; readonly name: string };

/** What to keep alive in a box. The program is an argv: the launcher does not know what it is. */
export type LaunchSpec = {
	readonly argv: readonly string[];
	/**
	 * Plain settings for the program. Never a secret: the launcher keeps them in a file of the box, so a key-shaped name (a
	 * `_`-separated segment KEY, TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL or CREDENTIALS) is refused, as are PATH, HOME,
	 * LANG and every name the launcher sets.
	 */
	readonly env?: Readonly<Record<string, string>>;
	/**
	 * What the program takes from the launcher's own environment (the box runtime's): nothing by default (`false`), or exactly
	 * these names when they are set. Its environment is otherwise PATH, HOME, LANG (C.UTF-8), PI_TRANSPORT_INCARNATION (the
	 * incarnation, from 1) and `env`.
	 */
	readonly inheritEnv?: false | readonly string[];
	/** Who the program runs as: a user name or a numeric uid. */
	readonly user?: string;
	/** Bytes written to every incarnation's stdin, then closed, held only in the launcher's memory. */
	readonly stdin?: Uint8Array;
	/** Secrets for every incarnation, on the fd named by PI_TRANSPORT_SECRETS_FD, held only in the launcher's memory. */
	readonly secrets?: Readonly<Record<string, string>>;
	/** Run once by a stop, after the drain and before the final kill, bounded by `timeoutMs`. */
	readonly beforeStop?: { readonly argv: readonly string[]; readonly timeoutMs?: number };
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
	/** This launch's handle, for `launchState` and `launchStop`. */
	readonly launch: Launch;
	readonly phase: LaunchPhase;
	/** The incarnation now or last running, from 1; 0 before the first. */
	readonly incarnation: number;
	/** How many times the program was started again: the incarnation less one, never below 0. */
	readonly restarts: number;
	/** The user the program runs as, when the launch named one: never a secret. */
	readonly user?: { readonly name: string; readonly uid: number };
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

/**
 * Why a launcher call failed. `invalid` is a bad spec or name; `box` is a failed call to the box; `timeout` is a program that
 * did not start; `unsupported` is a spec the box cannot honour; `refused` is a box whose setting would expose what the launch
 * holds (its ptrace scope).
 */
export type LaunchErrorCode = "invalid" | "box" | "timeout" | "failed" | "unsupported" | "refused";

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
	'if mkdir -m 700 "$b/$1" 2>/dev/null; then date +%s > "$b/$1/claimed.at"; echo "$2" > "$b/$1/owner"; echo "CLAIMED $b/$1"; else echo "EXISTS $b/$1"; fi',
].join("\n");

/**
 * Take over a directory that is not live, for one caller only. $1 is the directory, $2 the generation of the launch the caller
 * saw (empty for a claim nobody filled), $3 how old an unfilled claim must be. The replacement happens under a lock that
 * lives beside the directory, and only if the directory still holds what the caller saw; every other caller is told
 * BUSY, CHANGED or YOUNG and looks again. A lock older than two minutes belongs to a caller that died.
 */
const RECLAIM_SCRIPT = [
	// The lock is beside the launch directories under a name no launch can have: a launch name starts with a letter or digit.
	'D=$1; E=$2; A=$3; T=$4; L="${D%/*}/.lock.${D##*/}"',
	'if ! mkdir "$L" 2>/dev/null; then',
	'  at=$(cat "$L/at" 2>/dev/null); now=$(date +%s)',
	'  if [ -n "$at" ] && [ $((now - at)) -gt 120 ]; then rm -rf "$L"; fi',
	"  echo BUSY; exit 0",
	"fi",
	'date +%s > "$L/at"',
	`cur=$(sed -n "s/^GEN='\\(.*\\)'\\$/\\1/p" "$D/spec.sh" 2>/dev/null)`,
	'if [ "$cur" != "$E" ]; then rm -rf "$L"; echo CHANGED; exit 0; fi',
	'if [ -z "$E" ]; then',
	'  if [ -e "$D/launcher.sh" ]; then rm -rf "$L"; echo CHANGED; exit 0; fi',
	'  at=$(cat "$D/claimed.at" 2>/dev/null); now=$(date +%s)',
	'  if [ -z "$at" ]; then date +%s > "$D/claimed.at" 2>/dev/null; rm -rf "$L"; echo YOUNG; exit 0; fi',
	'  if [ $((now - at)) -le "$A" ]; then rm -rf "$L"; echo YOUNG; exit 0; fi',
	'  rm -rf "$D"; mkdir -m 700 "$D" || { rm -rf "$L"; echo FAILED; exit 0; }',
	"else",
	// Only an ended launch is cleared: one that has a generation and no state yet is starting.
	`  ph=$(sed -n 's/.*"phase":"\\([a-z_]*\\)".*/\\1/p' "$D/state" 2>/dev/null)`,
	'  case "$ph" in exited|gave_up|stopped) ;; *) rm -rf "$L"; echo CHANGED; exit 0 ;; esac',
	'  sh "$D/launcher.sh" clear "$D" || { rm -rf "$L"; echo FAILED; exit 0; }',
	"fi",
	'date +%s > "$D/claimed.at"; echo "$T" > "$D/owner"',
	'rm -rf "$L"; echo RECLAIMED',
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
		if (!ENV_NAME_PATTERN.test(key) || key.startsWith(RESERVED_ENV_PREFIX) || LAUNCHER_ENV.has(key)) {
			return new LaunchError("invalid", `the environment name ${JSON.stringify(key)} is not allowed`);
		}
		// The settings rest in a file of the box: a name that says it holds a key is refused by name, never echoing its value.
		if (keyShaped(key)) {
			return new LaunchError(
				"invalid",
				`the environment name ${key} looks like a key: env is kept in a file of the box and never holds a secret`,
			);
		}
		if (value.includes("\0")) return new LaunchError("invalid", `the value of ${key} holds a NUL byte`);
	}
	const inherited = spec.inheritEnv === undefined || spec.inheritEnv === false ? [] : spec.inheritEnv;
	if (spec.inheritEnv !== undefined && spec.inheritEnv !== false && !Array.isArray(spec.inheritEnv)) {
		return new LaunchError("invalid", "inheritEnv is false or a list of names");
	}
	for (const name of inherited) {
		if (!ENV_NAME_PATTERN.test(name) || name.startsWith(RESERVED_ENV_PREFIX) || LAUNCHER_ENV.has(name)) {
			return new LaunchError("invalid", `inheritEnv names ${JSON.stringify(name)}, which is not a name it can pass`);
		}
		if (spec.env !== undefined && Object.hasOwn(spec.env, name)) {
			return new LaunchError("invalid", `${name} is both in env and in inheritEnv: name it once`);
		}
	}
	if (spec.user !== undefined && (typeof spec.user !== "string" || !USER_PATTERN.test(spec.user)))
		return new LaunchError("invalid", "user is a user name or a numeric uid");
	if (spec.stdin !== undefined) {
		if (!(spec.stdin instanceof Uint8Array)) return new LaunchError("invalid", "stdin is bytes (a Uint8Array)");
		if (spec.stdin.byteLength > MAX_FRAME_PART) return new LaunchError("invalid", "stdin is over 64 KiB");
	}
	if (spec.secrets !== undefined) {
		for (const [key, value] of Object.entries(spec.secrets)) {
			// A secret is named, never echoed: no message carries a value.
			if (!ENV_NAME_PATTERN.test(key))
				return new LaunchError("invalid", `the secret name ${JSON.stringify(key)} is not a name`);
			if (typeof value !== "string" || value.includes("\0"))
				return new LaunchError("invalid", `the secret ${key} is not a string without a NUL byte`);
		}
		if (Buffer.byteLength(JSON.stringify(spec.secrets), "utf8") > MAX_FRAME_PART)
			return new LaunchError("invalid", "the secrets are over 64 KiB as JSON");
	}
	if (spec.beforeStop !== undefined) {
		const hook = spec.beforeStop;
		if (!Array.isArray(hook.argv) || hook.argv.length === 0 || hook.argv[0] === "")
			return new LaunchError("invalid", "beforeStop.argv is empty");
		if (hook.argv.some((word) => typeof word !== "string" || word.includes("\0")))
			return new LaunchError("invalid", "beforeStop.argv holds a NUL byte");
		const bound = hook.timeoutMs ?? DEFAULT_HOOK_MS;
		if (!Number.isFinite(bound) || bound < 100 || bound > MAX_HOOK_MS)
			return new LaunchError("invalid", `beforeStop.timeoutMs must be a number from 100 to ${MAX_HOOK_MS}`);
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
function specScript(spec: LaunchSpec, isolation: string): string {
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
		// A launch with stdin or secrets is FRAMED: they come on the start's stdin and live only in the launcher's memory.
		`FRAMED=${framed(spec) ? 1 : 0}`,
		`RUNAS=${quote(spec.user ?? "")}`,
		// The box's isolation: on a vm the launcher may raise the ptrace scope a framed launch needs.
		`ISOLATION=${quote(isolation)}`,
		`HOOK=${spec.beforeStop === undefined ? 0 : 1}`,
		`HOOK_TENTHS=${Math.ceil((spec.beforeStop?.timeoutMs ?? DEFAULT_HOOK_MS) / 100)}`,
		"run_program() {",
	];
	if (spec.cwd !== undefined) lines.push(`  cd ${quote(spec.cwd)} || exit 126`);
	// Nothing of the launcher's own environment (the box runtime's) reaches the program but the names it asks for: every
	// exported name is unset, by the names awk lists, and one the shell cannot unset refuses the incarnation. Values never
	// go through an argv.
	const keep = [
		"PATH",
		"HOME",
		...(spec.inheritEnv === undefined || spec.inheritEnv === false ? [] : spec.inheritEnv),
	];
	lines.push(
		"  for v in $(awk 'BEGIN { for (k in ENVIRON) print k }'); do",
		`    case ${quote(` ${keep.join(" ")} `)} in *" $v "*) ;; *) unset "$v" 2>/dev/null || { echo "the launcher cannot clear $v from the environment" >&2; exit 126; } ;; esac`,
		"  done",
		"  export LANG=C.UTF-8",
		'  export PI_TRANSPORT_INCARNATION="$n"',
	);
	// The secrets are on fd 3, made for this incarnation from the launcher's memory: only the number is in the environment.
	if (spec.secrets !== undefined) lines.push("  export PI_TRANSPORT_SECRETS_FD=3");
	for (const [key, value] of Object.entries(spec.env ?? {})) lines.push(`  export ${key}=${quote(value)}`);
	const argv = spec.argv.map(quote).join(" ");
	// The user the launcher resolved at its start ($D/user: name, uid, gid, home). A root launcher drops to it; one that is
	// that user already execs as it is.
	lines.push(
		'  if [ -r "$D/user" ]; then',
		'    read -r u_name u_id u_gid u_home < "$D/user"',
		'    export HOME="$u_home"',
		'    if [ "$(id -u)" = 0 ] && [ "$u_id" != 0 ]; then',
		`      if command -v setpriv >/dev/null 2>&1; then exec setpriv --reuid="$u_id" --regid="$u_gid" --init-groups -- ${argv}; fi`,
		`      exec runuser -u "$u_name" -- ${argv}`,
		"    fi",
		"  fi",
		`  exec ${argv}`,
		"}",
	);
	// A stop's hook, run by the launcher as its own user after the drain (README, "beforeStop").
	if (spec.beforeStop !== undefined) lines.push("before_stop() {", `  exec ${spec.beforeStop.argv.map(quote).join(" ")}`, "}");
	return `${lines.join("\n")}\n`;
}

/** Run a script in the box and return its combined output, or an error. */
async function runScript(
	box: Box,
	script: string,
	args: readonly string[],
	context: Context,
	timeoutMs: number = CALL_TIMEOUT_MS,
	/** Bytes for the command's stdin (the launch frame), written and then closed. Never in its argv. */
	input?: Uint8Array,
): Promise<Result<{ exitCode: number; text: string }, LaunchError>> {
	const started = await box.exec(["sh", "-c", script, "sh", ...args], { timeoutMs }, context);
	if (!started.ok)
		return err(
			new LaunchError("box", `could not run a command in box ${box.id}: ${started.error.message}`, started.error),
		);
	if (input !== undefined) {
		// A command that ended before reading it (a claim taken over) says so by its exit code; a failed write is not the answer.
		try {
			await started.value.stdin.write(input);
			await started.value.stdin.close();
		} catch {
			// Its own answer is read below.
		}
	}
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
		const user = /^USER (\S+) (\d+)$/m.exec(text);
		return {
			launch: { v: 1, name: directory.slice(directory.lastIndexOf("/") + 1) },
			phase: lost ? "lost" : raw.phase,
			incarnation: raw.starts,
			restarts: Math.max(0, raw.starts - 1),
			...(raw.pid === null || lost ? {} : { pid: raw.pid }),
			starts: raw.starts,
			...(raw.lastExit === null ? {} : { lastExit: raw.lastExit }),
			since: raw.since,
			launcherAlive: alive,
			...(user ? { user: { name: user[1]!, uid: Number(user[2]) } } : {}),
			directory,
		};
	} catch {
		return undefined;
	}
}

async function directoryOf(
	box: Box,
	name: string,
	token: string,
	context: Context,
): Promise<Result<{ directory: string; claimed: boolean }, LaunchError>> {
	const claimed = await runScript(box, CLAIM_SCRIPT, [name, token], context);
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

/** What a directory holds: the state, or "none" for a claim nobody filled, and the generation of the launch (empty for none). */
type Seen = { readonly state: LaunchState | "none"; readonly gen: string };

async function readSeen(box: Box, directory: string, context: Context): Promise<Result<Seen, LaunchError>> {
	const answered = await runScript(
		box,
		// A launch another caller has claimed but not yet filled has no launcher script: it is still starting.
		'D=$1; [ -d "$D" ] || { echo NODIR; exit 4; }; [ -r "$D/launcher.sh" ] || { echo NOSTATE; exit 0; }; sh "$D/launcher.sh" status "$D"',
		[directory],
		context,
	);
	if (!answered.ok) return answered;
	if (answered.value.exitCode === 4) return ok({ state: "none", gen: "" });
	const state = parseState(answered.value.text, directory);
	// A script that fails and says nothing met a directory being replaced by another caller: look again, as for a new claim.
	if (state === undefined && answered.value.exitCode !== 0 && answered.value.text.trim() === "")
		return ok({ state: "none", gen: "" });
	if (state === undefined)
		return err(new LaunchError("failed", `the launcher's state in box ${box.id} cannot be read`));
	const gen = answered.value.text.split("\n").find((line) => line.startsWith("GEN "));
	return ok({ state, gen: gen === undefined ? "" : gen.slice(4).trim() });
}

async function readState(
	box: Box,
	directory: string,
	context: Context,
): Promise<Result<LaunchState | "none", LaunchError>> {
	const seen = await readSeen(box, directory, context);
	return seen.ok ? ok(seen.value.state) : seen;
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

/** Whether a launch carries stdin or secrets, which only a box with a real stdin path can take. */
const framed = (spec: LaunchSpec): boolean => spec.stdin !== undefined || spec.secrets !== undefined;

/**
 * The launch frame, on the stdin of the one exec that starts the launcher: a magic line, then the secrets as JSON and the
 * stdin, each base64 on a line of its own (empty when absent), then EOF. The launcher keeps the parts only in its memory.
 */
function frameOf(spec: LaunchSpec): Uint8Array | undefined {
	if (!framed(spec)) return undefined;
	const secrets =
		spec.secrets === undefined ? "" : Buffer.from(JSON.stringify(spec.secrets), "utf8").toString("base64");
	const stdin = spec.stdin === undefined ? "" : Buffer.from(spec.stdin).toString("base64");
	return new TextEncoder().encode(`${FRAME_MAGIC}\n${secrets}\n${stdin}\n`);
}

/** A start the launcher refused, as it says on a line of its own: INVALID, UNSUPPORTED or REFUSED and why (never a value). */
function refusalIn(text: string): LaunchError | undefined {
	for (const line of text.split("\n")) {
		const said = /^(INVALID|UNSUPPORTED|REFUSED) (.+)$/.exec(line.trim());
		if (said === null) continue;
		const code = said[1] === "INVALID" ? "invalid" : said[1] === "UNSUPPORTED" ? "unsupported" : "refused";
		return new LaunchError(code, said[2]!.slice(0, 200));
	}
	return undefined;
}

/** A handle this package can have made: version 1 and a plain launch name. */
function handleError(launch: Launch): LaunchError | undefined {
	if (launch === null || typeof launch !== "object" || launch.v !== 1 || typeof launch.name !== "string")
		return new LaunchError("invalid", "a launch handle is { v: 1, name }");
	return validate(launch.name, undefined);
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
	if (framed(spec)) {
		const facts = box.facts();
		if (facts.secretsVia !== "fd" || facts.liveProcesses === false)
			return err(
				new LaunchError(
					"unsupported",
					`box ${box.id} cannot carry a launch's stdin or secrets: it has no real stdin path for them (secretsVia "fd")`,
				),
			);
	}
	// A box that launches natively does it itself; read on every call (an attach returns a new Box).
	if (box.launcher !== undefined) return box.launcher.launch(name, spec, context);
	const frame = frameOf(spec);
	// Only a caller that holds the directory (it made it, or took it over from a dead or ended launch) fills it.
	const deadline = Date.now() + ABANDONED_CLAIM_S * 1000 + START_WAIT_MS;
	let directory: string;
	// Whoever holds the directory has written this token in it; a caller whose claim was taken over finds another there.
	const token = randomBytes(8).toString("hex");
	for (;;) {
		const claimed = await directoryOf(box, name, token, context);
		if (!claimed.ok) return claimed;
		directory = claimed.value.directory;
		if (claimed.value.claimed) break;
		const seen = await readSeen(box, directory, context);
		if (!seen.ok) return seen;
		const existing = seen.value.state;
		// A filled launcher that has not written its state yet is starting, not abandoned.
		if (existing === "none" && seen.value.gen !== "") return waitForStart(box, directory, context);
		if (existing !== "none" && !TERMINAL_PHASES.has(existing.phase)) {
			if (existing.phase === "starting") return waitForStart(box, directory, context);
			if (existing.phase !== "lost") return ok(existing);
			// Its launcher is gone and nothing in the box restarts it: start the supervisor again, which adopts the file.
			// Two callers that do so make one supervisor: it takes a lock before it looks for another.
			const revived = await runScript(
				box,
				'sh "$1/launcher.sh" start "$1"',
				[directory],
				context,
				CALL_TIMEOUT_MS,
				frame,
			);
			if (!revived.ok) return revived;
			const refused = refusalIn(revived.value.text);
			if (refused !== undefined) return err(refused);
			return waitForStart(box, directory, context);
		}
		const taken = await runScript(
			box,
			RECLAIM_SCRIPT,
			[directory, seen.value.gen, existing === "none" ? String(ABANDONED_CLAIM_S) : "0", token],
			context,
			CALL_TIMEOUT_MS * 2,
		);
		if (!taken.ok) return taken;
		const answer = taken.value.text.split("\n").find((line) => /^[A-Z]+$/.test(line));
		if (answer === "RECLAIMED") break;
		if (taken.value.exitCode !== 0)
			return err(
				new LaunchError(
					"failed",
					`could not clear the old launch ${name}: ${taken.value.text.trim().slice(0, 200)}`,
				),
			);
		if (Date.now() >= deadline)
			return err(new LaunchError("timeout", `the launch ${name} in box ${box.id} was not free within the limit`));
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	const uploaded = await box.upload(
		[
			{
				path: `${directory}/launcher.sh.part.${token}`,
				bytes: new TextEncoder().encode(LAUNCHER_SCRIPT),
				mode: 0o700,
			},
			{ path: `${directory}/spec.sh.part.${token}`, bytes: new TextEncoder().encode(specScript(spec, box.facts().isolation)), mode: 0o600 },
		],
		context,
	);
	if (!uploaded.ok) {
		await release(box, directory, token, context);
		return err(new LaunchError("box", `could not upload the launcher: ${uploaded.error.message}`, uploaded.error));
	}
	// The files appear under their names in one step, the script last: a caller that sees the script sees a whole launcher.
	const started = await runScript(
		box,
		// Only the holder publishes: a caller whose slow upload let another take the directory over finds its token gone.
		'[ "$(cat "$1/owner" 2>/dev/null)" = "$2" ] || { echo "the claim was taken over"; exit 5; }; mv "$1/spec.sh.part.$2" "$1/spec.sh" && mv "$1/launcher.sh.part.$2" "$1/launcher.sh" && sh "$1/launcher.sh" start "$1"',
		[directory, token],
		context,
		CALL_TIMEOUT_MS,
		frame,
	);
	if (!started.ok || started.value.exitCode !== 0) await release(box, directory, token, context);
	if (!started.ok) return started;
	if (started.value.exitCode !== 0)
		return err(
			refusalIn(started.value.text) ??
				new LaunchError("failed", `the launcher did not start: ${started.value.text.trim().slice(0, 200)}`),
		);
	return waitForStart(box, directory, context);
}

/** Give a claim back when the launch could not be filled, so that the next caller does not have to wait it out. */
async function release(box: Box, directory: string, token: string, context: Context): Promise<void> {
	await runScript(
		box,
		'[ "$(cat "$1/owner" 2>/dev/null)" = "$2" ] && [ ! -e "$1/launcher.sh" ] && rm -rf "$1"',
		[directory, token],
		context,
	);
}

/** The state of a launch, read from its state file. `undefined` when no launch of that name exists in the box. */
export async function launchStatus(
	box: Box,
	name: string,
	context: Context,
): Promise<Result<LaunchState | undefined, LaunchError>> {
	return launchState(box, { v: 1, name }, context);
}

/** The state of the launch `launch` names, as `launchStatus` reads it: `undefined` when the box has no such launch. */
export async function launchState(
	box: Box,
	launch: Launch,
	context: Context,
): Promise<Result<LaunchState | undefined, LaunchError>> {
	const invalid = handleError(launch);
	if (invalid !== undefined) return err(invalid);
	if (box.launcher !== undefined) return box.launcher.state(launch, context);
	const name = launch.name;
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
	if (state.value === "none")
		return ok({
			launch: { v: 1, name },
			phase: "starting",
			incarnation: 0,
			restarts: 0,
			starts: 0,
			since: 0,
			launcherAlive: false,
			directory,
		});
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
	return launchStop(box, { v: 1, name }, options, context);
}

/** Stops the launch `launch` names: the program's group gets SIGTERM, and after `graceMs` whatever is left gets SIGKILL. */
export async function launchStop(
	box: Box,
	launch: Launch,
	options: { readonly graceMs?: number } | undefined,
	context: Context,
): Promise<Result<LaunchState, LaunchError>> {
	const invalid = handleError(launch);
	if (invalid !== undefined) return err(invalid);
	if (box.launcher !== undefined) return box.launcher.stop(launch, options, context);
	const name = launch.name;
	const current = await launchStatus(box, name, context);
	if (!current.ok) return current;
	if (current.value === undefined) return err(new LaunchError("invalid", `no launch named ${name} in box ${box.id}`));
	const graceMs = options?.graceMs ?? DEFAULT_GRACE_MS;
	if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > MAX_GRACE_MS)
		return err(new LaunchError("invalid", `graceMs must be a number from 0 to ${MAX_GRACE_MS}`));
	const tenths = Math.ceil(graceMs / 100);
	// The call is given the grace period and the usual time on top: a call that ended inside the grace would leave the program
	// running with its supervisor already told to stop.
	const stopped = await runScript(
		box,
		'sh "$1/launcher.sh" stop "$1" "$2"',
		[current.value.directory, String(tenths)],
		context,
		// The grace, a stop hook at its longest, and the usual time on top.
		graceMs + MAX_HOOK_MS + CALL_TIMEOUT_MS,
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
