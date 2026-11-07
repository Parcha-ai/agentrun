// The daemon's methods: the one shared definition on the TypeScript side (daemon/internal/methods is the Go side).
// JSON-RPC 2.0, one UTF-8 JSON object per line, in both directions.
import type { Result } from "./result.js";

/** The longest line, in bytes without its newline, either side reads or writes. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** The most bytes exec.run keeps of each stream: two full streams, in base64, fit one reply line. */
export const MAX_OUTPUT_BYTES = 360 * 1024;
/** The notification that cancels a request by id (as in LSP). */
export const CANCEL_METHOD = "$/cancelRequest";
/** The most bytes one files.read or tar.pull.read returns: in base64, it fits a line. */
export const MAX_CHUNK_BYTES = 512 * 1024;
/** The deepest files.list walks, and the most entries one reply holds. */
export const MAX_LIST_DEPTH = 16;
export const MAX_LIST_ENTRIES = 1000;
/** How much of each stream a process keeps: the last 8 MiB, read by byte offset. */
export const PROCESS_RING_BYTES = 8 * 1024 * 1024;
/** How many processes a daemon holds, running or ended; the oldest ended ones are dropped first. */
export const MAX_PROCESSES = 256;
/**
 * How much output a daemon's rings hold together. Past it, the rings of the processes that ended first are let go (a
 * read then reports their bytes as dropped); a running process's ring is never let go.
 */
export const PROCESS_RETAINED_BYTES = 256 * 1024 * 1024;
/** The longest a process.read waits for new bytes. */
export const MAX_READ_WAIT_MS = 30_000;

/** What a computer is: the shape its tools take. Kind sets which groups are Core. */
export type ComputerKind = "linux" | "desktop" | "android" | "ios";

/** The platform a computer runs, which the key table and exec need. */
export type ComputerOs = "linux" | "windows" | "macos" | "android" | "ios";

/**
 * What a computer offers, as one flat list: capabilities().groups, repeated in hello.groups. A sub-flag such as
 * input.touch is its own entry. Each is optional unless kind makes it Core.
 */
export type Group = "exec" | "files" | "processes" | "screen" | "input.pointer" | "input.keys" | "input.touch" | "apps" | "apps.install" | "apps.ui_tree";

/** Every group, in the order the protocol lists them. */
export const GROUPS: readonly Group[] = ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "input.touch", "apps", "apps.install", "apps.ui_tree"];

export interface HelloParams {
	/** Who is asking, for the daemon's log: a name and version. */
	client: string;
}

export interface HelloResult {
	version: string;
	os: ComputerOs;
	kind: ComputerKind;
	/** Go's name for the architecture: amd64, arm64. */
	arch: string;
	groups: Group[];
}

export type PingParams = Record<string, never>;
export type PingResult = Record<string, never>;

export interface ExecRunParams {
	/** The program and its arguments. Never a shell: a shell is the caller's choice (["sh", "-c", "..."]). */
	argv: string[];
	/** Absolute, or relative to the user's home. Default: the daemon's working directory. */
	cwd?: string;
	/** Added over a minimal default (PATH, HOME, USER, LOGNAME); nothing else of the daemon's environment is passed. */
	env?: Record<string, string>;
	/** A user name, or uid[:gid]. A daemon that cannot switch users answers `denied`. */
	user?: string;
	timeoutMs: number;
	/** Bytes kept of each stream; default and most MAX_OUTPUT_BYTES. */
	maxOutput?: number;
}

export interface ExecRunResult {
	/** null when a signal ended the program. */
	exitCode: number | null;
	/** The signal that ended it, without SIG, such as "KILL". */
	signal?: string;
	/** base64. */
	stdout: string;
	/** base64. */
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
}

/** Paths are absolute; the daemon cleans them. A relative path is `invalid`. */
export interface FilesReadParams {
	path: string;
	offset?: number;
	/** Default and most MAX_CHUNK_BYTES; more is refused as `limit`. */
	length?: number;
}

export interface FilesReadResult {
	/** base64. */
	data: string;
	eof: boolean;
	/** The file's size when it was read. */
	size: number;
}

export interface FilesWriteParams {
	path: string;
	/** base64; the request line holds at most 1 MiB. */
	data: string;
	/** Write here without truncating. With neither offset nor append, the file is replaced. */
	offset?: number;
	append?: boolean;
	/** Set when given (0o7777 bits), else 0o644 for a new file. */
	mode?: number;
	/** Make missing parent directories. */
	parents?: boolean;
}

export interface FilesWriteResult {
	size: number;
}

export type FileType = "file" | "dir" | "symlink" | "other";

