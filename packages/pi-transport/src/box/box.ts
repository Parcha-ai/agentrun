import type { Context } from "@earendil-works/chord";
import type { Result } from "@earendil-works/pi-durable/env";
import type { Launch, LaunchError, LaunchSpec, LaunchState } from "../launch/launch.ts";

/**
 * Why a box call failed. Codes are the contract; messages are diagnostic.
 *
 * `gone` means the box ended or was destroyed. `capacity` means the provider had no machine to give. `spawn` means the
 * program could not be started.
 */
export type BoxErrorCode =
	| "aborted"
	| "timeout"
	| "not_found"
	| "gone"
	| "capacity"
	| "unauthorized"
	| "invalid"
	| "unsupported"
	| "spawn"
	| "unknown";

/** An expected failure of a box or its provider. Returned, never thrown. */
export class BoxError extends Error {
	public code: BoxErrorCode;

	constructor(code: BoxErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BoxError";
		this.code = code;
	}
}

/**
 * What a box may reach. `open` is the provider's own default. `none` blocks all traffic. An allowlist names the only
 * destinations: a domain (`api.example.com`), a wildcard domain (`*.example.com`) or an IPv4 CIDR (`10.0.0.0/8`).
 */
export type BoxNetwork = "open" | "none" | { readonly allow: readonly string[] };

/** A port to reach from outside the box. A bare number is `https`: TLS, reached by an `https` URL. `tcp` is a raw socket. */
export type BoxPort = number | { readonly port: number; readonly kind: "https" | "tcp" };

/** Where an exposed port is reached, from `Box.endpoint`. Never a provider's id for the box. */
export type BoxEndpoint =
	| { readonly kind: "https"; readonly url: string }
	| { readonly kind: "tcp"; readonly host: string; readonly port: number };

/** Something a box can be asked to have. A provider that cannot give it refuses the spec with `unsupported`. */
export type BoxCapability = "fuse";

/** What a provider needs to create a box. A provider documents the fields it ignores. */
export type BoxSpec = {
	/** Image the box starts from, in the provider's own naming. */
	readonly image?: string;
	/** Provider snapshot the box starts from, instead of an image. */
	readonly snapshot?: string;
	readonly cpus?: number;
	readonly memoryMb?: number;
	/** GPU model in the provider's own naming, for example `T4` or `H100`. */
	readonly gpu?: string;
	readonly region?: string;
	/** The separation the box must have. A provider that cannot give it refuses the spec with `unsupported`. */
	readonly isolation?: BoxFacts["isolation"];
	/** Plain settings for programs in the box. Never a secret: a provider may store and return them. */
	readonly env?: Readonly<Record<string, string>>;
	/** Absolute directory programs start in and relative paths resolve against. Created when absent. */
	readonly workspace?: string;
	/**
	 * The provider ends the box after this long, whatever happens to the host that created it. A bound on leaked
	 * boxes, never a clean stop.
	 */
	readonly maxLifetimeMs: number;
	/**
	 * Labels `BoxProvider.list` finds the box by. The key `pi-transport` and every key that starts with
	 * `pi-transport.` belong to providers, which mark their boxes and keep a box's own records there: a spec that
	 * names one is refused with `invalid`. A host that wants every box of a provider asks `list` with no labels.
	 */
	readonly labels?: Readonly<Record<string, string>>;
	/** What the box may reach. Absent means the provider's default, which `BoxFacts.network` then says. */
	readonly network?: BoxNetwork;
	/** Ports to reach from outside. A provider that cannot expose a port refuses the spec with `unsupported`. */
	readonly ports?: readonly BoxPort[];
	/** What the box must have. `fuse`: a FUSE mount works for a user who is not root. */
	readonly capabilities?: readonly BoxCapability[];
};

