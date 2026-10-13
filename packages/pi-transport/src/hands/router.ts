import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext, withoutAbortSignal } from "@earendil-works/chord/context";
import type { ConversationId, EnvTarget } from "@earendil-works/pi-durable";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileWatcher,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	toError,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { Box, BoxError, BoxProvider, BoxSpec } from "../box/box.ts";
import type { EnvironmentConfig, TransportConfig } from "../config.ts";
import { HandsDoc, SessionBoxesDoc, type Transport, TransportError, type TransportHost } from "../transport.ts";
import { boxEnv } from "./box-env.ts";

/** The label every box of a transport carries, so a host can list what it left behind. */
const TRANSPORT_LABEL = "pi-transport";
/** A lazy environment's directory before its box exists: a command started there runs in the box's own directory. */
const UNOPENED_CWD = ".";

/** One live box and the environments over it, one for each directory a conversation works in. */
type Held = { readonly box: Box; readonly envs: Map<string, ExecutionEnv> };

/** An environment over a box, or why there is none. `undefined`: the caller stopped waiting. */
type Opened = Result<ExecutionEnv, TransportError> | undefined;

function boxFailure(what: string, error: BoxError): TransportError {
	return new TransportError("box", `${what}: [${error.code}] ${error.message}`, error);
}

/**
 * The environment a conversation is handed before its box exists. Every call asks the transport for the box, which
 * creates it at the first one, so preparing a prompt costs nothing and a box that was lost is replaced at the next
 * call. Invariant: a box that cannot be had is the failure of the call that needed it, never a throw.
 */
class LazyEnv implements ExecutionEnv {
	readonly #pendingId: string;
	readonly #open: (cwd: string | undefined, context: Context) => Promise<Opened>;
	#opened: ExecutionEnv | undefined;
	#cwd: string | undefined;

	constructor(pendingId: string, open: (cwd: string | undefined, context: Context) => Promise<Opened>) {
		this.#pendingId = pendingId;
		this.#open = open;
	}

	get id(): string {
		return this.#opened?.id ?? this.#pendingId;
	}

	get cwd(): string {
		return this.#opened?.cwd ?? this.#cwd ?? UNOPENED_CWD;
	}

	/** Takes effect at the next call. A directory outside the box's workspace is not followed. */
	set cwd(value: string) {
		this.#cwd = value;
		this.#opened = undefined;
	}

	absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#file(path, context, (env) => env.absolutePath(path, context));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#file(path, context, (env) => env.canonicalPath(path, context));
	}

	readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#file(path, context, (env) => env.readTextFile(path, context));
	}

	readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		return this.#file(path, context, (env) => env.readTextLines(path, options, context));
	}

	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		return this.#file(path, context, (env) => env.openTextLineReader(path, context));
	}

	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#file(path, context, (env) => env.readBinaryFile(path, context));
	}

	openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		return this.#file(path, context, (env) => env.openBinaryReader(path, options, context));
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, context, (env) => env.writeFile(path, content, context));
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, context, (env) => env.appendFile(path, content, context));
	}

	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, context, (env) => env.truncateFile(path, size, context));
	}

	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, context, (env) => env.flushFile(path, context));
	}

	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return this.#file(sourcePath, context, (env) => env.renameFile(sourcePath, destinationPath, context));
	}

	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.#file(path, context, (env) => env.fileInfo(path, context));
	}

	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#file(path, context, (env) => env.listDir(path, context));
	}

	openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		return this.#file(path, context, (env) => env.openDirReader(path, context));
	}

	watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		return this.#file(targets[0]?.path ?? "", context, (env) => env.watch(targets, onChange, context));
	}

	exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.#file(path, context, (env) => env.exists(path, context));
	}

	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#file(path, context, (env) => env.createDir(path, options, context));
	}

	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		return this.#file(path, context, (env) => env.remove(path, options, context));
	}

	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#file("", context, (env) => env.createTempDir(prefix, context));
	}

	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		return this.#file("", context, (env) => env.createTempFile(options, context));
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const opened = await this.#resolve(context);
		if (opened === undefined) return err(new ExecutionError("aborted", "aborted"));
		// Not a spawn error: pi's bash tool would try the next form of the command, and ask for a box again.
		if (!opened.ok) return err(new ExecutionError("unknown", opened.error.message, opened.error));
		return opened.value.exec(command, options, context);
	}

	/** Nothing to do: the transport owns the commands in its boxes and stops them when it lets its boxes go. */
	async cleanup(_context: Context): Promise<void> {}

	async #resolve(context: Context): Promise<Opened> {
		const opened = await this.#open(this.#cwd, context);
		if (opened?.ok) this.#opened = opened.value;
		return opened;
	}

	async #file<T>(
		path: string,
		context: Context,
		run: (env: ExecutionEnv) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		const opened = await this.#resolve(context);
		if (opened === undefined) return err(new FileError("aborted", "aborted", path));
		if (!opened.ok) return err(new FileError("unknown", opened.error.message, path, opened.error));
		return run(opened.value);
	}
}

