// The background tools on the computer's processes (hands.processes; the computer module's reference behaviour):
// `bash_background` starts a command in a fresh shell and answers at once with its id; `bash_output` reads its output
// in pages, from a byte offset, from the computer's own log; `bash_input` writes its stdin; `bash_signal` sends its
// process group TERM, INT or KILL (INT on a terminal is Ctrl-C to its foreground job); `bash_list` lists them. No call
// runs a script of its own on the computer, and none reads a file by path.
//
// A process's id is the run's own: the first number with no entry of its name in work/background/ and no background
// process of this computer's. Its shell's argv carries it after the shell's $0, which marks the process as a background
// one: every call reaches only those, never one bash or anything else started on the computer. The computer writes the
// first 16 MiB of its stdout and stderr to work/background/<id>/output.log, a file it makes itself and never through a
// link, runs the process until it and every process left in its group have ended, and keeps what left the group
// running. The run's end ends every one still running (endBackground: TERM, then KILL 3 s later). With no computer the
// five tools are refused in words: a process left on the owner's machine is what that refusal prevents.
import { answerOf, type Executor, type Hands, type ProcessInfo, type Processes, type ToolAnswer } from "./hands.js";
import { BACKGROUND_DIR, BACKGROUND_INPUT_BYTES, BACKGROUND_LIST_MAX, BACKGROUND_LOG_BYTES, BACKGROUND_MAX, BACKGROUND_PAGE_BYTES, BACKGROUND_SIGNALS } from "./limits.js";

/** Every background tool's refusal with no computer (Mode 1 or Mode 2), as ruled. */
export const NEEDS_A_COMPUTER = "Background programs need a computer: run this agent with place sandbox (Docker in Mode 1, or a remote computer in Mode 2).";
/** The terminal a `tty: true` process runs on. */
const TTY_SIZE = Object.freeze({ cols: 80, rows: 24 });
/** How long `bash_signal` waits for the process to end before it answers. */
const SIGNAL_WAIT_MS = 2_000;
/** How long the run's end waits after TERM before KILL, and after KILL. */
const END_GRACE_MS = 3_000;
/** The shell's script: stderr into stdout (one stream, in order), then the command. $1 is the id, $2 the command. */
const SCRIPT = 'exec 2>&1; eval "$2"';
/** $0 of a background process's shell: what tells one from any other process on the computer. */
const MARKER = "agentrun-background";
/** Each signal's number, for an exit code past 128, and back. */
const SIGNAL_NAMES: Readonly<Record<number, string>> = { 1: "HUP", 2: "INT", 3: "QUIT", 6: "ABRT", 9: "KILL", 13: "PIPE", 14: "ALRM", 15: "TERM" };
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = Object.fromEntries(Object.entries(SIGNAL_NAMES).map(([n, name]) => [name, Number(n)]));

const MIB = BACKGROUND_LOG_BYTES / (1024 * 1024);
const n = (value: number) => value.toLocaleString("en-US");
const codeOf = (error: unknown): string | undefined => (error as { code?: unknown } | null)?.code as string | undefined;
const wordsOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type State = { state: "running" } | { state: "exited"; exit_code: number | null; signal?: string };

/** A process's state as the computer reports its end; an exit code past 128 is said as the signal it stands for. */
function stateOf(info: ProcessInfo): State {
  if (info.running) return { state: "running" };
  const signal = info.signal ?? (info.exitCode !== null && info.exitCode > 128 ? SIGNAL_NAMES[info.exitCode - 128] : undefined);
  const code = info.exitCode ?? (signal !== undefined && SIGNAL_NUMBERS[signal] !== undefined ? 128 + SIGNAL_NUMBERS[signal]! : null);
  return { state: "exited", exit_code: code, ...(signal ? { signal } : {}) };
}

/** A state in words: `is running`, `exited with code 0`, `ended by signal TERM (exit code 143)`. */
function stateWords(state: State): string {
  if (state.state === "running") return "is running";
  if (state.signal) return `ended by signal ${state.signal}${state.exit_code !== null ? ` (exit code ${state.exit_code})` : ""}`;
  return `exited with code ${state.exit_code}`;
}

const noSuch = (id: string) => new Error(`there is no background process ${id} in this run: bash_list shows them`);
/** A refusal of the computer's that no word of a call's explains. */
const unanswered = (error: unknown) => new Error(`the run's box did not answer: ${wordsOf(error)}`);
const linkDir = () => new Error(`work/${BACKGROUND_DIR} is a link, so no background process starts: remove it, and its logs go in a directory of their own again`);

/** A process's id as a call gives it: digits only, so no call names a path. */
function idOf(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9][0-9]{0,8}$/.test(id)) throw new Error(`${JSON.stringify(value)} is no background process id: an id is the number bash_background answered, such as "1" (bash_list shows them)`);
  return id;
}

