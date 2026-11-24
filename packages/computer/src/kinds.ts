// The kind registry: the computer an agent is given, its setting kind, and the providers Settings offers for it. Two
// axes: the machine kind is the protocol's (capabilities().kind, KIND_SHAPES); the setting kind is what an agent is
// given in Settings, `computer: { kind, provider? }`, as machine kinds and capability groups. Whether a provider serves
// a setting kind is computed from its capabilities alone (serves), never kept beside them: a provider that drops a
// group stops serving the kind. The model's tools are not here: they live in the kernel's tool registry, keyed by
// these groups.
// The providers Settings offers (PROVIDERS) are derived from the providers' descriptors (descriptor.ts), each declared
// once in its descriptor module: loading this loads descriptors (data) alone, never a provider module or a vendor SDK.
// The setting kinds themselves (SETTING_KINDS) are a leaf of their own, setting-kinds.ts, which descriptor.ts reads too.
import { derivedMounts, type ProviderDescriptor } from "./descriptor.js";
import { DESCRIPTORS } from "./descriptors/index.js";
import type { Group, HelloResult } from "./protocol.js";
import type { ComputerCapabilities } from "./provider.js";
import type { Result } from "./result.js";
import { type ComputerSettingKind, SETTING_KIND_NAMES, SETTING_KINDS, type SettingKindSpec } from "./setting-kinds.js";

/**
 * The capabilities serves() and kindOf() read: one configuration a provider offers, with the GPUs it offers (Settings'
 * GPU choice), and whether it keeps a computer for an agent (`persistence`, as its built provider declares it: Settings'
 * persistent choice). In a descriptor, `image` is the name an agent's setting selects it by (Orgo's `windows`), the image
 * its computer starts from, and `options` are what create() takes to build it ({ os: "windows" }), beside the keys. A
 * configuration with no image is the one a setting that names none gets, as is the one whose image is the kind's
 * defaultImage.
 */
export type KindCapabilities = Pick<ComputerCapabilities, "kind" | "groups" | "gpu" | "persistence"> & {
	readonly image?: string;
	readonly options?: Readonly<Record<string, unknown>>;
};

/** Why capabilities do not serve a setting kind, in words; none when they do. */
export function servingRefusals(capabilities: KindCapabilities, kind: ComputerSettingKind): string[] {
	const spec = Object.hasOwn(SETTING_KINDS, kind) ? SETTING_KINDS[kind] : undefined;
	if (spec === undefined) return [`${JSON.stringify(kind)} is not a setting kind: ${SETTING_KIND_NAMES.join(", ")}`];
	if (spec.machineKinds.length === 0) return [`kind ${kind} is no computer: no provider serves it`];
	const refusals: string[] = [];
	if (!spec.machineKinds.includes(capabilities.kind)) refusals.push(`kind ${kind} is a ${spec.machineKinds.join(" or ")} machine, not a ${capabilities.kind} one`);
	const missing = missingGroups(spec, capabilities.groups);
	if (missing.length > 0) refusals.push(`kind ${kind} needs groups ${missing.join(", ")}, which the provider does not declare`);
	return refusals;
}

/** The groups a setting kind requires that `groups` lacks; a groups that is no list lacks them all. */
function missingGroups(spec: SettingKindSpec, groups: unknown): Group[] {
	const declared: readonly unknown[] = Array.isArray(groups) ? groups : [];
	return spec.required.filter((group) => !declared.includes(group));
}

/**
 * The groups a computer's hello must add to serve the setting kind its machine kind belongs to: the required groups
 * hello.groups lacks, for the SETTING_KINDS entry whose machineKinds holds hello.kind. Empty when it serves that kind.
 * A desktop that declares no input.pointer can't be given to an agent, so serve refuses it at connect and pairing, and
 * health.kind-served fails a driver whose hello says so.
 */
export function kindServed(hello: Pick<HelloResult, "kind" | "groups">): Group[] {
	const kind = SETTING_KIND_NAMES.find((name) => SETTING_KINDS[name].machineKinds.includes(hello.kind));
	if (kind === undefined) return [];
	return missingGroups(SETTING_KINDS[kind], hello.groups);
}

/** Whether a provider with these capabilities serves the kind: its machine kind is one of the kind's, and it declares every required group. */
export function serves(capabilities: KindCapabilities, kind: ComputerSettingKind): boolean {
	return servingRefusals(capabilities, kind).length === 0;
}

/** The setting kind these capabilities serve, or undefined when they serve none. Machine kinds are apart, so at most one. */
export function kindOf(capabilities: KindCapabilities): ComputerSettingKind | undefined {
	return SETTING_KIND_NAMES.find((kind) => serves(capabilities, kind));
}

/** The images a kind's configurations offer by name (`serving`: those that serve it), the kind's default first when it is one. */
export function imagesOf(serving: readonly Pick<KindCapabilities, "image">[], defaultImage: string | undefined): string[] {
	const names = [...new Set(serving.flatMap((one) => (one.image === undefined ? [] : [one.image])))];
	return defaultImage !== undefined && names.includes(defaultImage) ? [defaultImage, ...names.filter((name) => name !== defaultImage)] : names;
}

/**
 * The configuration a setting selects among a kind's (`serving`): the one its image names; with none named, the one
 * whose image is the kind's default, else one with no image, else the first. Undefined when the image names none.
 */
export function configurationOf<Configuration extends Pick<KindCapabilities, "image">>(serving: readonly Configuration[], image: string | undefined, defaultImage: string | undefined): Configuration | undefined {
	if (image !== undefined) return serving.find((one) => one.image === image);
	return serving.find((one) => defaultImage !== undefined && one.image === defaultImage) ?? serving.find((one) => one.image === undefined) ?? serving[0];
}

/**
 * A provider as Settings shows it: its descriptor's data (descriptor.ts documents each field), with `mounts` derived
 * (derivedMounts: sync added where a configuration takes it; [] cannot mount the run's folder), and `kinds`, the setting
 * kinds its capabilities serve (serves), never written by hand.
 */
export type ProviderEntry = Omit<ProviderDescriptor, "load"> & { readonly kinds: readonly ComputerSettingKind[] };

/** A descriptor as Settings shows it: its data, and the setting kinds its capabilities serve, derived by serves(). */
export function entryOf(descriptor: ProviderDescriptor): ProviderEntry {
	const { load: _load, ...data } = descriptor;
	return { ...data, mounts: derivedMounts(descriptor), kinds: SETTING_KIND_NAMES.filter((kind) => descriptor.capabilities.some((one) => serves(one, kind))) };
}

/** Every provider Settings offers: each built-in descriptor (descriptors/index.ts), as entryOf gives it. */
export const PROVIDERS: readonly ProviderEntry[] = DESCRIPTORS.map(entryOf);

/** What testConnection is given: the provider's keys by their serve-side names, and the caller's signal. */
export interface TestConnectionOptions {
	keys: Readonly<Record<string, string>>;
	signal?: AbortSignal;
}

/**
 * Settings' "test connection": ONE account-level read with the given keys (a list by label, the vendor's whoami) that
 * never creates a computer, so it never spends. ok with words on what it read; else unauthorized, unreachable, refused
 * or another code, the message never carrying a key. A full live check (create, then the kind's conformance) is the QA
 * board's, not this.
 */
export type TestConnection = (providerId: string, options: TestConnectionOptions) => Promise<Result<{ detail: string }>>;