/** What a box is and can do, as its provider reports it. Fixed for the life of the box. */
export type BoxFacts = {
	readonly provider: string;
	/** How the box is separated from the machine that hosts it. `none` shares this machine's files and processes. */
	readonly isolation: "none" | "container" | "gvisor" | "vm";
	readonly cpus: number | null;
	readonly memoryMb: number | null;
	readonly gpu: string | null;
	/** Absolute directory programs start in. */
	readonly workspace: string;
	readonly maxLifetimeMs: number | null;
	/**
	 * What the box may reach: `open`, `none`, or `allowlist` (the list itself is not repeated here). Absent means
	 * unknown: a caller that needs `none` or an allowlist must refuse the box.
	 */
	readonly network?: "open" | "none" | "allowlist";
	/**
	 * The ports the spec asked to reach from outside, each with the kind of address `Box.endpoint` gives; `[]` when the
	 * provider made the box with none. Absent means unknown, not none: a caller that must be sure no port is exposed
	 * must refuse the box.
	 */
	readonly ports?: readonly { readonly port: number; readonly kind: "https" | "tcp" }[];
	/** The size of the filesystem the workspace is on, in whole GiB as the box reports it. Absent means unknown. */
	readonly diskGb?: number;
	/**
	 * When the box began to run, as an ISO 8601 UTC time (a provider that queues gives the moment it was asked). Absent
	 * means unknown: a receipt falls back to the time the create call answered.
	 */
	readonly startedAt?: string;
	/**
	 * `true` only when the spec asked for `fuse` and a FUSE mount was checked to be possible for a user who is not root.
	 * Absent means `false`: a caller that needs FUSE must refuse the box.
	 */
	readonly fuse?: boolean;
	/**
	 * `kernel.yama.ptrace_scope` as read in the box (a box without the setting reads 0). Absent means unknown: a caller
	 * that chooses a box must not assume 1 or more. A launcher that measures the setting itself at the start does not need it.
	 */
	readonly ptraceScope?: 0 | 1 | 2 | 3;
	/** The kind of snapshot `Box.snapshot` takes, or `null` when the box has none. */
	readonly snapshot: "disk" | "memory" | null;
	/**
	 * How large amounts of bytes move fastest into and out of this box: through the streams of `exec`, or as files
	 * through `upload` and `download`. Absent means files.
	 */
	readonly bulk?: "stream" | "files";
	/** The longest one `exec` may run, in ms, when the provider ends a call at a fixed length. Absent means no such limit. */
	readonly maxExecMs?: number;
	/**
	 * Whether a program started by `exec` keeps running between calls and takes input: `false` for a box whose every
	 * `exec` is one request that answers when the command ends (its stdin is refused with `unsupported`, its output
	 * arrives after the call). Absent means true. A box that cannot keep a program running can never be a home.
	 */
	readonly liveProcesses?: boolean;
	/**
	 * How this box takes a secret for a program: `fd`, a real stdin path, so the launcher (`@parcha/pi-transport/launch`)
	 * gets a launch's stdin and secrets on the stdin of the one exec that starts it and holds them only in its memory;
	 * `substitution`, a provider that fills an outbound credential so the value never enters the box; `file`, the one
	 * staging exception. Absent: it takes none, and a launch with `stdin` or `secrets` is refused `unsupported`.
	 */
	readonly secretsVia?: "fd" | "substitution" | "file";
};

/** Whether a box still runs. */
export type BoxStatus = { readonly state: "running" } | { readonly state: "ended"; readonly exitCode: number | null };

/** A box a provider knows, without a connection to it. */
export type BoxRef = { readonly id: string; readonly labels: Readonly<Record<string, string>> };

/** One file moved into or out of a box. A relative `path` resolves against the box's workspace. */
export type BoxFile = { readonly path: string; readonly bytes: Uint8Array; readonly mode?: number };

/** A provider snapshot of a box. `disk` holds files only; `memory` also holds running processes. */
export type BoxSnapshot = { readonly kind: "disk" | "memory"; readonly id: string };

export type BoxExecOptions = {
	/** After this long `wait()` resolves with a `timeout` error and the provider stops the program when it can. */
	readonly timeoutMs?: number;
};