/**
 * The transport behind `transport()`.
 *
 * Invariants: a key (an environment, or an environment and a conversation) has at most one box at a time, and
 * concurrent first uses share its creation. A box's id is in the session's document before any tool runs in it, so a
 * transport opened later finds it. A box that could not be recorded is destroyed at once.
 */
class Router implements Transport {
	readonly #config: TransportConfig;
	readonly #host: TransportHost;
	readonly #opening = new Map<string, Promise<Result<Held, TransportError>>>();
	readonly #held = new Map<string, Held>();

	constructor(config: TransportConfig, host: TransportHost) {
		this.#config = config;
		this.#host = host;
	}

	readonly env = async (target: EnvTarget, context: Context): Promise<ExecutionEnv | undefined> => {
		const assigned = await target.read.snapshot(HandsDoc, target.conversationId, context);
		const id = assigned?.environment ?? this.#config.hands?.default;
		if (id === undefined) return undefined;
		// Own keys only: a name such as `constructor` is on every object.
		const environment = Object.hasOwn(this.#config.environments, id) ? this.#config.environments[id] : undefined;
		if (environment === undefined) {
			throw new TransportError(
				"unknown_environment",
				`this conversation's tools are assigned to "${id}", which the config does not declare`,
			);
		}
		const provider = this.#host.providers[environment.provider];
		// `local` with no provider of that name: this machine as the host already has it.
		if (provider === undefined) return undefined;
		return new LazyEnv(`${TRANSPORT_LABEL}:${environment.id}:unopened`, (cwd, callContext) =>
			this.#use(environment, provider, target, cwd ?? target.cwd, callContext),
		);
	};

	async assign(conversation: ConversationId, to: string, context: Context): Promise<Result<void, TransportError>> {
		const roles = this.#config.hands?.roles ?? {};
		const id = Object.hasOwn(roles, to) ? roles[to] : Object.hasOwn(this.#config.environments, to) ? to : undefined;
		if (id === undefined) {
			return err(
				new TransportError("unknown_environment", `"${to}" is neither a role of hands nor a declared environment`),
			);
		}
		try {
			await this.#host.commit(async (tx) => {
				(await tx.doc(HandsDoc, conversation)).environment = id;
			}, context);
			return ok(undefined);
		} catch (cause) {
			return err(new TransportError("store", `could not record the assignment: ${toError(cause).message}`, cause));
		}
	}

	async release(context: Context): Promise<void> {
		await Promise.all(this.#opening.values());
		const held = [...this.#held.values()];
		this.#held.clear();
		for (const { envs } of held) for (const env of envs.values()) await env.cleanup(context);
	}

	async destroy(context: Context): Promise<Result<void, TransportError>> {
		await Promise.all(this.#opening.values());
		const boxes = new Map<string, Box>();
		for (const { box } of this.#held.values()) boxes.set(box.id, box);
		await this.release(context);
		const left: string[] = [];
		let recorded: Record<string, string>;
		try {
			recorded = await this.#host.commit(async (tx) => ({ ...(await tx.doc(SessionBoxesDoc)).boxes }), context);
		} catch (cause) {
			return err(
				new TransportError("store", `could not read the session's boxes: ${toError(cause).message}`, cause),
			);
		}
		// Boxes an earlier transport left in the documents and this one never used.
		for (const [key, id] of Object.entries(recorded)) {
			if (boxes.has(id)) continue;
			const environment = this.#config.environments[key.split("@")[0] ?? ""];
			const provider = environment === undefined ? undefined : this.#host.providers[environment.provider];
			if (provider === undefined) {
				left.push(`${id} (no provider for "${key}")`);
				continue;
			}
			const attached = await provider.attach(id, context);
			if (!attached.ok) left.push(`${id} ([${attached.error.code}] ${attached.error.message})`);
			else if (attached.value !== undefined) boxes.set(id, attached.value);
		}
		for (const [id, box] of boxes) {
			const destroyed = await box.destroy(context);
			if (!destroyed.ok) left.push(`${id} ([${destroyed.error.code}] ${destroyed.error.message})`);
		}
		if (left.length > 0) return err(new TransportError("box", `could not end: ${left.join(", ")}`));
		try {
			await this.#host.commit(async (tx) => {
				(await tx.doc(SessionBoxesDoc)).boxes = {};
			}, context);
			return ok(undefined);
		} catch (cause) {
			return err(
				new TransportError("store", `could not clear the session's boxes: ${toError(cause).message}`, cause),
			);
		}
	}

	/** The environment over the box that serves `environment` for this conversation, in the directory it works in. */
	async #use(
		environment: EnvironmentConfig,
		provider: BoxProvider,
		target: EnvTarget,
		cwd: string | undefined,
		context: Context,
	): Promise<Opened> {
		const key = environment.scope === "session" ? environment.id : `${environment.id}@${target.conversationId}`;
		const live = this.#held.get(key);
		let held = live === undefined ? undefined : ok<Held, TransportError>(live);
		if (held === undefined) {
			let opening = this.#opening.get(key);
			if (opening === undefined) {
				// The box outlives the call that needed it first, so that call's abort does not stop the opening.
				opening = this.#openBox(key, environment, provider, target, withoutAbortSignal(context)).then((result) => {
					this.#opening.delete(key);
					if (result.ok) this.#held.set(key, result.value);
					return result;
				});
				this.#opening.set(key, opening);
			}
			try {
				held = await awaitWithContext(opening, context);
			} catch {
				return undefined;
			}
		}
		if (!held.ok) return held;
		const { box, envs } = held.value;
		const workspace = box.facts().workspace;
		// The agent's own directory counts only when it lies in the box's workspace: a path of the host means nothing there.
		const below = cwd === undefined || !posix.isAbsolute(cwd) ? ".." : posix.relative(workspace, cwd);
		const directory = cwd === undefined || below === ".." || below.startsWith("../") ? workspace : cwd;
		let env = envs.get(directory);
		if (env === undefined) {
			const lost = held.value;
			env = boxEnv(box, {
				cwd: directory,
				onLost: () => {
					if (this.#held.get(key) === lost) this.#held.delete(key);
				},
			});
			envs.set(directory, env);
		}
		return ok(env);
	}

