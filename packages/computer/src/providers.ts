// The registry: one line per computer, id → () => import("./<vendor>.js"). The conformance CLI (and serve, once wired)
// resolves providers through it alone, so a new computer is its provider file and its line here, with no edit to either. Every import is
// lazy: loading the registry loads no provider and no vendor SDK.
//
// A provider is built from its options alone, create(options), its key included: the library reads no environment
// (README, Settings). The caller owns its settings' names: serve passes its own (DAYTONA_API_KEY, MODAL_TOKEN_ID, ...),
// and the conformance CLI's modules read their COMPUTER_<ID>_* names and pass them in.
import type { RunFolder } from "./conformance/types.js";
import type { MountKind } from "./mount.js";
import type { ComputerProvider } from "./provider.js";

/** Where the conformance side reads its settings: process.env, or a record of the same shape. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * What a conformance module exports, the CLI's contract for a module given by path too: createProvider(), and optionally
 * createDriftedProvider() for the drift case, conformanceImage() for a run that names no image, conformanceNotes for
 * the report, mountFor() for the mount cases, and settingsFromEnv(env), the provider's options it reads from the
 * environment by its COMPUTER_<ID>_* names, with ENV, those names by role. The CLI passes each function its options,
 * which a module may ignore.
 */
export interface ConformanceModule {
	createProvider(options?: object): ComputerProvider | Promise<ComputerProvider>;
	createDriftedProvider?(options?: object): ComputerProvider | Promise<ComputerProvider>;
	/** A fresh run folder for a mount kind the provider declares, with its outside; undefined for a kind it cannot make. */
	mountFor?(kind: MountKind, options?: object): RunFolder | undefined | Promise<RunFolder | undefined>;
	conformanceImage?(options?: object): string | Promise<string>;
	conformanceNotes?: string[];
	settingsFromEnv?(env?: ProviderEnv): object;
	/** Every name settingsFromEnv (and the module) reads, by role: COMPUTER_<ID>_*, or its live switch. */
	readonly ENV?: Readonly<Record<string, string>>;
}

/** What every registry line resolves to: the provider file's module. */
export interface ProviderModule {
	/**
	 * The mount kinds its computers take, the same as its provider's capabilities().mount (none: []): a caller tells which
	 * provider binds a local folder from the registry alone, without building one.
	 */
	readonly MOUNT: readonly MountKind[];
	/**
	 * The provider, built from its options alone, its key included; it reads no environment, and throws in words when an
	 * option is missing or wrong, never echoing a key. Each provider file types its own options.
	 */
	create(options: object): ComputerProvider | Promise<ComputerProvider>;
	/**
	 * The module the conformance CLI runs this provider through: the settings it reads from the environment, its run's
	 * bounds, its drifted twin, its image and notes. Without one the CLI runs create()'s provider with the CLI's options,
	 * and the drift case skips.
	 */
	conformance?(): Promise<ConformanceModule>;
}

export const providers = {
	docker: () => import("./docker.js"),
	modal: () => import("./modal.js"),
	daytona: () => import("./daytona.js"),
	e2b: () => import("./e2b.js"),
} satisfies Record<string, () => Promise<ProviderModule>>;

export type ProviderId = keyof typeof providers;

/** The options a registry id's create() takes. */
export type ProviderOptions<Id extends ProviderId> = Parameters<Awaited<ReturnType<(typeof providers)[Id]>>["create"]>[0];

/** Every id, in the registry's order. */
export const providerIds = Object.keys(providers) as ProviderId[];

export function isProviderId(id: string): id is ProviderId {
	return Object.hasOwn(providers, id);
}

/** The provider file's module for an id; an id the registry does not hold is refused, naming the ones it does. */
export async function providerModule(id: string): Promise<ProviderModule> {
	if (!isProviderId(id)) throw new Error(`unknown computer provider ${JSON.stringify(id)}: the registry holds ${providerIds.join(", ")}`);
	return providers[id]();
}

/** The provider for an id, built by the provider file's create() from the options given, and nothing else. */
export async function providerFor<Id extends ProviderId>(id: Id, options: ProviderOptions<Id>): Promise<ComputerProvider> {
	return (await providerModule(id)).create(options as object);
}
