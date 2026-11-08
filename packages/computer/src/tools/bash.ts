// The bash tool on computerd: a command runs in a fresh shell in the computer (process.start), its output read as it
// comes (process.read) until it ends or its timeout, when it is killed with everything it started (process.signal KILL
// to its group; computerd's guard ends every process the shell left). The timeout is 120 s by default and at most
// 600 s: a call asking more runs at 600 s and says so. The answer keeps the end of the output, 2000 lines or 50 KB,
// as pi's bash does, and saves the whole of a longer one to a file in the computer, named in a diagnostic.
import { randomBytes } from "node:crypto";
import { type ComputerClient, MAX_CHUNK_BYTES, MAX_READ_WAIT_MS } from "../protocol.js";
import { fail, ok, type Result } from "../result.js";
import { SIGNAL_NUMBERS, type ShellToolDefinition, startShell, WORKSPACE } from "./shell.js";

/** bash's timeout, in seconds: the default when a call names none, and the most any call gets. A command that needs
 *  longer is a background process (bash_background). */
export const BASH_DEFAULT_TIMEOUT_S = 120;
export const BASH_MAX_TIMEOUT_S = 600;
/** The end of the output an answer keeps: its last lines, or its last bytes, whichever is less. */
export const BASH_MAX_LINES = 2000;
export const BASH_MAX_BYTES = 50 * 1024;
/** Where the whole of an output longer than that is saved, in the computer. */
export const BASH_SPILL_DIR = "/tmp/agentrun-bash";

/** The shell's script: stderr into stdout, so they come as one stream, in order; then the command. */
const SCRIPT = 'exec 2>&1; eval "$1"';
/** $0 of a bash call's shell. */
const MARKER = "agentrun-bash";
/** How long, after a kill, the rest of the output is read before the answer goes without it. */
const AFTER_KILL_MS = 10_000;

const TIMEOUT_WORDS = `Timeout in seconds: ${BASH_DEFAULT_TIMEOUT_S} s by default, at most ${BASH_MAX_TIMEOUT_S} s; for longer work use bash_background.`;
const capWords = (asked: number) => `bash runs a command for at most ${BASH_MAX_TIMEOUT_S} s: this one ran with ${BASH_MAX_TIMEOUT_S} s, not the ${asked} s asked. For longer work use bash_background.`;

/** The bash tool as a model is shown it: pi's bash, with its timeout's default and ceiling said. */
export const BASH_TOOL: ShellToolDefinition = {
	name: "bash",
	description: `Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${BASH_MAX_LINES} lines or ${BASH_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. Each command is stopped after ${BASH_DEFAULT_TIMEOUT_S} s by default, at most ${BASH_MAX_TIMEOUT_S} s; for longer work use bash_background.`,
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Bash command to execute" },
			timeout: { type: "number", description: TIMEOUT_WORDS },
		},
		required: ["command"],
	},
};

export interface BashOptions {
	command: string;
	/** The tool's timeout, in milliseconds (its `timeout` in seconds, times 1000). Default 120 s; more than 600 s runs at 600 s. */
	timeoutMs?: number;
	/** Where the command starts. Default the run's folder, /workspace. */
	cwd?: string;
	/** Ends the call: the command is killed, and the call answers `aborted`. */
	signal?: AbortSignal;
	/** The output as it comes, decoded as UTF-8. */
	onOutput?: (text: string) => void;
}

export interface BashDiagnostic {
	severity: "info" | "warn";
	code: "full_output" | "truncated" | "timeout_capped";
	message: string;
}

export interface BashResult {
	/** computerd's id for the command's process. */
	id: string;
	/** stdout and stderr together, as they came: the last BASH_MAX_LINES lines, at most BASH_MAX_BYTES bytes. */
	output: string;
	/** null when a signal ended the shell. */
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	/** The call's error for a model, when it is one: "Command exited with code 3", "Command timed out after 120 seconds". */
	error?: string;
	/** In order: the file the whole output was saved to, what the answer dropped of it, a timeout cut to the ceiling. */
	diagnostics: BashDiagnostic[];
	/** The timeout the command ran with. */
	timeoutMs: number;
}

