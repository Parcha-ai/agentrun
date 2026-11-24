// The rules every conformance module reads its settings by, said once: the live switch before any other setting, a key
// from the module's own COMPUTER_* name alone, each option whose name is set, and the run's cap. hostedModule builds the
// run's provider, its drifted twin and the sweep's host of a module on the shared adapter from one spec.
import { createHash } from "node:crypto";
import type { MachineHost } from "../host.js";
import type { Result } from "../result.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

export type Env = Record<string, string | undefined>;

/** A conformance run's computers live at most this long, unless the vendor's own end says otherwise (Orgo, the phone). */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** A run's cap: the one asked for (COMPUTER_<VENDOR>_MAX_LIFETIME_MS) when it is shorter, else CONFORMANCE_MAX_LIFETIME_MS. */
export const runCap = (asked: number | undefined): number => Math.min(asked ?? CONFORMANCE_MAX_LIFETIME_MS, CONFORMANCE_MAX_LIFETIME_MS);

/** Refuses unless env[name] is "1": what the run does, then the switch, with whose key it takes when that is said. */
export function requireLive(env: Env, name: string, what: string, whose?: string): void {
	if (env[name] !== "1") throw new Error(`${what}: set ${name}=1${whose === undefined ? "" : `, with ${whose},`} to run it`);
}

/** env[name], set and not empty; else a refusal naming it and the bare name it is never read from. Never echoes a value. */
export function requiredSecret(env: Env, name: string, what: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`set ${name} to ${what}: the conformance module reads it there and nowhere else, never from ${name.replace(/^COMPUTER_/, "")}`);
	return value;
}

/** Each option of names (option to env name) whose name is set to a value that is not empty. */
export function setOptions<N extends Record<string, string>>(env: Env, names: N): { [K in keyof N]?: string } {
	const set: { [K in keyof N]?: string } = {};
	for (const option of Object.keys(names) as (keyof N & string)[]) {
		const value = env[names[option] as string];
		if (value) set[option] = value;
	}
	return set;
}

/** maxLifetimeMs from env[name] when it is set: a whole number of milliseconds, else refused in words with an example. */
export function lifetimeFromEnv(env: Env, name: string, example: string): { maxLifetimeMs?: number } {
	const lifetime = env[name] || undefined;
	if (lifetime === undefined) return {};
	if (!/^\d+$/.test(lifetime)) throw new Error(`${name} is a whole number of milliseconds, such as ${example}`);
	return { maxLifetimeMs: Number(lifetime) };
}

/** A module's kind from its COMPUTER_<VENDOR>_KIND as create() options: none when it is unset or empty, else what it says. */
export const kindFrom = (env: Env, name: string): { kind?: "desktop" | "linux" } => (env[name] ? { kind: env[name] as "desktop" | "linux" } : {});

/** A key as a sweep's scope names it, never the key itself: "sha256:" and the first 12 hex digits of its hash. */
export const keyPrint = (key: string): string => `sha256:${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12)}`;

/** The image the provider's prepareImage() answers; on failure its words, after `prefix: ` when given. */
export async function preparedImage(provider: { prepareImage(context?: { signal?: AbortSignal }): Promise<Result<string>> }, signal?: AbortSignal, prefix?: string): Promise<string> {
	const ready = await provider.prepareImage(signal ? { signal } : {});
	if (!ready.ok) throw new Error(prefix === undefined ? ready.error.message : `${prefix}: ${ready.error.message}`);
	return ready.value;
}

/** What a hosted module takes from its caller beside its vendor's options. */
export interface HostedModuleOptions {
	/** Where the settings are read; default process.env. */
	env?: Env;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
}