export interface FileStat {
	type: FileType;
	size: number;
	/** The permission bits, with setuid, setgid and sticky: 0o7777. */
	mode: number;
	mtimeMs: number;
	uid: number;
	gid: number;
	/** A symlink's target, as written. */
	target?: string;
}

export interface FilesStatParams {
	path: string;
	/** Follow a symlink at path. Default false: a symlink is reported as one. */
	follow?: boolean;
}

export interface FileEntry extends FileStat {
	path: string;
}

export interface FilesListParams {
	/** A directory; a symlink to one is followed. Symlinks below it are listed, never entered. */
	path: string;
	/** Default 1, most MAX_LIST_DEPTH. */
	depth?: number;
	/** Skip this many entries: pass the count already read to get the next page. */
	offset?: number;
}

export interface FilesListResult {
	/** In walk order: each directory's entries by name, a directory before what it holds. */
	entries: FileEntry[];
	/** More entries follow: list again with offset + entries.length. */
	truncated: boolean;
}

export interface FilesMkdirParams {
	path: string;
	/** Make missing parents, and accept a directory already there. */
	parents?: boolean;
	/** Default 0o755. */
	mode?: number;
}

export interface FilesMoveParams {
	from: string;
	to: string;
	/** Replace what is at `to`, as rename(2) does: a file, or an empty directory. */
	overwrite?: boolean;
}

export interface FilesRemoveParams {
	path: string;
	/** Remove a directory and everything in it. A symlink is removed, never followed. */
	recursive?: boolean;
}

export interface TarPullBeginParams {
	/** A file (one entry, its name) or a directory (entries relative to it). */
	path: string;
}

export interface TarPullBeginResult {
	id: string;
}

export interface TarPullReadParams {
	id: string;
	/** Default and most MAX_CHUNK_BYTES; more is refused as `limit`. */
	maxBytes?: number;
}

export interface TarPullReadResult {
	/** base64: maxBytes of the archive, fewer only at its end. */
	data: string;
	eof: boolean;
}

export interface TarPullEndParams {
	/** Ending a pull that is not open is fine. */
	id: string;
}

export interface TarPushBeginParams {
	/** The directory to extract into; made, with its parents, when missing. */
	path: string;
}

export interface TarPushBeginResult {
	id: string;
}

export interface TarPushWriteParams {
	id: string;
	/** base64. Send the next write after this one's reply: writes are extracted in the order they arrive. */
	data: string;
}

export interface TarPushEndParams {
	id: string;
}

export interface TarPushEndResult {
	/** How many entries were extracted. */
	entries: number;
}

/** A terminal's size in characters. */
export interface PtySize {
	cols: number;
	rows: number;
}

export interface ProcessStartParams {
	/** The program and its arguments, never a shell string. */
	argv: string[];
	cwd?: string;
	/** Added over the same minimal default as exec.run's. */
	env?: Record<string, string>;
	user?: string;
	/** Run in a terminal of this size: one "pty" stream, and the program's own session with it as the controlling terminal. */
	pty?: PtySize;
	/** Keep stdin open for process.write. Without it (and without a pty), stdin is /dev/null. */
	stdin?: boolean;
}

export interface ProcessStartResult {
	/** The daemon's name for the process, such as "p1". */
	id: string;
	/** The program's pid in the computer. */
	pid: number;
}

export type ProcessStream = "stdout" | "stderr" | "pty";

export interface ProcessReadParams {
	id: string;
	/** "stdout" or "stderr"; "pty" for a process started with one. */
	stream: ProcessStream;
	/** Bytes since the process started. Pass the last read's nextOffset. */
	offset: number;
	/** Default and most MAX_CHUNK_BYTES; more is refused as `limit`. */
	maxBytes?: number;
	/** When nothing past offset is there yet, wait up to this long (most MAX_READ_WAIT_MS) for bytes or the end. */
	waitMs?: number;
}

export interface ProcessReadResult {
	/** base64. */
	data: string;
	nextOffset: number;
	/**
	 * Bytes before offset the ring no longer held: the read began at the ring's start instead. Once an ended process's
	 * ring is let go, every byte from offset on.
	 */
	dropped: number;
	/** The process has ended and nothing is left past nextOffset. */
	exited: boolean;
}

export interface ProcessWriteParams {
	id: string;
	/** base64, to stdin or the terminal. */
	data?: string;
	/** Close stdin after the data. A terminal has no stdin to close: send "\x04" or signal HUP. */
	close?: boolean;
}

export type ProcessSignal = "TERM" | "INT" | "KILL" | "HUP";

export interface ProcessSignalParams {
	id: string;
	/** Sent to the program's process group. A signal to a process that has ended does nothing. */
	signal: ProcessSignal;
}

export interface ProcessResizeParams extends PtySize {
	id: string;
}