const NEWLINE = 0x0a;

/** How many lines `bytes` holds: its newlines, and one more for a last line with none. */
function lineCount(bytes: Uint8Array): number {
	if (bytes.length === 0) return 0;
	let newlines = 0;
	for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) newlines++;
	return newlines + (bytes[bytes.length - 1] === NEWLINE ? 0 : 1);
}

/** Where the end an answer keeps starts in `bytes`: whole lines within the limits, or the end of one line too long alone,
 *  from a character's start (pi's tail window). */
function tailStart(bytes: Uint8Array): number {
	const last = bytes[bytes.length - 1] === NEWLINE ? bytes.length - 2 : bytes.length - 1;
	let start = 0;
	let lines = 1;
	for (let at = last < 0 ? -1 : bytes.lastIndexOf(NEWLINE, last); at !== -1; ) {
		if (lines === BASH_MAX_LINES) {
			start = at + 1;
			break;
		}
		lines++;
		at = at === 0 ? -1 : bytes.lastIndexOf(NEWLINE, at - 1);
	}
	if (bytes.length - start > BASH_MAX_BYTES) {
		const from = bytes.length - BASH_MAX_BYTES;
		const newline = bytes.indexOf(NEWLINE, from - 1);
		if (newline !== -1 && newline + 1 < bytes.length) return newline + 1;
		let at = from;
		while (at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80) at++;
		return at;
	}
	return start;
}

/** The output of one call: the end of it held for the answer, counts of the whole, and the whole of it saved to a file in
 *  the computer once it is longer than the answer keeps. */
class Output {
	/** The output's last bytes: the window the answer is cut from, and the byte before it. */
	private held = Buffer.alloc(0);
	/** Everything until the output passes the limits, then nothing: it is in the file. */
	private early: Buffer[] = [];
	private total = 0;
	private newlines = 0;
	private lastByte = NEWLINE;
	private spilling = false;
	private spillFailed = false;
	path?: string;

	constructor(
		private readonly client: ComputerClient,
		private readonly id: string,
	) {}

	async add(bytes: Buffer, dropped: number): Promise<void> {
		this.total += dropped + bytes.length;
		if (bytes.length === 0) return;
		for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) this.newlines++;
		this.lastByte = bytes[bytes.length - 1]!;
		const both = Buffer.concat([this.held, bytes]);
		this.held = both.subarray(Math.max(0, both.length - BASH_MAX_BYTES - 1));
		if (this.spillFailed) return;
		if (this.spilling) return this.save(bytes, true);
		this.early.push(bytes);
		if (this.total <= BASH_MAX_BYTES && this.lines() <= BASH_MAX_LINES) return;
		this.spilling = true;
		this.path = `${BASH_SPILL_DIR}/${this.id}-${randomBytes(6).toString("hex")}.log`;
		const whole = Buffer.concat(this.early);
		this.early = [];
		await this.save(whole, false);
	}

	/** Writes `bytes` to the file, in pieces a request line holds; a write the computer refuses ends the saving. */
	private async save(bytes: Buffer, append: boolean): Promise<void> {
		for (let at = 0, first = !append; at < bytes.length || first; at += MAX_CHUNK_BYTES, first = false) {
			const piece = bytes.subarray(at, at + MAX_CHUNK_BYTES);
			const wrote = await this.client.call("files.write", { path: this.path!, data: piece.toString("base64"), ...(first ? { parents: true, mode: 0o600 } : { append: true }) });
			if (!wrote.ok) {
				this.spillFailed = true;
				this.path = undefined;
				return;
			}
		}
	}

	private lines(): number {
		return this.total === 0 ? 0 : this.newlines + (this.lastByte === NEWLINE ? 0 : 1);
	}

	/** The answer's output, and what it dropped of the whole. */
	end(): { text: string; droppedBytes: number; droppedLines: number } {
		const kept = this.held.subarray(tailStart(this.held));
		return { text: new TextDecoder().decode(kept), droppedBytes: this.total - kept.length, droppedLines: Math.max(0, this.lines() - lineCount(kept)) };
	}
}