const intArg = (value: unknown, name: string, min: number, max: number, fallback: number): number => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is a whole number from ${n(min)} to ${n(max)}`);
  return value;
};

/** The trust rule: a background process's shell has the marker as $0 (argv[3]) and a numeric id as $1 (argv[4]). */
const isBackground = (info: ProcessInfo) => info.argv[3] === MARKER && /^[1-9][0-9]*$/.test(info.argv[4] ?? "");
const idIn = (info: ProcessInfo) => info.argv[4]!;
const commandOf = (info: ProcessInfo) => info.argv[5] ?? "";
const logOf = (id: string) => `${BACKGROUND_DIR}/${id}/output.log`;

/** Every background process of the computer, in start order. */
async function backgrounds(processes: Processes): Promise<ProcessInfo[]> {
  try {
    return (await processes.list()).filter(isBackground);
  } catch (error) {
    throw unanswered(error);
  }
}

/** Background process `id`, the newest by that id. */
async function find(processes: Processes, id: string): Promise<ProcessInfo> {
  const info = (await backgrounds(processes)).findLast((one) => idIn(one) === id);
  if (!info) throw noSuch(id);
  return info;
}

/** The bytes the log of `info` holds so far, and whether output past them was dropped; undefined when it cannot be read. */
async function logSize(processes: Processes, info: ProcessInfo): Promise<{ size: number; capped: boolean } | undefined> {
  try {
    const read = await processes.read(info.handle, { offset: 0, maxBytes: 1 });
    return { size: read.size, capped: read.capped };
  } catch {
    return undefined;
  }
}

/** `handle`'s state once it has ended, or after `ms`, whichever is first. */
async function settled(processes: Processes, handle: string, ms: number): Promise<ProcessInfo | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const info = (await processes.list()).find((one) => one.handle === handle);
    if (!info || !info.running || Date.now() >= end) return info;
    await sleep(50);
  }
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

/** The last start in flight on each computer's processes: a start waits for it, so the cap's count, the id it picks and
 *  the start are one step, and nine starts at once start eight. */
const starting = new WeakMap<Processes, Promise<unknown>>();
function inTurn<T>(processes: Processes, step: () => Promise<T>): Promise<T> {
  const turn = (starting.get(processes) ?? Promise.resolve()).then(step, step);
  starting.set(processes, turn.catch(() => undefined));
  return turn;
}

/** The numbers taken in the run's work/background/ (any entry named by digits), or a link refusal when the folder is a
 *  link. */
async function takenIn(hands: Hands): Promise<Set<string>> {
  const taken = new Set<string>();
  const stat = await hands.stat(BACKGROUND_DIR).catch((error: unknown) => Promise.reject(unanswered(error)));
  if (stat === undefined) return taken;
  if (stat.kind === "link") throw linkDir();
  if (stat.kind !== "dir") return taken;
  for (const entry of await hands.list(BACKGROUND_DIR).catch((error: unknown) => Promise.reject(unanswered(error)))) {
    if (/^[1-9][0-9]*$/.test(entry.name)) taken.add(entry.name);
  }
  return taken;
}

/** The shell `argv` starts, bash first, sh where the computer has no bash. */
async function startShell(processes: Processes, args: readonly string[], spec: Omit<Parameters<Processes["start"]>[0], "argv">): Promise<{ handle: string; pid: number }> {
  try {
    return await processes.start({ ...spec, argv: ["bash", "-c", SCRIPT, MARKER, ...args] });
  } catch (error) {
    if (codeOf(error) !== "not_found") throw error;
    return processes.start({ ...spec, argv: ["sh", "-c", SCRIPT, MARKER, ...args] });
  }
}

const bashBackground = async (processes: Processes, args: unknown, hands: Hands): Promise<ToolAnswer> => {
  const given = args as { command?: unknown; tty?: unknown };
  const command = typeof given.command === "string" ? given.command : "";
  const tty = given.tty === true;
  if (!command.trim()) throw new Error("command is the shell command to start");
  const { id, pid } = await inTurn(processes, async () => {
    const listed = await backgrounds(processes);
    const running = listed.filter((info) => info.running).length;
    if (running >= BACKGROUND_MAX) throw new Error(`${running} background processes already run in this run's box, the most at once (${BACKGROUND_MAX}): end one with bash_signal (bash_list shows them), or wait for one to exit, then start this again.`);
    const taken = await takenIn(hands);
    for (const info of listed) taken.add(idIn(info));
    let next = 1;
    while (taken.has(String(next))) next++;
    try {
      const shell = await startShell(processes, [String(next), command], { cwd: ".", log: logOf(String(next)), waitGroup: true, orphans: "keep", ...(tty ? { pty: { ...TTY_SIZE } } : { stdin: true as const }) });
      return { id: String(next), pid: shell.pid };
    } catch (error) {
      if (codeOf(error) === "denied" && / is a link/.test(wordsOf(error))) throw linkDir();
      throw new Error(`the run's box did not start the process: ${wordsOf(error)}`);
    }
  });
  const log = logOf(id);
  return { text: `Started background process ${id} (process group ${pid})${tty ? " on a terminal" : ""}. Its output goes to ${log} in work/: read it with bash_output {"id": "${id}"}, write its stdin with bash_input, end it with bash_signal.`, details: { id, log, pid, ...(tty ? { tty } : {}) } };
};