export interface ProcessExit {
	running: boolean;
	/** null while running, or when a signal ended it. */
	exitCode: number | null;
	/** The signal that ended it, without SIG: "TERM", "KILL". */
	signal: string | null;
}

export interface ProcessInfo extends ProcessExit {
	id: string;
	pid: number;
	argv: string[];
	/** argv was cut to its first arguments to keep the listing small. */
	argvClipped: boolean;
	pty: boolean;
	/** Milliseconds since the epoch. */
	startedAt: number;
	endedAt: number | null;
}

export interface ProcessListParams {
	/** Where the page starts: the page before's next, or 0 (the default) for the first page. */
	from?: number;
}

export interface ProcessListResult {
	/** In start order. */
	processes: ProcessInfo[];
	/** More follow: list again with from: next. */
	truncated: boolean;
	/** Where the page after this one starts. A process dropped from the table between pages moves no other past it. */
	next: number;
}

export interface ProcessWaitParams {
	id: string;
	/** How long to wait for the end, up to a day; 0 asks without waiting. On timeout, running is true. */
	timeoutMs: number;
}

export type Empty = Record<string, never>;

/** Pixels of the full screenshot, origin top left. A region shot never changes this space. */
export type Point = [x: number, y: number];
export type Rect = [x: number, y: number, w: number, h: number];
export type Button = "left" | "right" | "middle";

export interface ScreenShotParams {
	/** Only this part of the screen; its coordinates stay those of the full screenshot. */
	region?: Rect;
}

export interface ScreenShotResult {
	/** The shot's id, for screen.read. */
	id: string;
	/** The PNG's bytes; data holds at most MAX_CHUNK_BYTES of it. */
	size: number;
	/** base64; read the rest with screen.read. */
	data: string;
	eof: boolean;
	/** The image's pixels: the input coordinate space (never downscaled). */
	width: number;
	height: number;
	/** Device pixels per logical point: 1 on Xvfb; a phone reports its own. */
	scale: number;
	/** Where the pointer is, with input.pointer. */
	cursor?: Point;
}

/** One shot is held; it is dropped at eof or at the next shot. */
export interface ScreenReadParams {
	id: string;
	offset: number;
}

export interface ScreenReadResult {
	/** base64. */
	data: string;
	eof: boolean;
}

/** The most actions one input.actions batch holds. */
export const MAX_ACTIONS = 100;
/** The most wait and hold one batch asks for, summed (Anthropic's 300 s cap). */
export const MAX_BATCH_WAIT_MS = 300_000;
/** The one canonical key table. The daemon's Go table mirrors it, and a test keeps them equal. */
export const KEYS = [
	"enter", "tab", "space", "backspace", "delete", "escape", "insert",
	"up", "down", "left", "right", "home", "end", "pageup", "pagedown",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
	"shift", "ctrl", "alt", "super", "capslock",
] as const;
/** A key is a name in KEYS, or one printable ASCII character (0x21-0x7e): "a", "A", "1", "/". */
export type Key = (typeof KEYS)[number] | string;

export type InputAction =
	// input.pointer
	| { type: "move"; at: Point }
	/** State persists across batches: a down with no up stays down. */
	| { type: "down" | "up"; button?: Button }
	| { type: "click"; at?: Point; button?: Button; count?: 1 | 2 | 3; keys?: Key[] }
	/** 2 or more points. */
	| { type: "drag"; path: Point[]; button?: Button; keys?: Key[] }
	| { type: "scroll"; at?: Point; dx?: number; dy?: number; unit: "clicks" | "px"; keys?: Key[] }
	// input.keys
	/** One key is a press; several are a combo, released in reverse. */
	| { type: "key"; keys: Key[]; repeat?: number }
	| { type: "hold"; keys: Key[]; ms: number }
	| { type: "type"; text: string }
	// input.touch
	| { type: "tap"; at: Point; count?: 1 | 2 }
	| { type: "long_press"; at: Point; ms?: number }
	| { type: "swipe"; path: Point[]; ms?: number }
	/** Above 1 the fingers move apart, below 1 together. */
	| { type: "pinch"; at: Point; scale: number; ms?: number }
	/** Not keys: "home" the key is line start. */
	| { type: "button"; name: "back" | "home" | "app_switch" }
	// any input group
	| { type: "wait"; ms: number };

export interface InputActionsParams {
	actions: InputAction[];
}

export interface InputActionsResult {
	/** How many actions ran. */
	done: number;
	/** The action that failed, and why; absent when every action ran. */
	failed?: { index: number; kind: DaemonErrorKind; message: string };
}

export interface App {
	id: string;
	name?: string;
	version?: string;
}