/**
 * Runs `command` in a fresh shell in the computer, from `cwd` (the run's folder by default), with stdin closed, and
 * answers when it ends or its timeout kills it. A non-zero exit and a timeout are answers with `error` set, as pi's
 * bash makes them the call's error with its output; a refusal of the call itself (an empty command, a timeout that is
 * no number of seconds, a computer that refuses the start or is gone) is a failed result.
 */
export async function bash(client: ComputerClient, options: BashOptions): Promise<Result<BashResult>> {
	const { command, signal: abort, onOutput } = options;
	if (typeof command !== "string" || !command.trim()) return fail("invalid", "command is the shell command to run");
	const asked = options.timeoutMs;
	if (asked !== undefined && (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0)) return fail("invalid", "Invalid timeout: must be a finite number of seconds");
	const capped = asked !== undefined && asked > BASH_MAX_TIMEOUT_S * 1000;
	const timeoutMs = asked === undefined ? BASH_DEFAULT_TIMEOUT_S * 1000 : Math.min(asked, BASH_MAX_TIMEOUT_S * 1000);
	if (abort?.aborted) return fail("aborted", "Command aborted");
	const started = await startShell(client, { script: SCRIPT, marker: MARKER, args: [command], cwd: options.cwd ?? WORKSPACE });
	if (!started.ok) return started;
	const { id } = started.value;
	const output = new Output(client, id);
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let killedAt: number | undefined;
	let timedOut = false;
	const kill = async () => {
		killedAt = Date.now();
		await client.call("process.signal", { id, signal: "KILL" });
	};
	let offset = 0;
	for (;;) {
		if (abort?.aborted) {
			await kill();
			return fail("aborted", "Command aborted");
		}
		if (killedAt === undefined && Date.now() >= deadline) {
			timedOut = true;
			await kill();
		}
		if (killedAt !== undefined && Date.now() - killedAt > AFTER_KILL_MS) break;
		const waitMs = killedAt === undefined ? Math.min(MAX_READ_WAIT_MS, Math.max(1, Math.ceil(deadline - Date.now()))) : 1000;
		const read = await client.call("process.read", { id, stream: "stdout", offset, waitMs }, { signal: abort });
		if (!read.ok) {
			if (abort?.aborted) continue;
			return read;
		}
		const bytes = Buffer.from(read.value.data, "base64");
		await output.add(bytes, read.value.dropped);
		if (bytes.length > 0) onOutput?.(decoder.decode(bytes, { stream: true }));
		offset = read.value.nextOffset;
		if (read.value.exited) break;
	}
	const ended = await client.call("process.wait", { id, timeoutMs: 5_000 });
	if (!ended.ok) return ended;
	const { exitCode, signal } = ended.value;
	const { text, droppedBytes, droppedLines } = output.end();
	const diagnostics: BashDiagnostic[] = [];
	if (output.path) diagnostics.push({ severity: "info", code: "full_output", message: `Full output: ${output.path}` });
	if (droppedBytes > 0) diagnostics.push({ severity: "warn", code: "truncated", message: `Output truncated to its end: ${droppedLines} lines, ${droppedBytes} bytes dropped` });
	const askedS = (asked ?? 0) / 1000;
	if (capped && !timedOut) diagnostics.push({ severity: "warn", code: "timeout_capped", message: capWords(askedS) });
	const code = exitCode ?? (signal && SIGNAL_NUMBERS[signal] !== undefined ? 128 + SIGNAL_NUMBERS[signal] : null);
	const error = timedOut
		? `Command timed out after ${timeoutMs / 1000} seconds${capped ? `. ${capWords(askedS)}` : ""}`
		: code === null
			? `Command ended by signal ${signal}`
			: code !== 0
				? `Command exited with code ${code}`
				: undefined;
	return ok({ id, output: text, exitCode, signal, timedOut, ...(error ? { error } : {}), diagnostics, timeoutMs });
}
