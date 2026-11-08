// The background tools on computerd: `bash_background` starts a command in a fresh shell (process.start) and answers at
// once with its id; `bash_output` reads its output in pages, from a byte offset (process.read); `bash_input` writes its
// stdin (process.write); `bash_signal` sends its process group TERM, INT or KILL (process.signal: INT on a terminal is
// Ctrl-C to its foreground job); `bash_list` lists them (process.list). computerd holds each process, its output (the
// last 8 MiB, read by offset) and how it ended, so nothing of theirs is kept in files and no call runs a script in the
// computer. A process's id is computerd's number for it ("p7" is 7); every call reaches only a process bash_background
// started (its shell's $0 says so), never one bash or anything else started in the computer.
//
// The shell waits for the jobs its command leaves running (a server started with &), so the process runs until they
// end too; when the shell exits, computerd's guard ends anything else it left. The run's end ends every one still
// running (endBackground: TERM, then KILL 3 s later), before the computer is released.
import { listProcesses } from "../processes.js";
import { type ComputerClient, PROCESS_RING_BYTES, type ProcessExit, type ProcessInfo } from "../protocol.js";
import { type ComputerError, fail, ok, type Result } from "../result.js";
import { SIGNAL_NAMES, SIGNAL_NUMBERS, type ShellToolDefinition, startShell, type ToolAnswer, WORKSPACE } from "./shell.js";

/** The most background processes that run at once in one run's computer. */
export const BACKGROUND_MAX = 8;
/** How much of a background process's output is kept: its last bytes, computerd's ring. */
export const BACKGROUND_LOG_BYTES = PROCESS_RING_BYTES;
/** The most bytes of output one `bash_output` call answers, and its default. */
export const BACKGROUND_PAGE_BYTES = 48 * 1024;
/** The most bytes one `bash_input` call writes. */
export const BACKGROUND_INPUT_BYTES = 64 * 1024;
/** The most processes `bash_list` names: every running one, then the newest that ended. */
export const BACKGROUND_LIST_MAX = 40;
/** The signals `bash_signal` sends. */
export const BACKGROUND_SIGNALS = ["TERM", "INT", "KILL"] as const;
/** The terminal a `tty: true` process runs on. */
export const BACKGROUND_TTY_SIZE = Object.freeze({ cols: 80, rows: 24 });
/** How long `bash_signal` waits for the process to end before it answers. */
const SIGNAL_WAIT_MS = 2_000;
/** How long the run's end waits after TERM before KILL. */
const END_GRACE_MS = 3_000;

/** The shell's script: stderr into stdout (one log, in order), the command, then the jobs it left running, then the
 *  command's own exit code. */
const SCRIPT = 'exec 2>&1; eval "$1"; c=$?; wait; exit $c';
/** $0 of a background process's shell: what tells one from any other process in the computer. */
export const BACKGROUND_MARKER = "agentrun-background";

const MIB = BACKGROUND_LOG_BYTES / (1024 * 1024);
const n = (value: number) => value.toLocaleString("en-US");

const ID_SCHEMA = { type: "string", pattern: "^[1-9][0-9]*$", description: 'The process\'s id, as bash_background answered it ("1").' };
const schema = (properties: Record<string, Record<string, unknown>>, required: string[]): ShellToolDefinition["parameters"] => ({ type: "object", additionalProperties: false, properties, required });