export interface AppsListResult {
	apps: App[];
	/** The id of the app in front, or null. */
	foreground: string | null;
}

export interface AppsInstallParams {
	/** A file already in the computer (files.write first). */
	path: string;
}

/** apps.launch and apps.terminate. */
export interface AppsLaunchParams {
	id: string;
}

/** The most nodes apps.ui_tree returns. */
export const MAX_UI_NODES = 5000;

export interface UiNode {
	/** The platform's class as given: "android.widget.Button", "XCUIElementTypeButton". */
	role: string;
	/** resource-id or accessibilityIdentifier. */
	id?: string;
	/** Visible text or value. */
	text?: string;
	/** content-desc or accessibilityLabel. */
	label?: string;
	/** In screenshot pixels (iOS points times scale). */
	bounds: Rect;
	enabled: boolean;
	clickable?: boolean;
	focused?: boolean;
	selected?: boolean;
	checked?: boolean;
	scrollable?: boolean;
	children: UiNode[];
}

export interface UiTreeResult {
	root: UiNode;
	/** How many nodes the tree holds, at most MAX_UI_NODES. */
	nodes: number;
	truncated: boolean;
}

/** Moves init's own deadline. Init refuses an earlier one. Typed now; the daemon answers it from the X11 shim's PR on. */
export interface DeadlineExtendParams {
	/** ISO time. */
	at: string;
}

export interface DeadlineExtendResult {
	/** The deadline init holds after the call, ISO time. */
	at: string;
}

/** Every method the daemon answers: its params and its result. */
export interface DaemonMethods {
	hello: { params: HelloParams; result: HelloResult };
	ping: { params: PingParams; result: PingResult };
	"exec.run": { params: ExecRunParams; result: ExecRunResult };
	"files.read": { params: FilesReadParams; result: FilesReadResult };
	"files.write": { params: FilesWriteParams; result: FilesWriteResult };
	"files.stat": { params: FilesStatParams; result: FileStat };
	"files.list": { params: FilesListParams; result: FilesListResult };
	"files.mkdir": { params: FilesMkdirParams; result: Empty };
	"files.move": { params: FilesMoveParams; result: Empty };
	"files.remove": { params: FilesRemoveParams; result: Empty };
	"tar.pull.begin": { params: TarPullBeginParams; result: TarPullBeginResult };
	"tar.pull.read": { params: TarPullReadParams; result: TarPullReadResult };
	"tar.pull.end": { params: TarPullEndParams; result: Empty };
	"tar.push.begin": { params: TarPushBeginParams; result: TarPushBeginResult };
	"tar.push.write": { params: TarPushWriteParams; result: Empty };
	"tar.push.end": { params: TarPushEndParams; result: TarPushEndResult };
	"process.start": { params: ProcessStartParams; result: ProcessStartResult };
	"process.read": { params: ProcessReadParams; result: ProcessReadResult };
	"process.write": { params: ProcessWriteParams; result: Empty };
	"process.signal": { params: ProcessSignalParams; result: Empty };
	"process.resize": { params: ProcessResizeParams; result: Empty };
	"process.list": { params: ProcessListParams; result: ProcessListResult };
	"process.wait": { params: ProcessWaitParams; result: ProcessExit };
	"screen.shot": { params: ScreenShotParams; result: ScreenShotResult };
	"screen.read": { params: ScreenReadParams; result: ScreenReadResult };
	"input.actions": { params: InputActionsParams; result: InputActionsResult };
	"apps.list": { params: Empty; result: AppsListResult };
	/** The installed app. */
	"apps.install": { params: AppsInstallParams; result: App };
	"apps.launch": { params: AppsLaunchParams; result: Empty };
	"apps.terminate": { params: AppsLaunchParams; result: Empty };
	"apps.ui_tree": { params: Empty; result: UiTreeResult };
	"deadline.extend": { params: DeadlineExtendParams; result: DeadlineExtendResult };
}

export type DaemonMethod = keyof DaemonMethods;

/**
 * What answers a computer's methods: computerd over a stream (DaemonClient), or, with daemon none, the provider in
 * process. Callers and the conformance suite see one surface.
 */
export interface ComputerClient {
	call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options?: { signal?: AbortSignal }): Promise<Result<DaemonMethods[M]["result"]>>;
	/** Ends the connection: pending and later calls fail with `gone`. */
	close(): void;
}

/** error.data.kind in the daemon's error replies. */
export type DaemonErrorKind =
	| "not_found"
	| "invalid"
	| "timeout"
	| "aborted"
	| "denied"
	| "limit"
	| "unsupported"
	| "exists"
	| "not_dir"
	| "is_dir";

export const JSONRPC_CODES = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	server: -32000,
	requestCancelled: -32800,
} as const;
