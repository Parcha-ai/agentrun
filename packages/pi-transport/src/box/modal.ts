import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import {
	type Box,
	type BoxEndpoint,
	BoxError,
	type BoxErrorCode,
	type BoxExecOptions,
	type BoxFacts,
	type BoxFile,
	type BoxProcess,
	type BoxProvider,
	type BoxRef,
	type BoxSpec,
	type BoxStatus,
	isReservedLabel,
} from "./box.ts";
import { downloadByExec, finish, uploadByExec } from "./files.ts";
import { parseNetwork, parsePorts } from "./network.ts";
import { PROBE, parseProbe } from "./probe.ts";

const DEFAULT_IMAGE = "debian:bookworm-slim";
const DEFAULT_WORKSPACE = "/workspace";
const MAX_LIFETIME_MS = 24 * 3_600_000;
/** How much longer than the caller's timeout Modal lets a program run, so the host's own timer reports first. */
const EXEC_GRACE_MS = 5_000;
const SETUP_TIMEOUT_MS = 60_000;
/** How long an exit waits for the output streams the caller read to end. */
const STREAM_SETTLE_MS = 30_000;
const STDIN_CHUNK_BYTES = 512 * 1024;
/** Every box carries this tag, so `attach` and `list` never touch a sandbox this package did not start. */
const BOX_TAG = "pi-transport.box";
/** Every box carries this tag too, so a host finds the boxes of this package by the one label every provider sets. */
const OWNER_TAG = "pi-transport";
const FACTS_TAG = "pi-transport.facts";
/**
 * What a box's create MEASURED of its hardware (the disk, whether FUSE works), kept in a tag so an attach that cannot read the box
 * again still has it. HARDWARE facts only: a security fact (the Yama setting, the network, the ports) is never taken from here on a
 * read error, it stays absent (unknown). A tag is provider-side metadata set through Modal's API with the host's token, which never
 * reaches the box: nothing inside the box can write it.
 */
const MEASURED_TAG = "pi-transport.measured";
const ATTACH_PROBE_TRIES = 3;
const ATTACH_PROBE_BACKOFF_MS = 200;

/** One program started in a Modal sandbox, in binary mode. The part of the SDK's `ContainerProcess` this package reads. */
export interface ModalProcess {
	readonly stdin: { writeBytes(bytes: Uint8Array): Promise<void>; close(): Promise<void> };
	readonly stdout: AsyncIterable<Uint8Array>;
	readonly stderr: AsyncIterable<Uint8Array>;
	wait(): Promise<number>;
}

/** The part of the SDK's `Sandbox` this package calls. */
export interface ModalSandbox {
	readonly sandboxId: string;
	exec(command: string[], params: { mode: "binary"; timeoutMs?: number; workdir?: string }): Promise<ModalProcess>;
	/** `null` while the sandbox runs, its exit code once it ended. */
	poll(): Promise<number | null>;
	/** Ends the sandbox and answers once it has ended, with its exit code. */
	terminate(params: { wait: true }): Promise<number>;
	getTags(): Promise<Record<string, string>>;
	/** Replaces the sandbox's whole tag set. Absent in a client that cannot: a box then keeps no measured facts for a later attach. */
	setTags?(tags: Record<string, string>): Promise<void>;
	/** The public addresses of the ports the sandbox was created to expose, by container port. */
	tunnels?(
		timeoutMs?: number,
	): Promise<Record<number, { readonly url: string; readonly tcpSocket: readonly [string, number] }>>;
}

/** What `sandboxes.create` is given. Every field is one the SDK's `SandboxCreateParams` has. */
export interface ModalCreateParams {
	name?: string;
	runtime?: "vm" | "gvisor";
	gpu?: string;
	cpu?: number;
	memoryMiB?: number;
	regions?: string[];
	timeoutMs: number;
	tags: Record<string, string>;
	/** Block all traffic from the sandbox. Not with an allowlist. */
	blockNetwork?: boolean;
	outboundDomainAllowlist?: string[];
	outboundCidrAllowlist?: string[];
	/** Ports tunnelled with TLS (an `https` URL) and without (a TCP socket). */
	encryptedPorts?: number[];
	unencryptedPorts?: number[];
	/** Settings every program of the sandbox sees, whichever handle starts it: so they outlive the host. */
	env?: Record<string, string>;
}

/**
 * The part of the Modal JS SDK's `ModalClient` that `modalBoxes` uses. The host passes its own client; this package
 * imports nothing from the SDK, so a host chooses the SDK version.
 */
