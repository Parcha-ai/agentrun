// The run's hands, as the registry's tools reach them: Workspace(run) on the host's side (a folder on this machine, the
// run's Archil disk, or an attached computer), given to each call. The kernel never knows which.
import { constants } from "node:os";
import type { ToolImage } from "../../types.js";

/** How one exec ended: its exit code, or the signal that ended it (exitCode null), and whether its timeout did. */
export type ExecResult = { readonly exitCode: number | null; readonly signal: string | null; readonly timedOut: boolean };

/** The exit code a shell would report: the code, or 128 + n for signal n (any signal the system names); undefined when
 *  it is not known. */
export function exitCodeOf(result: ExecResult): number | undefined {
  if (result.exitCode !== null) return result.exitCode;
  if (result.signal === null) return undefined;
  const n = (constants.signals as Readonly<Record<string, number | undefined>>)[`SIG${result.signal.replace(/^SIG/, "")}`];
  return n === undefined ? undefined : 128 + n;
}

/** A process the computer runs, as the background tools read it: its argv (which marks a background one), whether it
 *  runs, how it ended, when it started, and whether it has a terminal. */
export type ProcessInfo = {
  readonly handle: string;
  readonly argv: readonly string[];
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly pty: boolean;
};

/** The computer's processes, as the five background tools use them, and nothing more. A refusal throws an error with a
 *  `code` ("not_found", "invalid", "denied", ...) and the computer's words. Paths are the run's folder's. */
export type Processes = {
  /** Starts `argv` in `cwd`; its stdout and stderr go to `log` (the first 16 MiB, made never through a link); the
   *  process runs until it and its group (on a terminal, its session) have ended, and what leaves the group is kept. */
  start(spec: { readonly argv: readonly string[]; readonly cwd: string; readonly log: string; readonly waitGroup: true; readonly orphans: "keep"; readonly stdin?: true; readonly pty?: { readonly cols: number; readonly rows: number } }): Promise<{ handle: string; pid: number }>;
  /** At most `maxBytes` of its log from `offset`, the log's size, and whether output past the cap was dropped. A read
   *  past the end is refused ("invalid"). */
  read(handle: string, range: { readonly offset: number; readonly maxBytes: number }): Promise<{ data: Uint8Array; size: number; capped: boolean }>;
  write(handle: string, input: { readonly data?: Uint8Array; readonly close?: true }): Promise<void>;
  /** The signal to its group; on a terminal, INT to its foreground job. `note`: what the computer adds to say. */
  signal(handle: string, name: "TERM" | "INT" | "KILL"): Promise<{ note?: string }>;
  list(): Promise<readonly ProcessInfo[]>;
};

/** A computer's kind past files and a shell: each adds its own tools to the run's (defs.ts capabilityToolDefs). */
export type CapabilityKind = "desktop" | "phone" | "browser";

/** A kind's tool refused in a run whose computer is not of that kind (or lacks the port): the words name the setting. */
export const needsKindWords = (tool: string, kind: CapabilityKind): string =>
  `${tool} needs a ${kind} computer: set this agent's computer to ${kind} (Settings → Computers).`;

/** A screenshot as a tool's answer: the words, and the PNG in the answer's images. */
export const shotAnswer = (text: string, shot: Shot): ToolAnswer => ({ text, images: [{ mimeType: "image/png", data: Buffer.from(shot.png.buffer, shot.png.byteOffset, shot.png.byteLength).toString("base64") }] });

/** A point in a screenshot's pixels, origin top left, as computerd's input.actions takes it. */
export type ScreenPoint = readonly [x: number, y: number];

/** A screenshot: its PNG's bytes, and its size in pixels (the coordinates input takes). */
export type Shot = { readonly png: Uint8Array; readonly width: number; readonly height: number };

/** A desktop's screen (computerd's screen.shot): the whole screen, or a region of it in the whole screen's pixels. */
export type Screen = { shot(options?: { readonly region?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } }): Promise<Shot> };

/** One action of a desktop's input, as computerd's input.actions takes it: the pointer's and the keyboard's, and
 *  nothing more. A key is a name of computerd's key table or one printable ASCII character. */
export type InputAction =
  | { readonly type: "move"; readonly at: ScreenPoint }
  | { readonly type: "click"; readonly at?: ScreenPoint; readonly button?: "left" | "right" | "middle"; readonly count?: 1 | 2 | 3 }
  | { readonly type: "drag"; readonly path: readonly ScreenPoint[]; readonly button?: "left" | "right" | "middle" }
  | { readonly type: "scroll"; readonly at?: ScreenPoint; readonly dx?: number; readonly dy?: number; readonly unit: "clicks" | "px" }
  | { readonly type: "type"; readonly text: string }
  | { readonly type: "key"; readonly keys: readonly string[] };

/** A desktop's input (computerd's input.actions): the batch runs in order; a refusal throws its code and words. */
export type Input = { actions(list: readonly InputAction[]): Promise<void> };

/** A point on a phone's screen, in its screenshot's pixels. */
export type PhonePoint = { readonly x: number; readonly y: number };

/** A node of a phone screen's structure, flattened: its platform class, its id, text and label where it has them, its
 *  bounds in screenshot pixels, and whether a model can tap it or type into it. */
export type PhoneNode = {
  readonly role: string;
  readonly id?: string;
  readonly text?: string;
  readonly label?: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly clickable: boolean;
  readonly editable: boolean;
  readonly focused?: boolean;
  /** A node with no text or label of its own, named by its first inner text (else label): an Android list row, a
   *  clickable layout whose title sits on a child that is not clickable. */
  readonly inner?: string;
};

