import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
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
import { finish } from "./files.ts";

const DEFAULT_WORKSPACE = "/home/user/workspace";
const MAX_LIFETIME_MS = 24 * 3_600_000;
/** How much longer than the caller's timeout E2B lets a program run, so the host's own timer reports first. */
const EXEC_GRACE_MS = 5_000;
const SETUP_TIMEOUT_MS = 60_000;
const STDIN_CHUNK_BYTES = 512 * 1024;
const OWNER_TAG = "pi-transport";
const BOX_TAG = "pi-transport.box";
const FACTS_TAG = "pi-transport.facts";

/** What the SDK's `CommandHandle` gives back when a program ended: its exit code. */
export interface E2bCommandResult {
	readonly exitCode: number;
}

/** The part of the SDK's `CommandHandle` this package reads. `wait` throws a `CommandExitError` for a non-zero exit. */
export interface E2bCommandHandle {
	wait(): Promise<E2bCommandResult>;
	kill(): Promise<boolean>;
	sendStdin(data: string | Uint8Array): Promise<void>;
	closeStdin(): Promise<void>;
}

export interface E2bRunOptions {
	background: true;
	stdin: true;
	cwd?: string;
	envs?: Record<string, string>;
	timeoutMs: number;
	/** The SDK hands output over as text: bytes that are not UTF-8 do not survive. */
	onStdout(data: string): void;
	onStderr(data: string): void;
}

/** The part of the SDK's `Sandbox` this package calls. */
export interface E2bSandbox {
	readonly sandboxId: string;
	readonly commands: { run(command: string, options: E2bRunOptions): Promise<E2bCommandHandle> };
	readonly files: {
		write(path: string, data: ArrayBuffer): Promise<unknown>;
		read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
	};
	isRunning(): Promise<boolean>;
	/** Ends the sandbox. `false` when it was not there. */
	kill(): Promise<boolean>;
	getInfo(): Promise<E2bSandboxInfo>;
}

export interface E2bSandboxInfo {
	readonly sandboxId: string;
	readonly metadata: Readonly<Record<string, string>>;
	readonly cpuCount?: number;
	readonly memoryMB?: number;
}

/** What `create` is given: every field is one of the SDK's `SandboxOpts`. */
export interface E2bCreateOptions {
	template?: string;
	metadata: Record<string, string>;
	envs?: Record<string, string>;
	timeoutMs: number;
}

/**
 * The part of the E2B SDK's `Sandbox` class (its static methods) that `e2bBoxes` uses: the host passes the class itself.
 * This package imports nothing from the SDK, so a host chooses the SDK version.
 */
export interface E2bSdk {
	create(options: E2bCreateOptions): Promise<E2bSandbox>;
	connect(sandboxId: string): Promise<E2bSandbox>;
	list(options: { query: { metadata: Record<string, string>; state: ["running"] } }): {
		readonly hasNext: boolean;
		nextItems(): Promise<readonly E2bSandboxInfo[]>;
	};
}

export type E2bBoxesOptions = {
	/** The template (name or id) a spec that names no image starts from. Default: E2B's own `base`. */
	readonly template?: string;
};

