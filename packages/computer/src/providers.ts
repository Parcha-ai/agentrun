// The registry: id → the provider module's lazy import, derived from the built-in descriptors (descriptors/index.ts),
// so a new computer is its descriptor and its provider file, with no line here. The conformance CLI and serve resolve
// providers through it alone. Every import is lazy: loading the registry loads no provider and no vendor SDK.
// ProviderId is any id: a descriptor from outside this package (CP-3) is as much a provider as a built-in one.
//
// A provider is built from its options alone, create(options), its key included: the library reads no environment
// (README, Settings). The caller owns its settings' names: serve passes its own (DAYTONA_API_KEY, MODAL_TOKEN_ID, ...),
// and the conformance CLI's modules read their COMPUTER_<ID>_* names and pass them in.
import type { RunFolder } from "./conformance/types.js";
import type { ProviderDescriptor } from "./descriptor.js";
import { DESCRIPTORS } from "./descriptors/index.js";
import type { KindCapabilities } from "./kinds.js";
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
	 * The machine kind and groups of each configuration it offers, as its built providers' capabilities() declare them:
	 * the kind registry's entry for it (PROVIDERS in kinds.ts) holds the same, and derives its setting kinds from them.
	 */
	readonly CAPABILITIES: readonly KindCapabilities[];
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

/** A provider's id: any descriptor's. The built-in ones are BuiltinProviderId. */
export type ProviderId = string;

type Builtin = (typeof DESCRIPTORS)[number];
/** The id of a provider this package holds. */
export type BuiltinProviderId = Builtin["id"];

/** Each built-in id's lazy import of its provider module: its descriptor's load(). */
export const providers = Object.fromEntries(DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.load])) as { readonly [D in Builtin as D["id"]]: D["load"] };

/** The options a built-in id's create() takes. */
export type ProviderOptions<Id extends BuiltinProviderId> = Parameters<Awaited<ReturnType<Extract<Builtin, { id: Id }>["load"]>>["create"]>[0];

/** Every built-in id, in the registry's order. */
export const providerIds: readonly BuiltinProviderId[] = DESCRIPTORS.map((descriptor) => descriptor.id);

/** Whether id names a provider this package holds. */
export function isProviderId(id: string): id is BuiltinProviderId {
	return Object.hasOwn(providers, id);
}

/** A built-in provider's descriptor, or undefined for an id this package does not hold. */
export function descriptorOf(id: string): ProviderDescriptor | undefined {
	return DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

/** The provider file's module for an id; an id the registry does not hold is refused, naming the ones it does. */
export async function providerModule(id: string): Promise<ProviderModule> {
	const descriptor = descriptorOf(id);
	if (descriptor === undefined) throw new Error(`unknown computer provider ${JSON.stringify(id)}: the registry holds ${providerIds.join(", ")}`);
	return descriptor.load();
}

/** The provider for an id, built by the provider file's create() from the options given, and nothing else. */
export async function providerFor<Id extends BuiltinProviderId>(id: Id, options: ProviderOptions<Id>): Promise<ComputerProvider>;
export async function providerFor(id: ProviderId, options: object): Promise<ComputerProvider>;
export async function providerFor(id: ProviderId, options?: object): Promise<ComputerProvider> {
	return (await providerModule(id)).create(options ?? {});
}