export interface HostedModuleSpec<O extends HostedModuleOptions, S extends object, P extends { readonly host: MachineHost }> {
	/** The live switch, and what its refusal says the run does and whose key it takes (requireLive). */
	live: { name: string; what: string; whose: string };
	settingsFromEnv(env: Env): S;
	/** The provider file's create(). */
	create(options: object): Promise<P>;
	/** Options every provider the module makes takes, the sweep's host's included: each when given (truthy). */
	host: readonly (keyof O)[];
	/** Options the run's provider and its twin alone take, after the host's: each when given (truthy). */
	run: readonly (keyof O)[];
	/** The same, each when it is not undefined: an empty daemonPath still stands over COMPUTER_<VENDOR>_DAEMON. */
	runDefined?: readonly (keyof O)[];
	/** Read from env for the run's provider and its twin alone, right after the settings (Modal's kind). */
	runFromEnv?(env: Env): object;
	/** Where the sweep lists, in words, from the settings. */
	scope?(settings: S): string;
}

export interface HostedModule<O extends HostedModuleOptions, P> {
	live(env: Env): void;
	/** The provider the CLI runs; throws in words without the live switch, or when a setting is missing or wrong. */
	createProvider(options?: O): Promise<P>;
	/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
	createDriftedProvider(options?: O): Promise<P>;
	/** The host the live sweep lists and deletes through, from the same settings; no live switch, since it makes nothing. */
	createHost(options?: O): Promise<MachineHost>;
}

/** The options of `names` that `given` takes. */
function picked<O extends object>(options: O, names: readonly (keyof O)[], given: (value: unknown) => boolean): Partial<O> {
	const out: Partial<O> = {};
	for (const name of names) if (given(options[name])) out[name] = options[name];
	return out;
}

/**
 * A hosted module's providers from its spec. Each create() gets the settings, then runFromEnv's, the host options, the
 * run options, the twin's built daemon, then the run's cap, in that order: a later key wins, so an option's daemonPath
 * is taken over COMPUTER_<VENDOR>_DAEMON, the twin's build over both, and the cap over an env lifetime that is longer.
 */
export function hostedModule<O extends HostedModuleOptions, S extends object, P extends { readonly host: MachineHost }>(
	spec: HostedModuleSpec<O, S, P> & { scope(settings: S): string },
): HostedModule<O, P> & { sweepScope(options?: { env?: Env }): string };
export function hostedModule<O extends HostedModuleOptions, S extends object, P extends { readonly host: MachineHost }>(spec: HostedModuleSpec<O, S, P>): HostedModule<O, P>;
export function hostedModule<O extends HostedModuleOptions, S extends object, P extends { readonly host: MachineHost }>(
	spec: HostedModuleSpec<O, S, P>,
): HostedModule<O, P> & { sweepScope?(options?: { env?: Env }): string } {
	const live = (env: Env): void => requireLive(env, spec.live.name, spec.live.what, spec.live.whose);
	const hostOptions = (options: O) => picked(options, spec.host, Boolean);
	const runOptions = (options: O, env: Env) => ({
		...spec.runFromEnv?.(env),
		...hostOptions(options),
		...picked(options, spec.run, Boolean),
		...picked(options, spec.runDefined ?? [], (value) => value !== undefined),
	});
	const capOf = (settings: S) => runCap((settings as { maxLifetimeMs?: number }).maxLifetimeMs);
	const { scope } = spec;
	return {
		live,
		createProvider: async (options = {} as O) => {
			const { env = process.env } = options;
			live(env);
			const settings = spec.settingsFromEnv(env);
			return spec.create({ ...settings, ...runOptions(options, env), maxLifetimeMs: capOf(settings) });
		},
		createDriftedProvider: async (options = {} as O) => {
			const { env = process.env, buildDaemon = (version: string) => buildDriftDaemon("amd64", version) } = options;
			live(env);
			const settings = spec.settingsFromEnv(env);
			return spec.create({ ...settings, ...runOptions(options, env), daemonPath: await buildDaemon(DRIFT_VERSION), maxLifetimeMs: capOf(settings) });
		},
		createHost: async (options = {} as O) => (await spec.create({ ...spec.settingsFromEnv(options.env ?? process.env), ...hostOptions(options) })).host,
		...(scope === undefined ? {} : { sweepScope: ({ env = process.env }: { env?: Env } = {}) => scope(spec.settingsFromEnv(env)) }),
	};
}