function errorName(cause: unknown): string {
	return (cause as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
}

function errorMessage(what: string, cause: unknown): string {
	const name = errorName(cause);
	const text = cause instanceof Error ? cause.message : String(cause);
	return `${what}: ${name === "" ? "" : `${name}: `}${text}`.replace(/\s+/g, " ").slice(0, 300);
}

function classify(cause: unknown): BoxErrorCode {
	switch (errorName(cause)) {
		case "SandboxNotFoundError":
		case "NotFoundError":
			return "not_found";
		case "InvalidArgumentError":
			return "invalid";
		case "NotEnoughSpaceError":
		case "RateLimitError":
			return "capacity";
		case "AuthenticationError":
			return "unauthorized";
		case "TimeoutError":
			return "timeout";
		default:
			return "unknown";
	}
}

function boxError(what: string, cause: unknown): BoxError {
	return new BoxError(classify(cause), errorMessage(what, cause), cause);
}

const isNotFound = (cause: unknown): boolean => classify(cause) === "not_found";

/** One word of a shell command line: the argument as the program receives it, whatever it holds. */
const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

const isNullOr = (value: unknown, type: "number" | "string") => value === null || typeof value === type;

/** The facts a box's metadata holds, or `undefined` when it is not one this package wrote. */
function parseFacts(text: string | undefined): BoxFacts | undefined {
	if (text === undefined) return undefined;
	try {
		const facts = JSON.parse(text) as Record<string, unknown> | null;
		if (facts === null || typeof facts !== "object") return undefined;
		const valid =
			facts.provider === "e2b" &&
			facts.isolation === "vm" &&
			isNullOr(facts.cpus, "number") &&
			isNullOr(facts.memoryMb, "number") &&
			facts.gpu === null &&
			typeof facts.workspace === "string" &&
			facts.workspace.startsWith("/") &&
			isNullOr(facts.maxLifetimeMs, "number") &&
			facts.snapshot === null;
		return valid ? (facts as unknown as BoxFacts) : undefined;
	} catch {
		return undefined;
	}
}

function ownLabels(metadata: Readonly<Record<string, string>>): Record<string, string> {
	const { [BOX_TAG]: _box, [FACTS_TAG]: _facts, [OWNER_TAG]: _owner, ...own } = metadata;
	return own;
}

/** An output stream the SDK pushes text into and the caller reads as bytes. */
function channel() {
	const encoder = new TextEncoder();
	const queue: Uint8Array[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	const poke = () => {
		wake?.();
		wake = undefined;
	};
	return {
		push(text: string) {
			if (closed || text === "") return;
			queue.push(encoder.encode(text));
			poke();
		},
		close() {
			closed = true;
			poke();
		},
		async *stream(): AsyncGenerator<Uint8Array> {
			for (;;) {
				const next = queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (closed) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}

/** A box that is one E2B sandbox (a Firecracker microVM). */
class E2bBox implements Box {
	readonly id: string;
	readonly #sandbox: E2bSandbox;
	readonly #facts: BoxFacts;
	#destroyed = false;

	constructor(sandbox: E2bSandbox, facts: BoxFacts) {
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
		const out = channel();
		const errors = channel();
		let handle: E2bCommandHandle;
		try {
			handle = await this.#sandbox.commands.run(command.map(quote).join(" "), {
				background: true,
				stdin: true,
				cwd: this.#facts.workspace,
				// A program with no deadline of its own lives as long as the box can.
				timeoutMs:
					timeoutMs === undefined ? (this.#facts.maxLifetimeMs ?? MAX_LIFETIME_MS) : timeoutMs + EXEC_GRACE_MS,
				onStdout: (data) => out.push(data),
				onStderr: (data) => errors.push(data),
			});
		} catch (cause) {
			out.close();
			errors.close();
			return err(await this.#failure("could not start a program", cause));
		}
		return ok(this.#adapt(handle, out, errors, timeoutMs, context));
	}

	#adapt(
		handle: E2bCommandHandle,
		out: ReturnType<typeof channel>,
		errors: ReturnType<typeof channel>,
		timeoutMs: number | undefined,
		context: Context,
	): BoxProcess {
		const signal = context.abortSignal;
		const waited = new Promise<Result<number, BoxError>>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			let done = false;
			const finishWith = (result: Result<number, BoxError>) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				out.close();
				errors.close();
				resolve(result);
			};
			const stopProgram = () => void handle.kill().catch(() => {});
			const onAbort = () => {
				stopProgram();
				finishWith(err(new BoxError("aborted", "the call was aborted")));
			};
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					stopProgram();
					finishWith(err(new BoxError("timeout", `the program did not exit in ${timeoutMs} ms`)));
				}, timeoutMs);
			}
			handle.wait().then(
				(result) => finishWith(ok(result.exitCode)),
				// A non-zero exit is an error of the SDK carrying the code: for this package it is a value.
				async (cause) => {
					const code = (cause as { exitCode?: unknown } | null)?.exitCode;
					if (errorName(cause) === "CommandExitError" && typeof code === "number") return finishWith(ok(code));
					finishWith(err(await this.#failure("lost the program", cause)));
				},
			);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		return {
			stdin: {
				write: async (bytes) => {
					for (let at = 0; at < bytes.length; at += STDIN_CHUNK_BYTES) {
						await handle.sendStdin(bytes.subarray(at, at + STDIN_CHUNK_BYTES));
					}
				},
				// A program that already exited closed its input; its exit code reports it.
				close: () => handle.closeStdin().catch(() => {}),
			},
			stdout: out.stream(),
			stderr: errors.stream(),
			wait: () => waited,
		};
	}

	/** An error from the SDK as a box error: a sandbox that ended is `gone`, whatever the SDK called it. */
	async #failure(what: string, cause: unknown): Promise<BoxError> {
		if (this.#destroyed) return new BoxError("gone", `box ${this.id} has ended`, cause);
		const running = await this.#running();
		if (running.ok && !running.value) return new BoxError("gone", `box ${this.id} has ended`, cause);
		return boxError(what, cause);
	}

	async #running(): Promise<Result<boolean, BoxError>> {
		try {
			return ok(await this.#sandbox.isRunning());
		} catch (cause) {
			if (isNotFound(cause)) return ok(false);
			return err(boxError(`could not read the state of box ${this.id}`, cause));
		}
	}

	/** Make the workspace, whether or not it exists. */
	async prepare(context: Context): Promise<Result<void, BoxError>> {
		const out = channel();
		const errors = channel();
		try {
			const handle = await this.#sandbox.commands.run(`mkdir -p -- ${quote(this.#facts.workspace)}`, {
				background: true,
				stdin: true,
				timeoutMs: SETUP_TIMEOUT_MS,
				onStdout: (data) => out.push(data),
				onStderr: (data) => errors.push(data),
			});
			const finished = await finish(this.#adapt(handle, out, errors, SETUP_TIMEOUT_MS, context));
			if (!finished.ok) return finished;
			if (finished.value.exitCode === 0) return ok(undefined);
			return err(
				new BoxError("unknown", `could not make ${this.#facts.workspace}: ${finished.value.stderr.trim()}`),
			);
		} catch (cause) {
			return err(boxError("could not make the workspace", cause));
		}
	}

	/** Files travel through the SDK's file calls, which keep every byte; the programs' output does not. */
	async upload(files: readonly BoxFile[], _context: Context): Promise<Result<void, BoxError>> {
		if (this.#destroyed) return err(new BoxError("gone", `box ${this.id} has ended`));
		try {
			for (const file of files) {
				const path = posix.resolve(this.#facts.workspace, file.path);
				const copy = file.bytes.slice().buffer as ArrayBuffer;
				await this.#sandbox.files.write(path, copy);
				if (file.mode !== undefined) {
					const done = await this.#command(["chmod", file.mode.toString(8), "--", path]);
					if (!done.ok) return done;
					if (done.value.exitCode !== 0) {
						return err(new BoxError("unknown", `could not set the mode of ${path}: ${done.value.stderr.trim()}`));
					}
				}
			}
			return ok(undefined);
		} catch (cause) {
			return err(await this.#failure("could not upload files", cause));
		}
	}

	async download(paths: readonly string[], _context: Context): Promise<Result<readonly BoxFile[], BoxError>> {
		if (this.#destroyed) return err(new BoxError("gone", `box ${this.id} has ended`));
		const files: BoxFile[] = [];
		for (const path of paths) {
			try {
				const bytes = await this.#sandbox.files.read(posix.resolve(this.#facts.workspace, path), {
					format: "bytes",
				});
				files.push({ path, bytes: new Uint8Array(bytes) });
			} catch (cause) {
				if (isNotFound(cause)) return err(new BoxError("not_found", `${path} is not in box ${this.id}`, cause));
				return err(await this.#failure(`could not download ${path}`, cause));
			}
		}
		return ok(files);
	}

	async #command(argv: readonly string[]) {
		const started = await this.exec(argv, { timeoutMs: SETUP_TIMEOUT_MS }, { abortSignal: undefined } as Context);
		if (!started.ok) return started;
		return finish(started.value);
	}

	async status(): Promise<Result<BoxStatus, BoxError>> {
		if (this.#destroyed) return ok({ state: "ended", exitCode: null });
		const running = await this.#running();
		if (!running.ok) return running;
		return ok(running.value ? { state: "running" } : { state: "ended", exitCode: null });
	}

	async destroy(): Promise<Result<void, BoxError>> {
		if (this.#destroyed) return ok(undefined);
		try {
			await this.#sandbox.kill();
		} catch (cause) {
			const running = await this.#running();
			if (!isNotFound(cause) && !(running.ok && !running.value)) {
				return err(boxError(`could not kill box ${this.id}`, cause));
			}
		}
		this.#destroyed = true;
		return ok(undefined);
	}
}

/**
 * Boxes that are E2B sandboxes (Firecracker microVMs), through the host's own E2B SDK: pass its `Sandbox` class. E2B ends a
 * sandbox at its timeout on its own side, so a host that dies leaks nothing past `maxLifetimeMs` (E2B's plan decides the
 * longest it accepts: a longer one is refused by E2B, not clamped here). The spec's `image` is the template.
 *
 * Programs' output reaches the host as text: the SDK's output callbacks hand over strings, so a program's bytes that are not
 * valid UTF-8 do not survive. Input and files keep every byte. A host that moves bytes uses `upload` and `download`, which
 * is why `facts().bulk` says `files`.
 *
 * Refused before any E2B call: a `snapshot`, a GPU, an `isolation` other than `vm`, `cpus`, `memoryMb` and `region`
 * (the template decides those: `unsupported`), a lifetime that is not positive, a `workspace` that is not an absolute path
 * and a label key in the providers' own namespace (`invalid`). Boxes carry their facts in their metadata, so `attach` finds
 * them again after a restart. The spec's `env` is the sandbox's own.
 */
export function e2bBoxes(sdk: E2bSdk, options: E2bBoxesOptions = {}): BoxProvider {
	return {
		name: "e2b",

		async create(spec: BoxSpec, context: Context): Promise<Result<Box, BoxError>> {
			if (!(spec.maxLifetimeMs > 0)) return err(new BoxError("invalid", "maxLifetimeMs must be positive"));
			if (spec.workspace !== undefined && !spec.workspace.startsWith("/")) {
				return err(new BoxError("invalid", "workspace must be an absolute path"));
			}
			const reserved = Object.keys(spec.labels ?? {}).find(isReservedLabel);
			if (reserved !== undefined) {
				return err(new BoxError("invalid", `the label ${reserved} is in the providers' own namespace`));
			}
			if (spec.snapshot !== undefined) return err(new BoxError("unsupported", "e2b boxes start from a template"));
			if (spec.gpu !== undefined) return err(new BoxError("unsupported", "e2b boxes have no GPU"));
			if (spec.isolation !== undefined && spec.isolation !== "vm") {
				return err(new BoxError("unsupported", `an e2b box is a microVM, the spec asks for ${spec.isolation}`));
			}
			for (const field of ["cpus", "memoryMb", "region"] as const) {
				if (spec[field] !== undefined) {
					return err(new BoxError("unsupported", `the template decides ${field} of an e2b box`));
				}
			}
			if (context.abortSignal?.aborted) return err(new BoxError("aborted", "the call was aborted"));
			const lifetimeMs = Math.min(Math.ceil(spec.maxLifetimeMs / 1000) * 1000, MAX_LIFETIME_MS);
			const template = spec.image ?? options.template;
			let sandbox: E2bSandbox;
			let facts: BoxFacts;
			try {
				const baseFacts = {
					provider: "e2b",
					isolation: "vm" as const,
					cpus: null,
					memoryMb: null,
					gpu: null,
					workspace: spec.workspace ?? DEFAULT_WORKSPACE,
					maxLifetimeMs: lifetimeMs,
					snapshot: null,
					bulk: "files" as const,
				};
				// The metadata go in the create call: a crash after it leaves a sandbox that `list` can still find.
				sandbox = await sdk.create({
					...(template === undefined ? {} : { template }),
					...(spec.env === undefined ? {} : { envs: { ...spec.env } }),
					timeoutMs: lifetimeMs,
					metadata: {
						...spec.labels,
						[OWNER_TAG]: "1",
						[BOX_TAG]: "1",
						[FACTS_TAG]: JSON.stringify(baseFacts),
					},
				});
				facts = baseFacts;
				// The size is the template's: said as it is once the sandbox answers.
				try {
					const info = await sandbox.getInfo();
					facts = { ...baseFacts, cpus: info.cpuCount ?? null, memoryMb: info.memoryMB ?? null };
				} catch {
					// The facts keep their nulls: the size is not known, not wrong.
				}
			} catch (cause) {
				return err(boxError("could not start a box", cause));
			}
			const box = new E2bBox(sandbox, facts);
			const made = context.abortSignal?.aborted
				? err<void, BoxError>(new BoxError("aborted", "the call was aborted"))
				: await box.prepare(context);
			if (!made.ok || context.abortSignal?.aborted) {
				await box.destroy();
				return made.ok ? err(new BoxError("aborted", "the call was aborted")) : made;
			}
			return ok(box);
		},

		async attach(id: string, context: Context): Promise<Result<Box | undefined, BoxError>> {
			let box: E2bBox;
			try {
				const sandbox = await sdk.connect(id);
				if (!(await sandbox.isRunning())) return ok(undefined);
				const info = await sandbox.getInfo();
				const facts = info.metadata[BOX_TAG] === undefined ? undefined : parseFacts(info.metadata[FACTS_TAG]);
				if (facts === undefined) return ok(undefined);
				// The size is the template's, read again: the metadata holds what was known when the box was made.
				box = new E2bBox(sandbox, {
					...facts,
					cpus: info.cpuCount ?? facts.cpus,
					memoryMb: info.memoryMB ?? facts.memoryMb,
					bulk: "files",
				});
			} catch (cause) {
				if (isNotFound(cause) || classify(cause) === "invalid") return ok(undefined);
				return err(boxError(`could not look up box ${id}`, cause));
			}
			// A host that died between the create call and the workspace setup left a box with no workspace.
			const made = await box.prepare(context);
			return made.ok ? ok(box) : made;
		},

		async list(labels, _context: Context): Promise<Result<readonly BoxRef[], BoxError>> {
			const refs: BoxRef[] = [];
			try {
				const pages = sdk.list({ query: { metadata: { ...labels, [BOX_TAG]: "1" }, state: ["running"] } });
				while (pages.hasNext) {
					for (const info of await pages.nextItems()) {
						refs.push({ id: info.sandboxId, labels: ownLabels(info.metadata) });
					}
				}
			} catch (cause) {
				return err(boxError("could not list boxes", cause));
			}
			return ok(refs);
		},
	};
}
