// The background tools on computerd: `bash_background` starts a command in a fresh shell (process.start) and answers at
// once with its id; `bash_output` reads its output in pages, from a byte offset (process.read of its log); `bash_input`
// writes its stdin (process.write); `bash_signal` sends its process group TERM, INT or KILL (process.signal: INT on a
// terminal is Ctrl-C to its foreground job); `bash_list` lists them (process.list). No call runs a script of its own in
// the computer.
//
// A process's id is the run's own: the first number with no folder of its name in work/background/ and no background
// process of this computer's. Its shell's argv carries it, after the shell's $0, which marks the process as a background
// one: every call reaches only those, never one bash or anything else started in the computer. computerd writes the
// first 16 MiB of its stdout and stderr to work/background/<id>/output.log, a file it makes itself and never through a
// link (process.start's log), and bash_output reads them from computerd's own open file, never by the path. computerd
// runs the process until it and every process left in its group (on a terminal, its session) have ended, with the
// shell's own exit (waitGroup), and keeps what left the group running to the computer's end (orphans keep). The run's
// end ends every one still running (endBackground: TERM, then KILL 3 s later), before the computer is released.
//
// On a mounted run's folder the log is a write like any other, synced by the mount's own rule.
import { listProcesses } from "../processes.js";
import { type ComputerClient, PROCESS_LOG_BYTES, type ProcessExit, type ProcessInfo } from "../protocol.js";
import { type ComputerError, fail, ok, type Result } from "../result.js";
import { SIGNAL_NAMES, SIGNAL_NUMBERS, type ShellToolDefinition, startShell, type ToolAnswer, WORKSPACE } from "./shell.js";

/** The most background processes that run at once in one run's computer. */
export const BACKGROUND_MAX = 8;
/** The most bytes of output one background process's log keeps: later output is dropped, and the process runs on. */
export const BACKGROUND_LOG_BYTES = PROCESS_LOG_BYTES;
/** The most bytes of output one `bash_output` call answers, and its default. */
export const BACKGROUND_PAGE_BYTES = 48 * 1024;
/** The most bytes one `bash_input` call writes. */
export const BACKGROUND_INPUT_BYTES = 64 * 1024;
/** The most processes `bash_list` names: every running one, then the newest that ended. */
export const BACKGROUND_LIST_MAX = 40;
/** Where a background process's log lives, under the run's folder. */
export const BACKGROUND_DIR = "background";
/** The signals `bash_signal` sends. */
export const BACKGROUND_SIGNALS = ["TERM", "INT", "KILL"] as const;
/** The terminal a `tty: true` process runs on. */
export const BACKGROUND_TTY_SIZE = Object.freeze({ cols: 80, rows: 24 });
/** How long `bash_signal` waits for the process to end before it answers. */
const SIGNAL_WAIT_MS = 2_000;
/** How long the run's end waits after TERM before KILL. */
const END_GRACE_MS = 3_000;

