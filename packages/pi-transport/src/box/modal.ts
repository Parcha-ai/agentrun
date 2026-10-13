import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import {
	type Box,
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

/** The facts a box's tag holds, or `undefined` when the tag is not one this package wrote. */
function parseFacts(text: string | undefined): BoxFacts | undefined {
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
		return valid ? (facts as unknown as BoxFacts) : undefined;
	} catch {
		return undefined;
	}
}

function ownLabels(tags: Readonly<Record<string, string>>): Record<string, string> {
	const { [BOX_TAG]: _box, [FACTS_TAG]: _facts, [OWNER_TAG]: _owner, ...own } = tags;
	return own;
}

/** A box that is one Modal sandbox. The first process is Modal's own sleep, bounded by the sandbox's timeout. */
class ModalBox implements Box {
	readonly id: string;
	readonly #sandbox: ModalSandbox;
	readonly #facts: BoxFacts;
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
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					stop();
					finish(err(new BoxError("timeout", `the program did not exit in ${timeoutMs} ms`)));
				}, timeoutMs);
			}
			process.wait().then(
				async (code) => {
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
				async (cause) => finish(err(await this.#failure("lost the program", cause))),
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
				// A program that already exited closed its input; its exit code reports it.
				close: () => process.stdin.close().catch(() => {}),
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

	/** Make the workspace. It runs before `workdir` can name a directory that exists, so it sets none. */
	async prepare(): Promise<Result<void, BoxError>> {
		try {
			const process = await this.#sandbox.exec(["mkdir", "-p", "--", this.#facts.workspace], {
				mode: "binary",
				timeoutMs: SETUP_TIMEOUT_MS,
			});
			const finished = await finish(this.#adapt(process, SETUP_TIMEOUT_MS, BACKGROUND_CONTEXT));
			if (!finished.ok) return finished;
			if (finished.value.exitCode === 0) return ok(undefined);
			return err(
				new BoxError("unknown", `could not make ${this.#facts.workspace}: ${finished.value.stderr.trim()}`),
			);
		} catch (cause) {
			return err(boxError("could not make the workspace", cause));
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
			if (context.abortSignal?.aborted) return err(new BoxError("aborted", "the call was aborted"));
			const lifetimeMs = Math.min(Math.ceil(spec.maxLifetimeMs / 1000) * 1000, MAX_LIFETIME_MS);
			const facts: BoxFacts = {
				provider: "modal",
				isolation: spec.isolation === "vm" ? "vm" : "gvisor",
				cpus: spec.cpus ?? null,
				memoryMb: spec.memoryMb ?? null,
				gpu: spec.gpu ?? null,
				workspace: spec.workspace ?? DEFAULT_WORKSPACE,
				maxLifetimeMs: lifetimeMs,
				snapshot: null,
			};
			let sandbox: ModalSandbox;
			try {
				const app = await theApp();
				const image = await imageOf(spec.image ?? options.image ?? DEFAULT_IMAGE);
				// The tags go in the create call: a crash after it leaves a sandbox that `list` can still find.
				sandbox = await sdk.sandboxes.create(app, image, {
					...(spec.isolation === undefined ? {} : { runtime: spec.isolation }),
					...(spec.gpu === undefined ? {} : { gpu: spec.gpu }),
					...(spec.cpus === undefined ? {} : { cpu: spec.cpus }),
					...(spec.memoryMb === undefined ? {} : { memoryMiB: spec.memoryMb }),
					...(spec.region === undefined ? {} : { regions: [spec.region] }),
					...(spec.env === undefined ? {} : { env: { ...spec.env } }),
					timeoutMs: lifetimeMs,
					tags: { ...spec.labels, [OWNER_TAG]: "1", [BOX_TAG]: "1", [FACTS_TAG]: JSON.stringify(facts) },
				});
			} catch (cause) {
				return err(boxError("could not start a box", cause));
			}
			const box = new ModalBox(sandbox, facts);
			const made = await box.prepare();
			if (!made.ok) {
				await box.destroy();
				return made;
			}
			return ok(box);
		},

		async attach(id: string, _context: Context): Promise<Result<Box | undefined, BoxError>> {
			try {
				const sandbox = await sdk.sandboxes.fromId(id);
				if ((await sandbox.poll()) !== null) return ok(undefined);
				const tags = await sandbox.getTags();
				const facts = tags[BOX_TAG] === undefined ? undefined : parseFacts(tags[FACTS_TAG]);
				return ok(facts === undefined ? undefined : new ModalBox(sandbox, facts));
			} catch (cause) {
				if (isNotFound(cause) || classify(cause) === "invalid") return ok(undefined);
				return err(boxError(`could not look up box ${id}`, cause));
			}
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