/** A key a phone presses: its back and home buttons, and enter. */
export type PhoneKey = "back" | "home" | "enter";

/** A phone: its screen and the screen's structure, a tap, a swipe, typing into the field in focus, its keys, and its apps. */
export type Phone = {
  shot(): Promise<Shot>;
  /** The screen's structure, flattened (`total` the nodes the phone gave, `truncated` when it gave only part); absent on a
   *  phone that does not offer it. */
  tree?(): Promise<{ readonly nodes: readonly PhoneNode[]; readonly total: number; readonly truncated: boolean }>;
  tap(at: PhonePoint): Promise<void>;
  swipe(spec: { readonly from: PhonePoint; readonly to: PhonePoint; readonly durationMs: number }): Promise<void>;
  type(text: string): Promise<void>;
  /** Absent on a phone that does not offer its keys. */
  key?(name: PhoneKey): Promise<void>;
  readonly apps: {
    list(): Promise<{ readonly apps: readonly { readonly id: string; readonly name?: string }[]; readonly foreground: string | null }>;
    open(id: string): Promise<void>;
  };
};

/** A connection to a browser's DevTools protocol (pi-browser's CdpLink, in shape). */
export type CdpSession = {
  send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(listener: (event: { method?: string; params?: unknown; sessionId?: string }) => void): () => void;
  close(): void;
};

/** A browser computer: a connection to its CDP. The browser's tools and take-over are the host's (pi-browser's). */
export type Browser = { connect(): Promise<CdpSession> };

/** The agent's hand-over of a desktop or a phone to the person, through the run's hold: ask opens it (what the person is
 *  to do, how both will know it is done, when it expires, ISO time) and resolves with its first answer, or expired. An
 *  abort of `signal` (a stop, a lost claim) rejects it. */
export type Handoff = {
  ask(request: { readonly instruction: string; readonly completion_condition: string; readonly expires_at: string }, signal?: AbortSignal): Promise<{ readonly outcome: "done" | "cancelled" | "expired" }>;
};

/** What a host tool does with the run's files and shell. */
export type Hands = {
  /** The longest one exec may run, in seconds: 600 locally and on a computer, 295 on Archil's exec. */
  readonly maxExecS: number;
  stat(path: string): Promise<{ kind: "file" | "dir" | "link"; size: number; mtimeMs: number } | undefined>;
  read(path: string, range?: { offset?: number; length?: number }): Promise<Uint8Array>;
  /** Durable when it returns. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  append(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<readonly { name: string; kind: "file" | "dir" | "link"; size: number }[]>;
  grep(pattern: string, path: string, options?: { glob?: string; ignoreCase?: boolean; maxMatches?: number }): Promise<string>;
  /** `command` run by the run's shell (`bash -c`, a fixed minimal env) in the run's folder, stdin /dev/null, for at most
   *  `timeoutS`: its exit code, or the signal that ended it, and whether the timeout did. An abort throws. */
  exec(command: string, options: { timeoutS: number; onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void }, signal?: AbortSignal): Promise<ExecResult>;
  /** The attached computer's processes; absent with no computer, where the background tools are refused. */
  readonly processes?: Processes;
  /** A desktop's screen and input; absent where the computer has none, and their tools are refused in words. */
  readonly screen?: Screen;
  readonly input?: Input;
  /** A phone's screen, touch, typing and apps; absent where the computer is no phone. */
  readonly phone?: Phone;
  /** A browser's CDP; absent where the computer is no browser. */
  readonly browser?: Browser;
  /** A desktop's or a phone's hand-over to the person (the run's hold); absent where there is none. */
  readonly handoff?: Handoff;
};

/** A tool's answer: the text the model reads (and its images), with details for the run's timeline. A failure is an
 *  answer too: `error` holds its words, apart from the output, so what the call printed before it failed is kept. The
 *  host shows `[text, error, ...diagnostics' messages].join("\n\n")`. Only an abort throws. */
export type ToolAnswer = {
  readonly text: string;
  readonly error?: string;
  readonly images?: readonly ToolImage[];
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly diagnostics?: readonly { readonly severity: "info" | "warn" | "error"; readonly code?: string; readonly message: string }[];
};

/** One call's world: the run's hands, the call's signal, where output streamed while it runs goes, and (passed through,
 *  unread by the kernel) the call's model, whose image limits a host's read may use. */
export type ToolCall = { readonly hands: Hands; readonly signal?: AbortSignal; output?(chunk: string): void; readonly model?: unknown };

/** An executor's failure as an answer: an abort (the call's signal aborted) throws; any other error is its words. */
export async function answerOf(call: ToolCall, run: () => Promise<ToolAnswer>): Promise<ToolAnswer> {
  try {
    return await run();
  } catch (error) {
    if (call.signal?.aborted) throw call.signal.reason ?? error;
    return { text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** A host tool's run. */
export type Executor = (args: unknown, call: ToolCall) => Promise<ToolAnswer>;

/** What the host gives the registry, by tool name: read, write and edit, and bash's own run, which the registry bounds;
 *  and, for a browser, its tools' runs (pi-browser's, over hands.browser), by tool name. */
export type HostExecutors = Readonly<Partial<Record<"read" | "write" | "edit" | "bash", Executor>>> & { readonly browser?: Readonly<Record<string, Executor>> };