/** The background tools as a model is shown them, in BACKGROUND_TOOLS's order. */
export const BACKGROUND_TOOL_DEFINITIONS: readonly ShellToolDefinition[] = [
	{
		name: "bash_background",
		description: `Start a shell command in the background in the run's box, from the run's folder (${WORKSPACE}), and answer at once with its id. Each call is a fresh shell (bash, else sh). The command runs until it and every job it started with & (a server) have exited, bash_signal ends it, or the run ends, which ends it. Its stdout and stderr go together to its log, which bash_output reads: the last ${MIB} MiB of them, earlier output dropped while it runs on. Its stdin is a pipe that bash_input writes; tty: true gives it a terminal instead. At most ${BACKGROUND_MAX} run at once in a run's box. Read its output with bash_output, list them with bash_list.`,
		parameters: schema(
			{
				command: { type: "string", minLength: 1, description: "The command, as you would give bash." },
				tty: { type: "boolean", description: "Run it on a terminal (a pty), for a program that needs one: a prompt, a REPL, a progress display. Its log then holds what the terminal shows (your input echoed, lines ending in \\r\\n); bash_input types into the terminal, close: true types Ctrl-D, and bash_signal INT is Ctrl-C to its foreground job." },
			},
			["command"],
		),
	},
	{
		name: "bash_output",
		description: `Read a background process's output (stdout and stderr together) from a byte offset: at most max_bytes (default and most ${BACKGROUND_PAGE_BYTES / 1024} KiB), with whether it still runs, its exit code once it has ended, the log's size, and the offset to read from next. Start at 0; pass the next offset to read on, also to see what a running process wrote since.`,
		parameters: schema(
			{
				id: ID_SCHEMA,
				offset: { type: "integer", minimum: 0, description: "The byte to read from; 0, the start, when absent." },
				max_bytes: { type: "integer", minimum: 1, maximum: BACKGROUND_PAGE_BYTES, description: `The most bytes to read; ${n(BACKGROUND_PAGE_BYTES)} when absent.` },
			},
			["id"],
		),
		replay: "safe",
	},
	{
		name: "bash_input",
		description: `Write text to a running background process's stdin, as given (end a line with \\n), at most ${BACKGROUND_INPUT_BYTES / 1024} KiB a call. close: true closes its stdin after the text, so the process reads the end of its input. To interrupt it, send bash_signal INT; a control character written here is only a byte.`,
		parameters: schema(
			{
				id: ID_SCHEMA,
				text: { type: "string", description: "The bytes to write, as UTF-8; empty with close: true closes stdin alone." },
				close: { type: "boolean", description: "Close the process's stdin after the text." },
			},
			["id", "text"],
		),
	},
	{
		name: "bash_signal",
		description: "Send a signal to a background process's process group: TERM asks it to stop, INT is Ctrl-C, KILL ends it at once. Answers its state after up to 2 s: a process that handles the signal may run on.",
		parameters: schema({ id: ID_SCHEMA, signal: { type: "string", enum: [...BACKGROUND_SIGNALS], description: "TERM, INT or KILL." } }, ["id", "signal"]),
	},
	{
		name: "bash_list",
		description: `List this run's background processes: each one's id, whether it runs or how it ended, its output's size and its command's start, every running one first, then the newest that ended (${BACKGROUND_LIST_MAX} at most).`,
		parameters: schema({}, []),
		replay: "safe",
	},
];

type State = { state: "running" } | { state: "exited"; exit_code: number | null; signal?: string };

/** A process's state as computerd reports its end; an exit code past 128 is said as the signal it stands for. */
function stateOf(exit: ProcessExit): State {
	if (exit.running) return { state: "running" };
	const signal = exit.signal ?? (exit.exitCode !== null && exit.exitCode > 128 ? SIGNAL_NAMES[exit.exitCode - 128] : undefined);
	const code = exit.exitCode ?? (signal !== undefined && SIGNAL_NUMBERS[signal] !== undefined ? 128 + SIGNAL_NUMBERS[signal] : null);
	return { state: "exited", exit_code: code, ...(signal ? { signal } : {}) };
}

/** A state in words: `is running`, `exited with code 0`, `ended by signal TERM (exit code 143)`. */
function stateWords(state: State): string {
	if (state.state === "running") return "is running";
	if (state.signal) return `ended by signal ${state.signal}${state.exit_code !== null ? ` (exit code ${state.exit_code})` : ""}`;
	return `exited with code ${state.exit_code}`;
}

const noSuch = (id: string) => fail("not_found", `there is no background process ${id} in this run: bash_list shows them`);
/** A refusal of the computer's that no word of a call's explains. */
const unanswered = (error: ComputerError): Result<never> => fail(error.code, `the run's box did not answer: ${error.message}`);
const refuse = (message: string): Result<never> => fail("invalid", message);

/** A process's id as a call gives it: digits only. Its computerd id is "p" and the digits. */
function idOf(value: unknown): Result<string> {
	const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
	if (!/^[1-9][0-9]{0,8}$/.test(id)) return refuse(`${JSON.stringify(value)} is no background process id: an id is the number bash_background answered, such as "1" (bash_list shows them)`);
	return ok(id);
}

