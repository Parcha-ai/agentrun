// The daemon's methods: the one shared definition on the TypeScript side (daemon/internal/methods is the Go side).
// JSON-RPC 2.0, one UTF-8 JSON object per line, in both directions.

/** The longest line, in bytes without its newline, either side reads or writes. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** The most bytes exec.run keeps of each stream: two full streams, in base64, fit one reply line. */
export const MAX_OUTPUT_BYTES = 360 * 1024;
/** The notification that cancels a request by id (as in LSP). */
export const CANCEL_METHOD = "$/cancelRequest";

/** What a daemon can do, as hello reports it. */
export type DaemonCapability = "exec" | "files" | "processes";

export interface HelloParams {
	/** Who is asking, for the daemon's log: a name and version. */
	client: string;
}

export interface HelloResult {
	version: string;
	os: "linux";
	/** Go's name for the architecture: amd64, arm64. */
	arch: string;
	capabilities: DaemonCapability[];
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
	/** The signal that ended it, such as "SIGKILL". */
	signal?: string;
	/** base64. */
	stdout: string;
	/** base64. */
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
}

/** Every method the daemon answers: its params and its result. */
export interface DaemonMethods {
	hello: { params: HelloParams; result: HelloResult };
	ping: { params: PingParams; result: PingResult };
	"exec.run": { params: ExecRunParams; result: ExecRunResult };
}

export type DaemonMethod = keyof DaemonMethods;

/** error.data.kind in the daemon's error replies. */
export type DaemonErrorKind = "not_found" | "invalid" | "timeout" | "aborted" | "denied" | "limit" | "unsupported";

export const JSONRPC_CODES = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	server: -32000,
	requestCancelled: -32800,
} as const;