	/** Find the box the session's document names for `key`, or create one and record it. Never rejects. */
	async #openBox(
		key: string,
		environment: EnvironmentConfig,
		provider: BoxProvider,
		target: EnvTarget,
		context: Context,
	): Promise<Result<Held, TransportError>> {
		let recorded: string | undefined;
		try {
			recorded = (await target.read.snapshot(SessionBoxesDoc, context))?.boxes[key];
		} catch (cause) {
			return err(
				new TransportError("store", `could not read the session's boxes: ${toError(cause).message}`, cause),
			);
		}
		if (recorded !== undefined) {
			const attached = await provider.attach(recorded, context);
			if (!attached.ok) {
				return err(
					boxFailure(`could not look for box ${recorded} of environment "${environment.id}"`, attached.error),
				);
			}
			if (attached.value !== undefined) return ok({ box: attached.value, envs: new Map() });
		}
		const created = await provider.create(this.#spec(environment), context);
		if (!created.ok) {
			return err(boxFailure(`could not create a box for environment "${environment.id}"`, created.error));
		}
		const box = created.value;
		try {
			await this.#host.commit(async (tx) => {
				(await tx.doc(SessionBoxesDoc)).boxes[key] = box.id;
			}, context);
		} catch (cause) {
			// A box nobody can find again would only run out its lifetime.
			await box.destroy(context);
			return err(new TransportError("store", `could not record box ${box.id}: ${toError(cause).message}`, cause));
		}
		return ok({ box, envs: new Map() });
	}

	#spec(environment: EnvironmentConfig): BoxSpec {
		const { image, snapshot, cpus, memoryMb, gpu, region, isolation } = environment;
		const workspace = this.#config.workspace.path;
		return {
			maxLifetimeMs: environment.maxLifetimeMs,
			labels: { ...this.#host.labels, [TRANSPORT_LABEL]: "1" },
			env: environment.env,
			...(image === undefined ? {} : { image }),
			...(snapshot === undefined ? {} : { snapshot }),
			...(cpus === undefined ? {} : { cpus }),
			...(memoryMb === undefined ? {} : { memoryMb }),
			...(gpu === undefined ? {} : { gpu }),
			...(region === undefined ? {} : { region }),
			...(isolation === undefined ? {} : { isolation }),
			...(workspace === undefined ? {} : { workspace }),
		};
	}
}

/**
 * Run a session's tools where its config says: `transport(config, host).env` is the Harness's `env`. Built once for
 * each Harness, from a config `parseTransportConfig` returned.
 *
 * Throws a `TransportError` for a config this release cannot serve: `unknown_provider` when an environment names a
 * provider the host did not pass (`local` excepted: with no `local` provider it means the host's own environment),
 * `unsupported` for `hands: "auto"` and for an environment with `expose`.
 */
export function transport(config: TransportConfig, host: TransportHost): Transport {
	for (const environment of Object.values(config.environments)) {
		if (environment.expose.length > 0) {
			throw new TransportError(
				"unsupported",
				`environment "${environment.id}" has expose, which is not available yet: no secret is passed into a box`,
			);
		}
		if (environment.provider !== "local" && host.providers[environment.provider] === undefined) {
			throw new TransportError(
				"unknown_provider",
				`environment "${environment.id}" names the provider "${environment.provider}", which the host did not pass`,
			);
		}
	}
	const targets = config.hands === undefined ? [] : [config.hands.default, ...Object.values(config.hands.roles)];
	if (targets.includes("auto")) {
		throw new TransportError("unsupported", 'hands: "auto" is not available yet: name an environment');
	}
	return new Router(config, host);
}