const bashOutput = async (processes: Processes, args: unknown): Promise<ToolAnswer> => {
  const given = args as { id?: unknown; offset?: unknown; max_bytes?: unknown };
  const id = idOf(given.id);
  const at = intArg(given.offset, "offset", 0, BACKGROUND_LOG_BYTES, 0);
  const max = intArg(given.max_bytes, "max_bytes", 1, BACKGROUND_PAGE_BYTES, BACKGROUND_PAGE_BYTES);
  const info = await find(processes, id);
  const state = stateOf(info);
  let size: number;
  let capped: boolean;
  let page: Uint8Array = new Uint8Array();
  try {
    const read = await processes.read(info.handle, { offset: at, maxBytes: max });
    ({ size, capped } = read);
    page = read.data;
  } catch (error) {
    // The computer refuses a read past the log's end: its size says how far the log goes.
    const whole = codeOf(error) === "invalid" ? await logSize(processes, info) : undefined;
    if (!whole || whole.size >= at) throw unanswered(error);
    ({ size, capped } = whole);
  }
  // A character the page would split is left for the next one, unless the process has ended and nothing follows.
  const keep = state.state === "running" || at + page.length < size ? wholeChars(page) : page.length;
  // A page too small for the one character it starts with reads nothing, and says what to ask instead.
  if (keep === 0 && page.length > 0) throw new Error(`the character at byte ${at} of background process ${id}'s output is longer than max_bytes ${max}: ask again with max_bytes 4 or more`);
  const bytes = page.subarray(0, keep);
  const next = at + bytes.length;
  const more = next < size;
  const where = at >= size && bytes.length === 0
    ? `No output past byte ${n(at)} (the log has ${n(size)} bytes)${state.state === "running" ? "; call again later with the same offset for what comes next" : ""}.`
    : `Output bytes ${n(at)} to ${n(next)} of ${n(size)}${more ? `; call again with offset ${next} for the next part` : state.state === "running" ? `, all of it so far; call again with offset ${next} for what comes next` : ", the end"}.`;
  const cap = capped ? ` Its log reached the ${MIB} MiB cap, so later output was dropped.` : "";
  const text = new TextDecoder().decode(bytes);
  return { text: `Background process ${id} ${stateWords(state)}. ${where}${cap}${text ? `\n\n${text}` : ""}`, details: { id, ...state, offset: at, next_offset: next, size, ...(capped ? { capped } : {}) } };
};

const bashInput = async (processes: Processes, args: unknown): Promise<ToolAnswer> => {
  const given = args as { id?: unknown; text?: unknown; close?: unknown };
  const id = idOf(given.id);
  const text = typeof given.text === "string" ? given.text : "";
  const bytes = Buffer.byteLength(text);
  if (bytes > BACKGROUND_INPUT_BYTES) throw new Error(`text is at most ${BACKGROUND_INPUT_BYTES / 1024} KiB a call; send it in parts`);
  const close = given.close === true;
  if (!text && !close) throw new Error("text is what to write: give some, or close: true to close stdin");
  const info = await find(processes, id);
  if (!info.running) throw new Error(`background process ${id} ${stateWords(stateOf(info))}, so it takes no input`);
  // Ctrl-D at a line's start is the end of input; after a partial line, the first one ends the line.
  const eof = close && info.pty ? (text === "" || text.endsWith("\n") ? "\x04" : "\x04\x04") : "";
  const data = new Uint8Array(Buffer.from(text + eof));
  try {
    await processes.write(info.handle, { ...(data.length > 0 ? { data } : {}), ...(close && !info.pty ? { close: true as const } : {}) });
  } catch (error) {
    if (/stdin is closed/.test(wordsOf(error))) throw new Error(`background process ${id}'s stdin is closed: an earlier bash_input closed it`);
    throw new Error(`process ${id} did not take its input: ${wordsOf(error)} (a process that does not read its stdin fills its pipe at 64 KiB)`);
  }
  return { text: `Wrote ${n(bytes)} bytes to background process ${id}'s stdin${close ? ", then closed it" : ""}. Read what it answers with bash_output.`, details: { id, bytes, ...(close ? { closed: true } : {}) } };
};

