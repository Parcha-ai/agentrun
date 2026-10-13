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
import { type Box, BoxError, type BoxProvider, type BoxSpec, isReservedLabel } from "../box/box.ts";
import type { EnvironmentConfig, TransportConfig } from "../config.ts";
import { HandsDoc, SessionBoxesDoc, type Transport, TransportError, type TransportHost } from "../transport.ts";
import { boxEnv } from "./box-env.ts";

/** What a lazy environment's id starts with, as a box environment's does. */
const ENV_ID_PREFIX = "pi-transport";
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
	/** A `destroy` that is under way. A use that comes meanwhile waits for it, then opens a box of its own. */
	#destroying: Promise<void> | undefined;
	/** A `release` that is under way. A use that comes meanwhile waits for it, then attaches the box anew. */
	#releasing: Promise<void> | undefined;

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
		const provider = ownValue(this.#host.providers, environment.provider);
		// `local` with no provider of that name: this machine as the host already has it.
		if (provider === undefined) return undefined;
		return new LazyEnv(`${ENV_ID_PREFIX}:${environment.id}:unopened`, (cwd, callContext) =>
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
		const run = this.#releaseAll(context);
		const settled = run.then(
			() => undefined,
			() => undefined,
		);
		this.#releasing = settled;
		try {
			await run;
		} finally {
			if (this.#releasing === settled) this.#releasing = undefined;
		}
	}

	async #releaseAll(context: Context): Promise<void> {
		await Promise.all(this.#opening.values());
		const held = [...this.#held.values()];
		this.#held.clear();
		for (const { envs } of held) for (const env of envs.values()) await env.cleanup(context);
	}

	async destroy(context: Context): Promise<Result<void, TransportError>> {
		// One at a time, and no box is opened meanwhile: its record would be written, then cleared with the rest.
		const earlier = this.#destroying;
		const run = (async () => {
			await earlier;
			return this.#destroyAll(context);
		})();
		const settled = run.then(
			() => undefined,
			() => undefined,
		);
		this.#destroying = settled;
		try {
			return await run;
		} finally {
			if (this.#destroying === settled) this.#destroying = undefined;
		}
	}

	async #destroyAll(context: Context): Promise<Result<void, TransportError>> {
		await Promise.all(this.#opening.values());
		const held = [...this.#held.values()].map(({ box }) => box);
		await this.#releaseAll(context);
		const tried = new Set<string>();
		/** Boxes that ended here, or that their provider no longer has. Only their records are cleared. */
		const ended = new Set<string>();
		const left: string[] = [];
		const end = async (box: Box): Promise<void> => {
			tried.add(box.id);
			let destroyed: Result<void, BoxError>;
			try {
				destroyed = await box.destroy(context);
			} catch (cause) {
				// A provider that throws where it should answer: the box is left, and the other boxes still end.
				destroyed = err(new BoxError("unknown", toError(cause).message, cause));
			}
			if (destroyed.ok) ended.add(box.id);
			else left.push(`${box.id} ([${destroyed.error.code}] ${destroyed.error.message})`);
		};
		// First the boxes in hand: they end even when the documents cannot be read.
		for (const box of held) await end(box);
		let recorded: Record<string, string>;
		try {
			recorded = await this.#host.commit(async (tx) => ({ ...(await tx.doc(SessionBoxesDoc)).boxes }), context);
		} catch (cause) {
			return err(
				new TransportError("store", `could not read the session's boxes: ${toError(cause).message}`, cause),
			);
		}
		// Then the boxes an earlier transport left in the documents and this one never used.
		for (const [key, id] of Object.entries(recorded)) {
			if (tried.has(id)) continue;
			const environment = ownValue(this.#config.environments, key.split("@")[0] ?? "");
			const provider = environment === undefined ? undefined : ownValue(this.#host.providers, environment.provider);
			if (provider === undefined) {
				left.push(`${id} (no provider for "${key}")`);
				continue;
			}
			let attached: Result<Box | undefined, BoxError>;
			try {
				attached = await provider.attach(id, context);
			} catch (cause) {
				attached = err(new BoxError("unknown", toError(cause).message, cause));
			}
			if (!attached.ok) left.push(`${id} ([${attached.error.code}] ${attached.error.message})`);
			else if (attached.value === undefined) ended.add(id);
			else await end(attached.value);
		}
		// A box that could not be ended keeps its record, so the next `destroy` finds it.
		try {
			await this.#host.commit(async (tx) => {
				const doc = await tx.doc(SessionBoxesDoc);
				doc.boxes = Object.fromEntries(Object.entries(doc.boxes).filter(([, id]) => !ended.has(id)));
			}, context);
		} catch (cause) {
			return err(
				new TransportError("store", `could not clear the session's boxes: ${toError(cause).message}`, cause),
			);
		}
		if (left.length > 0) return err(new TransportError("box", `could not end: ${left.join(", ")}`));
		return ok(undefined);
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
		for (;;) {
			const opened = await this.#useOnce(key, environment, provider, target, cwd, context);
			// A release or a destroy that came while the box opened has let it go: open it anew after that.
			if (opened === "again") continue;
			return opened;
		}
	}

	async #useOnce(
		key: string,
		environment: EnvironmentConfig,
		provider: BoxProvider,
		target: EnvTarget,
		cwd: string | undefined,
		context: Context,
	): Promise<Opened | "again"> {
		for (let closing = this.#destroying ?? this.#releasing; closing !== undefined; ) {
			try {
				await awaitWithContext(closing, context);
			} catch {
				return undefined;
			}
			closing = this.#destroying ?? this.#releasing;
		}
		const live = this.#held.get(key);
		let held = live === undefined ? undefined : ok<Held, TransportError>(live);
		if (held === undefined) {
			let opening = this.#opening.get(key);
			if (opening === undefined) {
				// The box outlives the call that needed it first, so that call's abort does not stop the opening.
				opening = this.#openBox(key, environment, provider, target, withoutAbortSignal(context))
					// A provider that throws where it should answer with an error: this call fails and the next asks again.
					.catch((cause): Result<Held, TransportError> => {
						const message = `could not open a box for environment "${environment.id}": ${toError(cause).message}`;
						return err(new TransportError("box", message, cause));
					})
					.then((result) => {
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
		if (this.#held.get(key) !== held.value) return "again";
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

	/** Find the box the session's document names for `key`, or create one and record it. */
	async #openBox(
		key: string,
		environment: EnvironmentConfig,
		provider: BoxProvider,
		target: EnvTarget,
		context: Context,
	): Promise<Result<Held, TransportError>> {
		let recorded: string | undefined;
		try {
			const boxes = (await target.read.snapshot(SessionBoxesDoc, context))?.boxes;
			recorded = boxes === undefined ? undefined : ownValue(boxes, key);
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
			// The host's labels and nothing of ours: providers mark their own boxes, and `pi-transport` keys are theirs.
			...(this.#host.labels === undefined ? {} : { labels: this.#host.labels }),
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
 * Throws a plain `Error` for a host label in the providers' own namespace (`pi-transport` and the keys under it), and
 * a `TransportError` for a config this release cannot serve: `unknown_provider` when an environment names a
 * provider the host did not pass (`local` excepted: with no `local` provider it means the host's own environment),
 * `unsupported` for `hands: "auto"` and for an environment with `expose`.
 */
export function transport(config: TransportConfig, host: TransportHost): Transport {
	const reserved = Object.keys(host.labels ?? {}).find(isReservedLabel);
	if (reserved !== undefined) {
		throw new Error(`TransportHost.labels: the key ${reserved} belongs to providers, which mark their own boxes`);
	}
	for (const environment of Object.values(config.environments)) {
		if (environment.expose.length > 0) {
			throw new TransportError(
				"unsupported",
				`environment "${environment.id}" has expose, which is not available yet: no secret is passed into a box`,
			);
		}
		if (environment.provider !== "local" && ownValue(host.providers, environment.provider) === undefined) {
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

/** The value under an object's own key, never one it inherits: an id such as `constructor` is on every object. */
function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}