/**
 * One program started in a box. Read both streams to their end, or the program may block on a full pipe.
 */
export interface BoxProcess {
	readonly stdin: {
		write(bytes: Uint8Array): Promise<void>;
		close(): Promise<void>;
	};
	readonly stdout: AsyncIterable<Uint8Array>;
	readonly stderr: AsyncIterable<Uint8Array>;
	/**
	 * The exit code as a value: a non-zero exit is not an error. A program ended by signal `n` reports `128 + n`.
	 * A program that cannot start is a `spawn` error where the provider can tell, otherwise exit code 126 or 127.
	 */
	wait(): Promise<Result<number, BoxError>>;
}

/**
 * One running machine: a directory on this machine, a container, a sandbox, a VM. Everything else in this package is
 * built on these calls, so a vendor that fills them and passes the box conformance suite gets the rest.
 */
export interface Box {
	/** Stable for the life of the box; `BoxProvider.attach` finds the box by it. */
	readonly id: string;
	facts(): BoxFacts;
	/**
	 * Start `command[0]` with the rest as its arguments, without a shell, in the workspace. Aborting the context or a
	 * timeout ends the wait; it does not promise the program died. A caller that must kill runs the program in its
	 * own process group and kills the group with a second `exec`.
	 */
	exec(
		command: readonly string[],
		options: BoxExecOptions | undefined,
		context: Context,
	): Promise<Result<BoxProcess, BoxError>>;
	/** Write whole files, creating parent directories. */
	upload(files: readonly BoxFile[], context: Context): Promise<Result<void, BoxError>>;
	/** Read whole files, in the order asked. A missing file fails the call with `not_found`. */
	download(paths: readonly string[], context: Context): Promise<Result<readonly BoxFile[], BoxError>>;
	status(context: Context): Promise<Result<BoxStatus, BoxError>>;
	/** End the box and release what it holds. Succeeds on a box that already ended. */
	destroy(context: Context): Promise<Result<void, BoxError>>;
	/** Only on boxes whose `facts().snapshot` is not `null`. */
	snapshot?(context: Context): Promise<Result<BoxSnapshot, BoxError>>;
	/**
	 * Optional: a box that keeps a program alive natively (a fake box in a test). `launch`, `launchState` and `launchStop`
	 * (`@parcha/pi-transport/launch`) use it when it is there, read on every call, and otherwise run the launcher in the box
	 * with `exec`. A provider leaves it undefined.
	 */
	readonly launcher?: BoxLauncher;
	/** Where `facts().ports` reaches the box from outside. Only on boxes whose provider can expose a port. */
	endpoint?(port: number, context: Context): Promise<Result<BoxEndpoint, BoxError>>;
}

/** The launcher's three calls, done natively by a box (`Box.launcher`), with the same answers as the launcher in a box. */
export interface BoxLauncher {
	launch(name: string, spec: LaunchSpec, context: Context): Promise<Result<LaunchState, LaunchError>>;
	state(launch: Launch, context: Context): Promise<Result<LaunchState | undefined, LaunchError>>;
	stop(
		launch: Launch,
		options: { readonly graceMs?: number } | undefined,
		context: Context,
	): Promise<Result<LaunchState, LaunchError>>;
}

/** A source of boxes: one vendor, or one kind of machine. */
export interface BoxProvider {
	readonly name: string;
	create(spec: BoxSpec, context: Context): Promise<Result<Box, BoxError>>;
	/** The box with this id, or `undefined` when it does not exist or has ended. */
	attach(id: string, context: Context): Promise<Result<Box | undefined, BoxError>>;
	/** Every live box that carries all of these labels. A host uses it to find boxes it leaked. */
	list(labels: Readonly<Record<string, string>>, context: Context): Promise<Result<readonly BoxRef[], BoxError>>;
}

/** Whether a label key belongs to providers: `pi-transport` itself and every key under `pi-transport.`. */
export function isReservedLabel(key: string): boolean {
	return key === "pi-transport" || key.startsWith("pi-transport.");
}
