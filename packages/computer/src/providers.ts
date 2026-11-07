// The registry: one line per computer, id → () => import("./<vendor>.js"). The conformance CLI (and serve, once wired)
// resolves providers through it alone, so a new computer is its provider file and its line here, with no edit to either. Every import is
// lazy: loading the registry loads no provider and no vendor SDK.
import type { ComputerProvider } from "./provider.js";

/** Where a provider's settings are read: process.env, or a record of the same shape. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * What a conformance module exports, the CLI's contract for a module given by path too: createProvider(), and optionally
 * createDriftedProvider() for the drift case, conformanceImage() for a run that names no image, and conformanceNotes for
 * the report. The CLI passes each function its options, which a module may ignore.
 */
export interface ConformanceModule {
	createProvider(options?: object): ComputerProvider | Promise<ComputerProvider>;
	createDriftedProvider?(options?: object): ComputerProvider | Promise<ComputerProvider>;
	conformanceImage?(options?: object): string | Promise<string>;
	conformanceNotes?: string[];
}

/** What every registry line resolves to: the provider file's module. */
export interface ProviderModule {
	/** Every variable fromEnv reads, by role: each named COMPUTER_<ID>_*, never a vendor's bare variable. */
	readonly ENV: Readonly<Record<string, string>>;
	/**
	 * The provider, built from those variables alone; it throws in words when one is missing or wrong. A key is read here,
	 * when the provider is built, and never when the module loads.
	 */
	fromEnv(env?: ProviderEnv): ComputerProvider | Promise<ComputerProvider>;
	/**
	 * The module the conformance CLI runs this provider through: its run's bounds, its drifted twin, its image and notes.
	 * Without one the CLI runs fromEnv()'s provider, and the drift case skips.
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

/** The provider for an id, built from the environment by the provider file's fromEnv(). */
export async function providerFromEnv(id: string, env: ProviderEnv = process.env): Promise<ComputerProvider> {
	return (await providerModule(id)).fromEnv(env);
}