export interface ModalSdk {
	readonly apps: { fromName(name: string, params: { createIfMissing: boolean }): Promise<{ readonly appId: string }> };
	readonly images: { fromRegistry(tag: string): unknown; fromId(id: string): Promise<unknown> };
	readonly sandboxes: {
		create(app: { readonly appId: string }, image: unknown, params: ModalCreateParams): Promise<ModalSandbox>;
		fromId(id: string): Promise<ModalSandbox>;
		list(params: { appId: string; tags: Record<string, string> }): AsyncIterable<ModalSandbox>;
	};
}

export type ModalBoxesOptions = {
	/** The Modal app the sandboxes live in. Created when missing. */
	readonly appName: string;
	/** A registry tag or a Modal image id (`im-...`) for a spec that names no image. Default `debian:bookworm-slim`. */
	readonly image?: string;
};

function errorName(cause: unknown): string {
	return (cause as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
}

function errorMessage(what: string, cause: unknown): string {
	const name = errorName(cause);
	const text = cause instanceof Error ? cause.message : String(cause);
	return `${what}: ${name === "" ? "" : `${name}: `}${text}`.replace(/\s+/g, " ").slice(0, 300);
}

const GRPC_INVALID_ARGUMENT = 3;
const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_UNAUTHENTICATED = 16;

/** The SDK's own error classes are named; a call that failed on the wire carries a gRPC status code. */
function grpcCode(cause: unknown): number | undefined {
	const code = (cause as { code?: unknown } | null)?.code;
	return typeof code === "number" ? code : undefined;
}

function classify(cause: unknown): BoxErrorCode {
	switch (grpcCode(cause)) {
		case GRPC_NOT_FOUND:
			return "not_found";
		case GRPC_INVALID_ARGUMENT:
			return "invalid";
		case GRPC_RESOURCE_EXHAUSTED:
			return "capacity";
		case GRPC_PERMISSION_DENIED:
		case GRPC_UNAUTHENTICATED:
			return "unauthorized";
	}
	switch (errorName(cause)) {
		case "NotFoundError":
			return "not_found";
		case "InvalidError":
		case "AlreadyExistsError":
			return "invalid";
		case "ResourceExhaustedError":
			return "capacity";
		case "SandboxTimeoutError":
		case "TimeoutError":
			return "timeout";
		default:
			return /unauthenticated|unauthorized|token/i.test(cause instanceof Error ? cause.message : "")
				? "unauthorized"
				: "unknown";
	}
}

function boxError(what: string, cause: unknown): BoxError {
	return new BoxError(classify(cause), errorMessage(what, cause), cause);
}

function isNotFound(cause: unknown): boolean {
	return errorName(cause) === "NotFoundError" || grpcCode(cause) === GRPC_NOT_FOUND;
}

/** Lookup once and share; a lookup that failed is forgotten, so a Modal hiccup does not poison the provider. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
	let cached: Promise<T> | undefined;
	return () => {
		if (cached === undefined) {
			const mine = make();
			cached = mine;
			mine.catch(() => {
				if (cached === mine) cached = undefined;
			});
		}
		return cached;
	};
}

/** What became of one output stream: whether the caller read it, when it ended, and how it failed. */
type StreamTrack = { started: boolean; failure: unknown; readonly ended: Promise<void>; end(): void };

function newTrack(): StreamTrack {
	let end: () => void = () => {};
	const ended = new Promise<void>((resolve) => {
		end = resolve;
	});
	return { started: false, failure: undefined, ended, end };
}

/** The source's chunks until `stopped` settles. A stream that fails ends, and the failure is kept on `track`. */
async function* until(
	source: AsyncIterable<Uint8Array>,
	stopped: Promise<void>,
	track: StreamTrack,
): AsyncGenerator<Uint8Array> {
	track.started = true;
	const iterator = source[Symbol.asyncIterator]();
	const stop = stopped.then(() => "stopped" as const);
	try {
		for (;;) {
			const next = await Promise.race([iterator.next(), stop]).catch((cause: unknown) => {
				track.failure = cause;
				return "stopped" as const;
			});
			if (next === "stopped" || next.done) return;
			yield next.value;
		}
	} finally {
		track.end();
		// A read that never answers must not hold the caller: the cancel is not awaited.
		void Promise.resolve(iterator.return?.()).catch(() => {});
	}
}

const isNullOr = (value: unknown, type: "number" | "string") => value === null || typeof value === type;

const NETWORKS = ["open", "none", "allowlist"] as const;
const validPorts = (value: unknown): NonNullable<BoxFacts["ports"]> =>
	Array.isArray(value)
		? value.filter(
				(p): p is NonNullable<BoxFacts["ports"]>[number] =>
					typeof p?.port === "number" && (p.kind === "https" || p.kind === "tcp"),
			)
		: [];

/** The facts a box's tag holds, or `undefined` when the tag is not one this package wrote. */
function parseFacts(
	text: string | undefined,
	measuredText?: string,
): { facts: BoxFacts; wantsFuse: boolean; wantsGpu: boolean; measured: boolean } | undefined {
	if (text === undefined) return undefined;
	try {
		const facts = JSON.parse(text) as Record<string, unknown> | null;
		if (facts === null || typeof facts !== "object") return undefined;
		const valid =
			facts.provider === "modal" &&
			(facts.isolation === "gvisor" || facts.isolation === "vm") &&
			isNullOr(facts.cpus, "number") &&
			isNullOr(facts.memoryMb, "number") &&
			isNullOr(facts.gpu, "string") &&
			typeof facts.workspace === "string" &&
			facts.workspace.startsWith("/") &&
			isNullOr(facts.maxLifetimeMs, "number") &&
			facts.snapshot === null;
		if (!valid) return undefined;
		// The disk, FUSE and Yama facts are read again in the box when it is found. A tag from before the network and ports
		// were facts has neither, and they stay absent (unknown), never read as open or as none.
		const { wantsFuse, diskGb: _disk, fuse: _fuse, ptraceScope: _ptrace, network, ports, startedAt, ...rest } = facts;
		// What the create measured: the hardware only. No tag, or one that does not parse, gives the fail-closed values (fuse false, no disk).
		let measured: { diskGb?: number; fuse?: boolean; gpu?: string } = {};
		try {
			const read = JSON.parse(measuredText ?? "null") as Record<string, unknown> | null;
			if (read !== null && typeof read === "object") {
				measured = {
					...(typeof read.diskGb === "number" && read.diskGb >= 0 ? { diskGb: read.diskGb } : {}),
					...(typeof read.fuse === "boolean" ? { fuse: read.fuse } : {}),
					...(typeof read.gpu === "string" && read.gpu !== "" ? { gpu: read.gpu } : {}),
				};
			}
		} catch {
			// A tag that is not JSON measured nothing.
		}
		return {
			wantsFuse: wantsFuse === true,
			// The spec asked for a GPU (the facts tag holds the request).
			wantsGpu: typeof facts.gpu === "string",
			// Whether the create's measured facts are in the tag: an ok attach carries only MEASURED facts.
			// A box that asked for a GPU needs the model it was measured with too.
			measured: measured.fuse !== undefined && (typeof facts.gpu !== "string" || measured.gpu !== undefined),
			facts: {
				...rest,
				// What an exec carries is a property of Modal, not of the box: a box made before it was reported has it too.
				secretsVia: "fd",
				fuse: false,
				...measured,
				// The facts tag holds the REQUEST for the GPU; the fact is the model measured at create, or null.
				gpu: typeof facts.gpu === "string" ? (measured.gpu ?? null) : null,
				...(NETWORKS.some((n) => n === network) ? { network } : {}),
				...(Array.isArray(ports) ? { ports: validPorts(ports) } : {}),
				...(typeof startedAt === "string" ? { startedAt } : {}),
			} as unknown as BoxFacts,
		};
	} catch {
		return undefined;
	}
}

function ownLabels(tags: Readonly<Record<string, string>>): Record<string, string> {
	const { [BOX_TAG]: _box, [FACTS_TAG]: _facts, [MEASURED_TAG]: _measured, [OWNER_TAG]: _owner, ...own } = tags;
	return own;
}

/** A box that is one Modal sandbox. The first process is Modal's own sleep, bounded by the sandbox's timeout. */
class ModalBox implements Box {
	readonly id: string;
	readonly #sandbox: ModalSandbox;
	#facts: BoxFacts;
	#destroyed = false;

	constructor(sandbox: ModalSandbox, facts: BoxFacts) {
		this.id = sandbox.sandboxId;
		this.#sandbox = sandbox;
		this.#facts = facts;
	}

	facts(): BoxFacts {
		return this.#facts;
	}

	async exec(
		command: readonly string[],
		options: BoxExecOptions | undefined,
		context: Context,
	): Promise<Result<BoxProcess, BoxError>> {
		if (command.length === 0) return err(new BoxError("invalid", "the command is empty"));
		if (this.#destroyed) return err(new BoxError("gone", `box ${this.id} has ended`));
		const timeoutMs = options?.timeoutMs;
		let process: ModalProcess;
		try {
			process = await this.#sandbox.exec([...command], {
				mode: "binary",
				workdir: this.#facts.workspace,
				...(timeoutMs === undefined ? {} : { timeoutMs: Math.ceil((timeoutMs + EXEC_GRACE_MS) / 1000) * 1000 }),
			});
		} catch (cause) {
			return err(await this.#failure("could not start a program", cause));
		}
		return ok(this.#adapt(process, timeoutMs, context));
	}

	#adapt(process: ModalProcess, timeoutMs: number | undefined, context: Context): BoxProcess {
		const signal = context.abortSignal;
		let stop: () => void = () => {};
		const stopped = new Promise<void>((resolve) => {
			stop = resolve;
		});
		const out = newTrack();
		const errors = newTrack();
		// Which streams the caller reads is known once it asks for the exit: it starts reading before it waits.
		let asked: () => void = () => {};
		const waitAsked = new Promise<void>((resolve) => {
			asked = resolve;
		});
		// Whether the program has exited, and how a failed close of its input reaches the caller: through `wait()`.
		let exited = false;
		let failInput: (error: BoxError) => void = () => {};
		// This adapter's own close of the input: its first call, shared by every later one.
		let closing: Promise<void> | undefined;
		// One deadline and one abort listener cover the whole wait: the program's exit, then the end of every stream the
		// caller read. A program's exit is only good when those streams reached their end without a failure: a stream
		// that broke after some bytes must not look like a complete output.
		const waited = new Promise<Result<number, BoxError>>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			let settleTimer: NodeJS.Timeout | undefined;
			let done = false;
			const finish = (result: Result<number, BoxError>) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				clearTimeout(settleTimer);
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const onAbort = () => {
				stop();
				finish(err(new BoxError("aborted", "the call was aborted")));
			};
			failInput = (error) => {
				// As the timeout and the abort do: the readers of the output streams are let go, so a caller that waits for them returns.
				stop();
				finish(err(error));
			};
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					stop();
					finish(err(new BoxError("timeout", `the program did not exit in ${timeoutMs} ms`)));
				}, timeoutMs);
			}
			process.wait().then(
				async (code) => {
					exited = true;
					await waitAsked;
					const read = [out, errors].filter((track) => track.started);
					await Promise.race([
						Promise.all(read.map((track) => track.ended)),
						new Promise<void>((settled) => {
							settleTimer = setTimeout(settled, STREAM_SETTLE_MS);
						}),
					]);
					const broken = [out, errors].find((track) => track.failure !== undefined);
					finish(
						broken === undefined
							? ok(code)
							: err(
									new BoxError(
										"unknown",
										`an output stream of the program failed: ${String(broken.failure)}`,
										broken.failure,
									),
								),
					);
				},
				async (cause) => {
					exited = true;
					finish(err(await this.#failure("lost the program", cause)));
				},
			);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		return {
			stdin: {
				write: async (bytes) => {
					for (let at = 0; at < bytes.length; at += STDIN_CHUNK_BYTES) {
						await process.stdin.writeBytes(bytes.subarray(at, at + STDIN_CHUNK_BYTES));
					}
				},
				// `close()` means the program's input is closed, and it is closed ONCE: this adapter tracks its own close (a launch closes the
				// input after it writes the frame, and `finish` closes it again), so a later call, in flight or done, returns the first and
				// asks the stream for nothing: a stream the SDK has closed rejects a second close, which is no failure. Decided by that
				// state, never by the text of an error and never by waiting. A program that already exited closed its input, and its exit
				// code reports it. A close that fails the first time on a program still running leaves it waiting for an EOF that will not
				// come: `wait()` answers with that failure.
				close: () => {
					closing ??= (async () => {
						try {
							await process.stdin.close();
						} catch (cause) {
							if (!exited) {
								failInput(
									new BoxError("unknown", `could not close the program's input: ${String(cause)}`, cause),
								);
							}
						}
					})();
					return closing;
				},
			},
			stdout: until(process.stdout, stopped, out),
			stderr: until(process.stderr, stopped, errors),
			wait: () => {
				asked();
				return waited;
			},
		};
	}

	/** An error from the SDK as a box error: a sandbox that ended is `gone`, whatever the SDK called it. */
	async #failure(what: string, cause: unknown): Promise<BoxError> {
		const status = await this.#poll();
		if (this.#destroyed || (status.ok && status.value !== null)) {
			return new BoxError("gone", `box ${this.id} has ended`, cause);
		}
		return boxError(what, cause);
	}

	async #poll(): Promise<Result<number | null, BoxError>> {
		try {
			return ok(await this.#sandbox.poll());
		} catch (cause) {
			if (isNotFound(cause)) return ok(-1);
			return err(boxError(`could not read the state of box ${this.id}`, cause));
		}
	}

	/**
	 * Make the workspace, whether or not it exists. It runs before `workdir` can name a directory that exists, so it
	 * sets none.
	 */
	async prepare(context: Context): Promise<Result<void, BoxError>> {
		try {
			const process = await this.#sandbox.exec(["mkdir", "-p", "--", this.#facts.workspace], {
				mode: "binary",
				timeoutMs: SETUP_TIMEOUT_MS,
			});
			const finished = await finish(this.#adapt(process, SETUP_TIMEOUT_MS, context));
			if (!finished.ok) return finished;
			if (finished.value.exitCode === 0) return ok(undefined);
			return err(
				new BoxError("unknown", `could not make ${this.#facts.workspace}: ${finished.value.stderr.trim()}`),
			);
		} catch (cause) {
			return err(boxError("could not make the workspace", cause));
		}
	}

	/**
	 * Read what the box has (`PROBE`) into its facts. A box that was asked for `fuse` and cannot give it is an error that
	 * names what is missing; any other box whose read fails keeps unmeasured facts (`null`, `false`).
	 */
	async measure(wantsFuse: boolean, wantsGpu: boolean, context: Context): Promise<Result<void, BoxError>> {
		// A cancelled call is the caller's answer, never an optional read that did not matter.
		const cancelled = (): Result<void, BoxError> | undefined =>
			context.abortSignal?.aborted ? err(new BoxError("aborted", "the call was aborted")) : undefined;
		// A box that asked for FUSE or a GPU must have it read: any failure to read is an error, not a fact left out.
		const required = wantsFuse || wantsGpu;
		const fail = (message: string): Result<void, BoxError> =>
			cancelled() ?? (required ? err(new BoxError("unknown", message)) : ok(undefined));
		try {
			const process = await this.#sandbox.exec(
				["sh", "-c", PROBE, "sh", this.#facts.workspace, wantsFuse ? "fuse" : "-", wantsGpu ? "gpu" : "-"],
				{
					mode: "binary",
					timeoutMs: SETUP_TIMEOUT_MS,
				},
			);
			const finished = await finish(this.#adapt(process, SETUP_TIMEOUT_MS, context));
			if (!finished.ok) return required ? err(finished.error) : (cancelled() ?? ok(undefined));
			if (finished.value.exitCode !== 0)
				return fail(`could not read what the box has: ${finished.value.stderr.trim()}`);
			const reading = parseProbe(new TextDecoder().decode(finished.value.stdout));
			if (wantsFuse && !reading.fuse) {
				return fail(`the box asked for fuse and lacks ${reading.fuseMissing.join(" and ")}`);
			}
			// The model served, not the one asked for: a bare `H100` may be served an H200. None is no GPU: the box must not be used as if it had one.
			if (wantsGpu && reading.gpus.length === 0) {
				return fail(`the box asked for the GPU ${this.#facts.gpu} and nvidia-smi names none in it`);
			}
			this.#facts = {
				...this.#facts,
				...(wantsGpu ? { gpu: reading.gpus.join(" + ") } : {}),
				...(reading.diskGb === undefined ? {} : { diskGb: reading.diskGb }),
				...(reading.ptraceScope === undefined ? {} : { ptraceScope: reading.ptraceScope }),
				fuse: wantsFuse && reading.fuse,
			};
			return ok(undefined);
		} catch (cause) {
			return cancelled() ?? (required ? err(boxError("could not read what the box has", cause)) : ok(undefined));
		}
	}

	/** One run of the probe: what the box printed, or why it did not answer. A cancelled call is reported as `aborted`. */
	async #runProbe(
		wantsFuse: boolean,
		wantsGpu: boolean,
		context: Context,
	): Promise<{ ok: true; reading: ReturnType<typeof parseProbe> } | { ok: false; error: BoxError }> {
		try {
			const process = await this.#sandbox.exec(
				["sh", "-c", PROBE, "sh", this.#facts.workspace, wantsFuse ? "fuse" : "-", wantsGpu ? "gpu" : "-"],
				{ mode: "binary", timeoutMs: SETUP_TIMEOUT_MS },
			);
			const finished = await finish(this.#adapt(process, SETUP_TIMEOUT_MS, context));
			if (!finished.ok) return { ok: false, error: finished.error };
			if (finished.value.exitCode !== 0) {
				return {
					ok: false,
					error: new BoxError("unknown", `could not read what the box has: ${finished.value.stderr.trim()}`),
				};
			}
			return { ok: true, reading: parseProbe(new TextDecoder().decode(finished.value.stdout)) };
		} catch (cause) {
			return { ok: false, error: boxError("could not read what the box has", cause) };
		}
	}

	/**
	 * The read of an attach: a live sandbox is always handed back, and never ended here. A probe that errs is tried again (a few
	 * tries, with a pause); a probe that answers, even with no FUSE, gives the facts AS MEASURED, and the caller ends the box
	 * through its handle if it does not fit. If every try errs, the handle keeps the HARDWARE the create measured (from its tag; a
	 * tag from before that has none, and the attach is an error) and every security fact is left out (unknown): the Yama setting, the
	 * network and the ports are never taken from a tag on a read error. A cancelled call is the one error.
	 */
	async measureForAttach(
		wantsFuse: boolean,
		wantsGpu: boolean,
		tagMeasured: boolean,
		context: Context,
	): Promise<Result<void, BoxError>> {
		for (let attempt = 0; attempt < ATTACH_PROBE_TRIES; attempt++) {
			const read = await this.#runProbe(wantsFuse, wantsGpu, context);
			if (context.abortSignal?.aborted) return err(new BoxError("aborted", "the call was aborted"));
			if (read.ok) {
				const { reading } = read;
				this.#facts = {
					...this.#facts,
					...(reading.diskGb === undefined ? {} : { diskGb: reading.diskGb }),
					...(reading.ptraceScope === undefined ? {} : { ptraceScope: reading.ptraceScope }),
					fuse: wantsFuse && reading.fuse,
					// A read that answers is definitive: no card named is `null`, and the caller ends the box through the handle.
					...(wantsGpu ? { gpu: reading.gpus.length === 0 ? null : reading.gpus.join(" + ") } : {}),
				};
				return ok(undefined);
			}
			if (attempt + 1 < ATTACH_PROBE_TRIES) {
				await new Promise((resolve) => setTimeout(resolve, ATTACH_PROBE_BACKOFF_MS * (attempt + 1)));
			}
		}
		// A tag with nothing measured has no facts to give: an `ok` attach carries only measured ones, never a fail-closed guess, so
		// this is an error and the box keeps running (the caller tries again, and ends nothing).
		if (!tagMeasured) {
			return err(
				new BoxError(
					"unknown",
					`could not read what the box ${this.id} has, and nothing measured at its create is kept: try again`,
				),
			);
		}
		const { network: _network, ports: _ports, ptraceScope: _ptrace, ...hardware } = this.#facts;
		this.#facts = hardware;
		return ok(undefined);
	}

	/** Keep what this box's create measured in a tag, best effort: a client that cannot set tags, or a failure, leaves none. */
	async recordMeasured(): Promise<void> {
		if (this.#sandbox.setTags === undefined) return;
		try {
			const tags = await this.#sandbox.getTags();
			const { diskGb, fuse, gpu } = this.#facts;
			await this.#sandbox.setTags({
				...tags,
				[MEASURED_TAG]: JSON.stringify({
					...(diskGb === undefined ? {} : { diskGb }),
					fuse: fuse === true,
					...(typeof gpu === "string" ? { gpu } : {}),
				}),
			});
		} catch {
			// The tag is a fallback for a later attach; a box without it reads fail-closed there.
		}
	}

	async endpoint(port: number, _context: Context): Promise<Result<BoxEndpoint, BoxError>> {
		const exposed = this.#facts.ports?.find((p) => p.port === port);
		if (exposed === undefined) return err(new BoxError("invalid", `the box does not expose port ${port}`));
		if (this.#sandbox.tunnels === undefined)
			return err(new BoxError("unsupported", "this Modal client cannot read tunnels"));
		try {
			const tunnel = (await this.#sandbox.tunnels())[port];
			if (tunnel === undefined) return err(new BoxError("not_found", `Modal made no tunnel for port ${port}`));
			return ok(
				exposed.kind === "https"
					? { kind: "https", url: tunnel.url }
					: { kind: "tcp", host: tunnel.tcpSocket[0], port: tunnel.tcpSocket[1] },
			);
		} catch (cause) {
			return err(boxError(`could not read the address of port ${port}`, cause));
		}
	}

	upload(files: readonly BoxFile[], context: Context): Promise<Result<void, BoxError>> {
		return uploadByExec(this, files, context);
	}

	download(paths: readonly string[], context: Context): Promise<Result<readonly BoxFile[], BoxError>> {
		return downloadByExec(this, paths, context);
	}

	async status(): Promise<Result<BoxStatus, BoxError>> {
		if (this.#destroyed) return ok({ state: "ended", exitCode: null });
		const polled = await this.#poll();
		if (!polled.ok) return polled;
		if (polled.value === null) return ok({ state: "running" });
		return ok({ state: "ended", exitCode: polled.value < 0 ? null : polled.value });
	}

	async destroy(): Promise<Result<void, BoxError>> {
		if (this.#destroyed) return ok(undefined);
		try {
			await this.#sandbox.terminate({ wait: true });
		} catch (cause) {
			const polled = await this.#poll();
			if (!isNotFound(cause) && !(polled.ok && polled.value !== null)) {
				return err(boxError(`could not terminate box ${this.id}`, cause));
			}
		}
		this.#destroyed = true;
		return ok(undefined);
	}
}

/**
 * Boxes that are Modal sandboxes, through the host's own Modal SDK client. The provider ends a sandbox at its lifetime
 * on Modal's side, so a host that dies leaks nothing past `maxLifetimeMs`. A spec's `isolation` of `vm` selects the VM
 * runtime, `gvisor` or none the default sandbox, and any other value is refused with `unsupported`; a GPU needs the
 * default sandbox. Refused before any Modal call: a `snapshot` or an `isolation` other than `gvisor` or `vm`
 * (`unsupported`), a GPU with `vm`, a label key that is `pi-transport` or starts with `pi-transport.` and a lifetime that is not positive
 * (`invalid`), and so is a `workspace` that is not an absolute path. No other field is ignored; `region` becomes
 * Modal's `regions`. Boxes carry their facts in a tag, so `attach` finds them after a restart. The spec's `env` is the
 * sandbox's own, so a box found again by `attach` runs programs with it.
 */
export function modalBoxes(sdk: ModalSdk, options: ModalBoxesOptions): BoxProvider {
	const theApp = once(() => sdk.apps.fromName(options.appName, { createIfMissing: true }));
	const imageOf = (name: string): Promise<unknown> =>
		name.startsWith("im-") ? sdk.images.fromId(name) : Promise.resolve(sdk.images.fromRegistry(name));

	return {
		name: "modal",

		async create(spec: BoxSpec, context: Context): Promise<Result<Box, BoxError>> {
			if (!(spec.maxLifetimeMs > 0)) return err(new BoxError("invalid", "maxLifetimeMs must be positive"));
			if (spec.workspace !== undefined && !spec.workspace.startsWith("/")) {
				return err(new BoxError("invalid", "workspace must be an absolute path"));
			}
			const reserved = Object.keys(spec.labels ?? {}).find(isReservedLabel);
			if (reserved !== undefined) {
				return err(new BoxError("invalid", `the label ${reserved} is in the providers' own namespace`));
			}
			if (spec.snapshot !== undefined) return err(new BoxError("unsupported", "modal boxes start from an image"));
			if (spec.isolation !== undefined && spec.isolation !== "gvisor" && spec.isolation !== "vm") {
				return err(
					new BoxError("unsupported", `a modal box is gvisor or a vm, the spec asks for ${spec.isolation}`),
				);
			}
			if (spec.gpu !== undefined && spec.isolation === "vm") {
				return err(new BoxError("invalid", "Modal offers GPUs on the gvisor runtime only"));
			}
			const network = parseNetwork(spec.network);
			if (network instanceof BoxError) return err(network);
			const ports = parsePorts(spec.ports);
			if (ports instanceof BoxError) return err(ports);
			if (network.kind === "none" && ports.length > 0) {
				return err(new BoxError("invalid", "a box with no network cannot be reached on a port"));
			}
			const unknown = (spec.capabilities ?? []).find((c) => c !== "fuse");
			if (unknown !== undefined)
				return err(new BoxError("unsupported", `a modal box cannot give ${String(unknown)}`));
			const wantsFuse = (spec.capabilities ?? []).includes("fuse");
			if (wantsFuse && spec.isolation === "gvisor") {
				return err(
					new BoxError("unsupported", "gVisor cannot give FUSE a durable mount: fuse needs the vm runtime"),
				);
			}
			if (wantsFuse && spec.gpu !== undefined) {
				return err(new BoxError("invalid", "Modal offers GPUs on the gvisor runtime only, and fuse needs vm"));
			}
			const runtime = wantsFuse ? "vm" : spec.isolation;
			if (context.abortSignal?.aborted) return err(new BoxError("aborted", "the call was aborted"));
			const lifetimeMs = Math.min(Math.ceil(spec.maxLifetimeMs / 1000) * 1000, MAX_LIFETIME_MS);
			const facts: BoxFacts = {
				provider: "modal",
				isolation: runtime === "vm" ? "vm" : "gvisor",
				cpus: spec.cpus ?? null,
				memoryMb: spec.memoryMb ?? null,
				gpu: spec.gpu ?? null,
				workspace: spec.workspace ?? DEFAULT_WORKSPACE,
				maxLifetimeMs: lifetimeMs,
				snapshot: null,
				// A Modal exec carries a real stdin (bytes in order, an explicit EOF), so T3's launch frame rides it.
				secretsVia: "fd",
				network: network.kind,
				ports,
				// The moment Modal is asked: the facts go into the create call's tags, before the sandbox exists.
				startedAt: new Date().toISOString(),
			};
			const aborted = <T>(): Result<T, BoxError> => err(new BoxError("aborted", "the call was aborted"));
			let sandbox: ModalSandbox;
			try {
				const app = await theApp();
				if (context.abortSignal?.aborted) return aborted();
				const image = await imageOf(spec.image ?? options.image ?? DEFAULT_IMAGE);
				if (context.abortSignal?.aborted) return aborted();
				// The tags go in the create call: a crash after it leaves a sandbox that `list` can still find.
				sandbox = await sdk.sandboxes.create(app, image, {
					...(runtime === undefined ? {} : { runtime }),
					...(spec.gpu === undefined ? {} : { gpu: spec.gpu }),
					...(spec.cpus === undefined ? {} : { cpu: spec.cpus }),
					...(spec.memoryMb === undefined ? {} : { memoryMiB: spec.memoryMb }),
					...(spec.region === undefined ? {} : { regions: [spec.region] }),
					...(spec.env === undefined ? {} : { env: { ...spec.env } }),
					...(network.kind === "none" ? { blockNetwork: true } : {}),
					...(network.kind === "allowlist" && network.domains.length > 0
						? { outboundDomainAllowlist: [...network.domains] }
						: {}),
					...(network.kind === "allowlist" && network.cidrs.length > 0
						? { outboundCidrAllowlist: [...network.cidrs] }
						: {}),
					...(ports.some((p) => p.kind === "https")
						? { encryptedPorts: ports.filter((p) => p.kind === "https").map((p) => p.port) }
						: {}),
					...(ports.some((p) => p.kind === "tcp")
						? { unencryptedPorts: ports.filter((p) => p.kind === "tcp").map((p) => p.port) }
						: {}),
					timeoutMs: lifetimeMs,
					tags: {
						...spec.labels,
						[OWNER_TAG]: "1",
						[BOX_TAG]: "1",
						[FACTS_TAG]: JSON.stringify({ ...facts, wantsFuse }),
					},
				});
			} catch (cause) {
				return err(boxError("could not start a box", cause));
			}
			const box = new ModalBox(sandbox, facts);
			// A sandbox exists from here on: a call the caller gave up on, or one that cannot finish, ends it.
			let made = context.abortSignal?.aborted ? aborted<void>() : await box.prepare(context);
			if (made.ok && !context.abortSignal?.aborted)
				made = await box.measure(wantsFuse, spec.gpu !== undefined, context);
			if (made.ok && !context.abortSignal?.aborted) await box.recordMeasured();
			if (!made.ok || context.abortSignal?.aborted) {
				await box.destroy();
				return made.ok ? aborted() : made;
			}
			return ok(box);
		},

		async attach(id: string, context: Context): Promise<Result<Box | undefined, BoxError>> {
			let box: ModalBox;
			let wantsFuse = false;
			let tagMeasured = false;
			let wantsGpu = false;
			try {
				const sandbox = await sdk.sandboxes.fromId(id);
				if ((await sandbox.poll()) !== null) return ok(undefined);
				const tags = await sandbox.getTags();
				const found = tags[BOX_TAG] === undefined ? undefined : parseFacts(tags[FACTS_TAG], tags[MEASURED_TAG]);
				if (found === undefined) return ok(undefined);
				box = new ModalBox(sandbox, found.facts);
				wantsFuse = found.wantsFuse;
				tagMeasured = found.measured;
				wantsGpu = found.wantsGpu;
			} catch (cause) {
				if (isNotFound(cause) || classify(cause) === "invalid") return ok(undefined);
				return err(boxError(`could not look up box ${id}`, cause));
			}
			// A host that died between the create call and the workspace setup left a box with no workspace, so the setup runs again. If it
			// fails the attach is an ERROR, never an ok handle on a box that may have no workspace: the box keeps running and nothing is
			// ended or created, and the caller fails this start and tries again. The caller's own cancel is an abort. (A facts READ
			// below never fails the attach: a live sandbox is handed back, and the caller ends it through the handle.)
			const prepared = await box.prepare(context);
			if (context.abortSignal?.aborted) return err(new BoxError("aborted", "the call was aborted"));
			if (!prepared.ok) return prepared;
			const read = await box.measureForAttach(wantsFuse, wantsGpu, tagMeasured, context);
			return read.ok ? ok(box) : read;
		},

		async list(labels, _context: Context): Promise<Result<readonly BoxRef[], BoxError>> {
			const refs: BoxRef[] = [];
			try {
				const app = await theApp();
				// The SDK lists running sandboxes only.
				for await (const sandbox of sdk.sandboxes.list({ appId: app.appId, tags: { ...labels, [BOX_TAG]: "1" } })) {
					refs.push({ id: sandbox.sandboxId, labels: ownLabels(await sandbox.getTags()) });
				}
			} catch (cause) {
				return err(boxError("could not list boxes", cause));
			}
			return ok(refs);
		},
	};
}