const bashSignal = async (processes: Processes, args: unknown): Promise<ToolAnswer> => {
  const given = args as { id?: unknown; signal?: unknown };
  const id = idOf(given.id);
  const signal = typeof given.signal === "string" ? given.signal.trim().toUpperCase().replace(/^SIG/, "") : "";
  if (!(BACKGROUND_SIGNALS as readonly string[]).includes(signal)) throw new Error(`signal is one of ${BACKGROUND_SIGNALS.join(", ")}`);
  const info = await find(processes, id);
  if (!info.running) throw new Error(`background process ${id} ${stateWords(stateOf(info))}, so no signal was sent`);
  let note: string | undefined;
  try {
    ({ note } = await processes.signal(info.handle, signal as (typeof BACKGROUND_SIGNALS)[number]));
  } catch (error) {
    throw new Error(`${signal} was not sent to background process ${id}: ${wordsOf(error)}`);
  }
  const after = await settled(processes, info.handle, SIGNAL_WAIT_MS).catch((error: unknown) => Promise.reject(unanswered(error)));
  const state = after ? stateOf(after) : ({ state: "running" } as State);
  return { text: `Sent ${signal} to background process ${id}${note ? ` (${note})` : ""}: it ${stateWords(state)}.${state.state === "running" ? " Send KILL to end it at once." : ""}`, details: { id, signal, ...state } };
};

const bashList = async (processes: Processes): Promise<ToolAnswer> => {
  const all = [...(await backgrounds(processes))].sort((a, b) => Number(idIn(b)) - Number(idIn(a)));
  const shown = [...all.filter((info) => info.running), ...all.filter((info) => !info.running)].slice(0, BACKGROUND_LIST_MAX);
  if (shown.length === 0) return { text: "No background processes in this run's box: bash_background starts one.", details: { processes: [] } };
  const sizes = await Promise.all(shown.map((info) => logSize(processes, info)));
  const listed = shown.map((info, i) => ({
    id: idIn(info),
    ...stateOf(info),
    size: sizes[i]?.size ?? 0,
    started: new Date(info.startedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(info.pty ? { tty: true } : {}),
    command: commandOf(info),
  }));
  const running = all.filter((info) => info.running).length;
  const lines = listed.map((p) => `${p.id}: ${stateWords(p)}; ${n(p.size)} bytes of output; started ${p.started}; ${JSON.stringify(p.command.replace(/\s+/g, " ").slice(0, 120))}${p.tty ? " (tty)" : ""}`);
  const left = all.length - shown.length;
  return { text: `${running} of at most ${BACKGROUND_MAX} running.\n${lines.join("\n")}${left > 0 ? `\n(and ${left} older ones that ended)` : ""}`, details: { running, processes: listed } };
};

/** A background tool's run: refused in words where the run has no computer's processes. */
const onProcesses = (name: string, run: (processes: Processes, args: unknown, hands: Hands) => Promise<ToolAnswer>): Executor => (args, call) => answerOf(call, async () => {
  call.signal?.throwIfAborted();
  const processes = call.hands.processes;
  if (!processes) throw new Error(NEEDS_A_COMPUTER);
  return run(processes, args, call.hands);
});

/** The background tools' executors, by name. */
export const BACKGROUND_EXECUTORS: Readonly<Record<string, Executor>> = {
  bash_background: onProcesses("bash_background", bashBackground),
  bash_output: onProcesses("bash_output", bashOutput),
  bash_input: onProcesses("bash_input", bashInput),
  bash_signal: onProcesses("bash_signal", bashSignal),
  bash_list: onProcesses("bash_list", (processes) => bashList(processes)),
};

/** The run's end: TERM to every background process still running, KILL to each one still running 3 s later. How many it
 *  ended; with no computer's processes, none. Call it before the computer is released. */
export async function endBackground(hands: Hands): Promise<number> {
  const processes = hands.processes;
  if (!processes) return 0;
  const running = (await backgrounds(processes)).filter((info) => info.running);
  for (const info of running) await processes.signal(info.handle, "TERM").catch(() => undefined);
  const after = await Promise.all(running.map((info) => settled(processes, info.handle, END_GRACE_MS).catch(() => undefined)));
  const left = running.filter((_, i) => after[i] === undefined || after[i]!.running);
  for (const info of left) await processes.signal(info.handle, "KILL").catch(() => undefined);
  await Promise.all(left.map((info) => settled(processes, info.handle, END_GRACE_MS).catch(() => undefined)));
  return running.length;
}