const intArg = (value: unknown, name: string, min: number, max: number, fallback: number): Result<number> => {
	if (value === undefined || value === null) return ok(fallback);
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return refuse(`${name} is a whole number from ${n(min)} to ${n(max)}`);
	return ok(value);
};

const isBackground = (info: ProcessInfo) => info.argv[3] === BACKGROUND_MARKER;
const streamOf = (info: ProcessInfo) => (info.pty ? "pty" : "stdout");
/** The command a background process runs, as its argv holds it (empty when a listing clipped it). */
const commandOf = (info: ProcessInfo) => info.argv[4] ?? "";

/** Background process `id` as computerd lists it, or not_found when computerd has none by that number or it is no
 *  background process. */
async function find(client: ComputerClient, id: string): Promise<Result<ProcessInfo>> {
	const page = await client.call("process.list", { from: Number(id) });
	if (!page.ok) return unanswered(page.error);
	const info = page.value.processes[0];
	return info !== undefined && info.id === `p${id}` && isBackground(info) ? ok(info) : noSuch(id);
}

/** Every background process of the computer, in start order. */
async function backgrounds(client: ComputerClient): Promise<Result<ProcessInfo[]>> {
	const listed = await listProcesses(client);
	return listed.ok ? ok(listed.value.filter(isBackground)) : unanswered(listed.error);
}

/** The end of `bytes` that ends inside a UTF-8 character, left for the next page: how many bytes to keep (none, when the
 *  page holds only part of one character). */
function wholeChars(bytes: Uint8Array): number {
	for (let back = 1; back <= Math.min(3, bytes.length); back++) {
		const byte = bytes[bytes.length - back]!;
		if ((byte & 0xc0) === 0x80) continue;
		const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return length > back ? bytes.length - back : bytes.length;
	}
	return bytes.length;
}

export interface BackgroundOptions {
	/** Where the command starts. Default the run's folder, /workspace. */
	cwd?: string;
}

/** bash_background: starts `command` (on a terminal with `tty: true`) and answers at once with its id. */
export async function bashBackground(client: ComputerClient, args: { command?: unknown; tty?: unknown }, options: BackgroundOptions = {}): Promise<Result<ToolAnswer>> {
	const command = typeof args.command === "string" ? args.command : "";
	const tty = args.tty === true;
	if (!command.trim()) return refuse("command is the shell command to start");
	const listed = await backgrounds(client);
	if (!listed.ok) return listed;
	const running = listed.value.filter((info) => info.running).length;
	if (running >= BACKGROUND_MAX) return fail("limit", `${running} background processes already run in this run's box, the most at once (${BACKGROUND_MAX}): end one with bash_signal (bash_list shows them), or wait for one to exit, then start this again.`);
	const started = await startShell(client, { script: SCRIPT, marker: BACKGROUND_MARKER, command, cwd: options.cwd ?? WORKSPACE, ...(tty ? { pty: { ...BACKGROUND_TTY_SIZE } } : { stdin: true }) });
	if (!started.ok) return fail(started.error.code, `the run's box did not start the process: ${started.error.message}`);
	const id = started.value.id.replace(/^p/, "");
	const { pid } = started.value;
	return ok({
		text: `Started background process ${id} (process group ${pid})${tty ? " on a terminal" : ""}. Read its output with bash_output {"id": "${id}"}, write its stdin with bash_input, end it with bash_signal.`,
		details: { id, pid, ...(tty ? { tty } : {}) },
	});
}