/** The shell's script: stderr into stdout (one stream, in order), then the command. $1 is the id, $2 the command. */
const SCRIPT = 'exec 2>&1; eval "$2"';
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
		description: `Start a shell command in the background in the run's box, from its work/, and answer at once with its id. Each call is a fresh shell (bash, else sh). The command runs until it and every child it left in its process group (a server started with &) have exited, bash_signal ends it, or the run ends, which ends it. Its stdout and stderr go together to work/${BACKGROUND_DIR}/<id>/output.log, which the run's files keep: the first ${MIB} MiB of them, later output dropped while it runs on. Its stdin is a pipe that bash_input writes; tty: true gives it a terminal instead. At most ${BACKGROUND_MAX} run at once in a run's box. Read its output with bash_output, list them with bash_list.`,
		parameters: schema(
			{
				command: { type: "string", minLength: 1, description: "The command, as you would give bash." },
				tty: { type: "boolean", description: "Run it on a terminal (a pty, through script in the box), for a program that needs one: a prompt, a REPL, a progress display. Its log then holds what the terminal shows (your input echoed, lines ending in \\r\\n); bash_input types into the terminal, and bash_signal INT is Ctrl-C to its foreground job." },
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
const linkDir = () => refuse(`work/${BACKGROUND_DIR} is a link, so no background process starts: remove it, and its logs go in a directory of their own again`);

/** A process's id as a call gives it: digits only, so no call names a path. */
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

const isBackground = (info: ProcessInfo) => info.argv[3] === BACKGROUND_MARKER && /^[1-9][0-9]*$/.test(info.argv[4] ?? "");
/** A background process's id, as its argv holds it. */
const idIn = (info: ProcessInfo) => info.argv[4]!;
/** The command a background process runs, as its argv holds it (empty when a listing clipped it). */
const commandOf = (info: ProcessInfo) => info.argv[5] ?? "";
/** The log of background process `id`, under the run's folder, as the answers name it. */
const logOf = (id: string) => `${BACKGROUND_DIR}/${id}/output.log`;

/** Every background process of the computer, in start order. */
async function backgrounds(client: ComputerClient): Promise<Result<ProcessInfo[]>> {
	const listed = await listProcesses(client);
	return listed.ok ? ok(listed.value.filter(isBackground)) : unanswered(listed.error);
}

/** Background process `id`, the newest by that id, or not_found when there is none. */
async function find(client: ComputerClient, id: string): Promise<Result<ProcessInfo>> {
	const listed = await backgrounds(client);
	if (!listed.ok) return listed;
	const info = listed.value.findLast((one) => idIn(one) === id);
	return info ? ok(info) : noSuch(id);
}

/** The bytes the log of `info` holds so far, and whether output past them was dropped; undefined when it cannot be read. */
async function logSize(client: ComputerClient, info: ProcessInfo): Promise<{ size: number; capped: boolean } | undefined> {
	const read = await client.call("process.read", { id: info.id, stream: "log", offset: 0, maxBytes: 1 });
	return read.ok ? { size: read.value.size, capped: read.value.capped === true } : undefined;
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
	/** The run's folder: where the command starts, and its log goes under. Default /workspace. */
	cwd?: string;
}

/** The last start in flight on each client: a start waits for it, so the cap's count, the id it picks and the start
 *  are one step, and nine starts at once on one client start eight. Starts on another client (another process attached
 *  to the same computer) are not held by this. */
const starting = new WeakMap<ComputerClient, Promise<unknown>>();

/** Runs `step` once every start before it on `client` has settled. */
function inTurn<T>(client: ComputerClient, step: () => Promise<T>): Promise<T> {
	const turn = (starting.get(client) ?? Promise.resolve()).then(step, step);
	starting.set(client, turn.catch(() => undefined));
	return turn;
}

/** The numbers taken in the run's work/background/ (any entry named by digits, a link or a file too), or a link
 *  refusal when the folder itself is a link. */
async function takenIn(client: ComputerClient, dir: string): Promise<Result<Set<string>>> {
	const taken = new Set<string>();
	const stat = await client.call("files.stat", { path: dir });
	if (!stat.ok) return stat.error.code === "not_found" ? ok(taken) : unanswered(stat.error);
	if (stat.value.type === "symlink") return linkDir();
	if (stat.value.type !== "dir") return ok(taken);
	for (let offset = 0; ; ) {
		const page = await client.call("files.list", { path: dir, offset });
		if (!page.ok) return unanswered(page.error);
		for (const entry of page.value.entries) {
			const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
			if (/^[1-9][0-9]*$/.test(name)) taken.add(name);
		}
		if (!page.value.truncated || page.value.entries.length === 0) return ok(taken);
		offset += page.value.entries.length;
	}
}

/** bash_background: starts `command` (on a terminal with `tty: true`) and answers at once with its id. */
export async function bashBackground(client: ComputerClient, args: { command?: unknown; tty?: unknown }, options: BackgroundOptions = {}): Promise<Result<ToolAnswer>> {
	const command = typeof args.command === "string" ? args.command : "";
	const tty = args.tty === true;
	if (!command.trim()) return refuse("command is the shell command to start");
	const folder = options.cwd ?? WORKSPACE;
	const dir = `${folder}/${BACKGROUND_DIR}`;
	const started = await inTurn(client, async () => {
		const listed = await backgrounds(client);
		if (!listed.ok) return listed;
		const running = listed.value.filter((info) => info.running).length;
		if (running >= BACKGROUND_MAX) return fail("limit", `${running} background processes already run in this run's box, the most at once (${BACKGROUND_MAX}): end one with bash_signal (bash_list shows them), or wait for one to exit, then start this again.`);
		const taken = await takenIn(client, dir);
		if (!taken.ok) return taken;
		for (const info of listed.value) taken.value.add(idIn(info));
		let id = 1;
		while (taken.value.has(String(id))) id++;
		const shell = await startShell(client, {
			script: SCRIPT,
			marker: BACKGROUND_MARKER,
			args: [String(id), command],
			cwd: folder,
			log: `${dir}/${id}/output.log`,
			waitGroup: true,
			orphans: "keep",
			...(tty ? { pty: { ...BACKGROUND_TTY_SIZE } } : { stdin: true }),
		});
		if (shell.ok) return ok({ id: String(id), pid: shell.value.pid });
		if (shell.error.code === "denied" && shell.error.message.startsWith(`${dir} is a link`)) return linkDir();
		return fail(shell.error.code, `the run's box did not start the process: ${shell.error.message}`);
	});
	if (!started.ok) return started;
	const { id, pid } = started.value;
	const log = logOf(id);
	return ok({
		text: `Started background process ${id} (process group ${pid})${tty ? " on a terminal" : ""}. Its output goes to ${log} in work/: read it with bash_output {"id": "${id}"}, write its stdin with bash_input, end it with bash_signal.`,
		details: { id, log, pid, ...(tty ? { tty } : {}) },
	});
}

/** bash_output: at most `max_bytes` of a background process's log from byte `offset`, with its state. */
export async function bashOutput(client: ComputerClient, args: { id?: unknown; offset?: unknown; max_bytes?: unknown }): Promise<Result<ToolAnswer>> {
	const id = idOf(args.id);
	if (!id.ok) return id;
	const offset = intArg(args.offset, "offset", 0, BACKGROUND_LOG_BYTES, 0);
	if (!offset.ok) return offset;
	const max = intArg(args.max_bytes, "max_bytes", 1, BACKGROUND_PAGE_BYTES, BACKGROUND_PAGE_BYTES);
	if (!max.ok) return max;
	const info = await find(client, id.value);
	if (!info.ok) return info;
	const state = stateOf(info.value);
	const at = offset.value;
	const read = await client.call("process.read", { id: info.value.id, stream: "log", offset: at, maxBytes: max.value });
	let size: number;
	let capped: boolean;
	let page = new Uint8Array();
	if (read.ok) {
		size = read.value.size;
		capped = read.value.capped === true;
		page = new Uint8Array(Buffer.from(read.value.data, "base64"));
	} else {
		// computerd refuses a read past the log's end: its size says how far the log goes.
		const whole = read.error.code === "invalid" ? await logSize(client, info.value) : undefined;
		if (!whole || whole.size >= at) return unanswered(read.error);
		({ size, capped } = whole);
	}
	// A character the page would split is left for the next one, unless the process has ended and nothing follows.
	const keep = state.state === "running" || at + page.length < size ? wholeChars(page) : page.length;
	// A page too small for the one character it starts with reads nothing, and says what to ask instead.
	if (keep === 0 && page.length > 0) return refuse(`the character at byte ${at} of background process ${id.value}'s output is longer than max_bytes ${max.value}: ask again with max_bytes 4 or more`);
	const bytes = page.subarray(0, keep);
	const next = at + bytes.length;
	const more = next < size;
	const where =
		at >= size && bytes.length === 0
			? `No output past byte ${n(at)} (the log has ${n(size)} bytes)${state.state === "running" ? "; call again later with the same offset for what comes next" : ""}.`
			: `Output bytes ${n(at)} to ${n(next)} of ${n(size)}${more ? `; call again with offset ${next} for the next part` : state.state === "running" ? `, all of it so far; call again with offset ${next} for what comes next` : ", the end"}.`;
	const cap = capped ? ` Its log reached the ${MIB} MiB cap, so later output was dropped.` : "";
	const text = new TextDecoder().decode(bytes);
	return ok({
		text: `Background process ${id.value} ${stateWords(state)}. ${where}${cap}${text ? `\n\n${text}` : ""}`,
		details: { id: id.value, ...state, offset: at, next_offset: next, size, ...(capped ? { capped } : {}) },
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
	const all = [...listed.value].sort((a, b) => Number(idIn(b)) - Number(idIn(a)));
	const shown = [...all.filter((info) => info.running), ...all.filter((info) => !info.running)].slice(0, BACKGROUND_LIST_MAX);
	if (shown.length === 0) return ok({ text: "No background processes in this run's box: bash_background starts one.", details: { processes: [] } });
	const sizes = await Promise.all(shown.map((info) => logSize(client, info)));
	const processes = shown.map((info, i) => ({
		id: idIn(info),
		...stateOf(info),
		size: sizes[i]?.size ?? 0,
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