/** bash_output: at most `max_bytes` of a background process's output from byte `offset`, with its state. */
export async function bashOutput(client: ComputerClient, args: { id?: unknown; offset?: unknown; max_bytes?: unknown }): Promise<Result<ToolAnswer>> {
	const id = idOf(args.id);
	if (!id.ok) return id;
	const offset = intArg(args.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
	if (!offset.ok) return offset;
	const max = intArg(args.max_bytes, "max_bytes", 1, BACKGROUND_PAGE_BYTES, BACKGROUND_PAGE_BYTES);
	if (!max.ok) return max;
	const info = await find(client, id.value);
	if (!info.ok) return info;
	const state = stateOf(info.value);
	const stream = streamOf(info.value);
	const at = offset.value;
	const read = await client.call("process.read", { id: info.value.id, stream, offset: at, maxBytes: max.value });
	let size: number;
	let from = at;
	let page = new Uint8Array();
	if (read.ok) {
		size = read.value.size;
		from = at + read.value.dropped;
		page = new Uint8Array(Buffer.from(read.value.data, "base64"));
	} else {
		// computerd refuses a read past the end: its size, read from the start, says how far the log goes.
		const start = read.error.code === "invalid" ? await client.call("process.read", { id: info.value.id, stream, offset: 0, maxBytes: 1 }) : undefined;
		if (!start?.ok || start.value.size >= at) return unanswered(read.error);
		size = start.value.size;
	}
	// A character the page would split is left for the next one, unless the process has ended and nothing follows.
	const keep = state.state === "running" || from + page.length < size ? wholeChars(page) : page.length;
	// A page too small for the one character it starts with reads nothing, and says what to ask instead.
	if (keep === 0 && page.length > 0) return refuse(`the character at byte ${from} of background process ${id.value}'s output is longer than max_bytes ${max.value}: ask again with max_bytes 4 or more`);
	const bytes = page.subarray(0, keep);
	const next = from + bytes.length;
	const more = next < size;
	const where =
		from >= size && bytes.length === 0
			? `No output past byte ${n(from)} (the log has ${n(size)} bytes)${state.state === "running" ? "; call again later with the same offset for what comes next" : ""}.`
			: `Output bytes ${n(from)} to ${n(next)} of ${n(size)}${more ? `; call again with offset ${next} for the next part` : state.state === "running" ? `, all of it so far; call again with offset ${next} for what comes next` : ", the end"}.`;
	const dropped = from - at;
	const lost = dropped > 0 ? ` The log keeps the last ${MIB} MiB of output: bytes ${n(at)} to ${n(from)} were dropped before they were read.` : "";
	const text = new TextDecoder().decode(bytes);
	return ok({
		text: `Background process ${id.value} ${stateWords(state)}. ${where}${lost}${text ? `\n\n${text}` : ""}`,
		details: { id: id.value, ...state, offset: at, next_offset: next, size, ...(dropped > 0 ? { dropped } : {}) },
	});
}

/** bash_input: writes `text` to a running background process's stdin, then closes it with `close: true` (on a terminal,
 *  types Ctrl-D: a terminal has no stdin of its own to close). */
export async function bashInput(client: ComputerClient, args: { id?: unknown; text?: unknown; close?: unknown }): Promise<Result<ToolAnswer>> {
	const id = idOf(args.id);
	if (!id.ok) return id;
	const text = typeof args.text === "string" ? args.text : "";
	const bytes = Buffer.byteLength(text);
	if (bytes > BACKGROUND_INPUT_BYTES) return refuse(`text is at most ${BACKGROUND_INPUT_BYTES / 1024} KiB a call; send it in parts`);
	const close = args.close === true;
	if (!text && !close) return refuse("text is what to write: give some, or close: true to close stdin");
	const info = await find(client, id.value);
	if (!info.ok) return info;
	if (info.value.running !== true) return refuse(`background process ${id.value} ${stateWords(stateOf(info.value))}, so it takes no input`);
	// Ctrl-D at a line's start is the end of input; after a partial line, the first one ends the line.
	const eof = close && info.value.pty ? (text === "" || text.endsWith("\n") ? "\x04" : "\x04\x04") : "";
	const data = Buffer.from(text + eof);
	const wrote = await client.call("process.write", { id: info.value.id, ...(data.length > 0 ? { data: data.toString("base64") } : {}), ...(close && !info.value.pty ? { close } : {}) });
	if (!wrote.ok) {
		if (wrote.error.code === "timeout") return fail("timeout", `process ${id.value} did not take its input: ${wrote.error.message} (a process that does not read its stdin fills its pipe at 64 KiB)`);
		if (/stdin is closed/.test(wrote.error.message)) return refuse(`background process ${id.value}'s stdin is closed: an earlier bash_input closed it`);
		return fail(wrote.error.code, `process ${id.value} did not take its input: ${wrote.error.message}`);
	}
	return ok({
		text: `Wrote ${n(bytes)} bytes to background process ${id.value}'s stdin${close ? ", then closed it" : ""}. Read what it answers with bash_output.`,
		details: { id: id.value, bytes, ...(close ? { closed: true } : {}) },
	});
}

/** bash_signal: sends TERM, INT or KILL to a running background process's group, and answers its state after up to 2 s. */
export async function bashSignal(client: ComputerClient, args: { id?: unknown; signal?: unknown }): Promise<Result<ToolAnswer>> {
	const id = idOf(args.id);
	if (!id.ok) return id;
	const signal = typeof args.signal === "string" ? args.signal.trim().toUpperCase().replace(/^SIG/, "") : "";
	if (!(BACKGROUND_SIGNALS as readonly string[]).includes(signal)) return refuse(`signal is one of ${BACKGROUND_SIGNALS.join(", ")}`);
	const info = await find(client, id.value);
	if (!info.ok) return info;
	if (info.value.running !== true) return refuse(`background process ${id.value} ${stateWords(stateOf(info.value))}, so no signal was sent`);
	const sent = await client.call("process.signal", { id: info.value.id, signal: signal as (typeof BACKGROUND_SIGNALS)[number] });
	if (!sent.ok) return fail(sent.error.code, `${signal} was not sent to background process ${id.value}: ${sent.error.message}`);
	const ended = await client.call("process.wait", { id: info.value.id, timeoutMs: SIGNAL_WAIT_MS });
	if (!ended.ok) return unanswered(ended.error);
	const state = stateOf(ended.value);
	const note = sent.value.note ? ` (${sent.value.note})` : "";
	return ok({
		text: `Sent ${signal} to background process ${id.value}${note}: it ${stateWords(state)}.${state.state === "running" ? " Send KILL to end it at once." : ""}`,
		details: { id: id.value, signal, ...state },
	});
}

/** bash_list: every running background process, then the newest that ended, BACKGROUND_LIST_MAX at most. */
export async function bashList(client: ComputerClient): Promise<Result<ToolAnswer>> {
	const listed = await backgrounds(client);
	if (!listed.ok) return listed;
	const all = [...listed.value].sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
	const shown = [...all.filter((info) => info.running), ...all.filter((info) => !info.running)].slice(0, BACKGROUND_LIST_MAX);
	if (shown.length === 0) return ok({ text: "No background processes in this run's box: bash_background starts one.", details: { processes: [] } });
	const sizes = await Promise.all(shown.map(async (info) => {
		const read = await client.call("process.read", { id: info.id, stream: streamOf(info), offset: 0, maxBytes: 1 });
		return read.ok ? read.value.size : 0;
	}));
	const processes = shown.map((info, i) => ({
		id: info.id.slice(1),
		...stateOf(info),
		size: sizes[i]!,
		started: new Date(info.startedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
		...(info.pty ? { tty: true } : {}),
		command: commandOf(info),
	}));
	const running = all.filter((info) => info.running).length;
	const lines = processes.map((p) => `${p.id}: ${stateWords(p)}; ${n(p.size)} bytes of output; started ${p.started}; ${JSON.stringify(p.command.replace(/\s+/g, " ").slice(0, 120))}${p.tty ? " (tty)" : ""}`);
	const left = all.length - shown.length;
	return ok({ text: `${running} of at most ${BACKGROUND_MAX} running.\n${lines.join("\n")}${left > 0 ? `\n(and ${left} older ones that ended)` : ""}`, details: { running, processes } });
}

/** The run's end: TERM to every background process still running, KILL to each one still running 3 s later. How many it
 *  ended. Call it before the computer is released, so each ends as a signal ends it rather than with the computer. */
export async function endBackground(client: ComputerClient): Promise<Result<number>> {
	const listed = await backgrounds(client);
	if (!listed.ok) return listed;
	const running = listed.value.filter((info) => info.running);
	for (const info of running) await client.call("process.signal", { id: info.id, signal: "TERM" });
	const after = await Promise.all(running.map((info) => client.call("process.wait", { id: info.id, timeoutMs: END_GRACE_MS })));
	const left = running.filter((_, i) => !after[i]!.ok || after[i]!.value.running);
	for (const info of left) await client.call("process.signal", { id: info.id, signal: "KILL" });
	await Promise.all(left.map((info) => client.call("process.wait", { id: info.id, timeoutMs: END_GRACE_MS })));
	return ok(running.length);
}
