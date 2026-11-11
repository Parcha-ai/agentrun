// The kind registry: the computer an agent is given, its setting kind, and the providers Settings offers for it. Two
// axes: the machine kind is the protocol's (capabilities().kind, KIND_SHAPES); the setting kind is what an agent is
// given in Settings, `computer: { kind, provider? }`, as machine kinds and capability groups. Whether a provider serves
// a setting kind is computed from its capabilities alone (serves), never kept beside them: a provider that drops a
// group stops serving the kind. The model's tools are not here: they live in the kernel's tool registry, keyed by
// these groups.
// The providers Settings offers (PROVIDERS) are derived from the providers' descriptors (descriptor.ts), each declared
// once in its descriptor module: loading this loads descriptors (data) alone, never a provider module or a vendor SDK.
import type { DescriptorKey, DescriptorSetting, ProviderDescriptor } from "./descriptor.js";
import { DESCRIPTORS } from "./descriptors/index.js";
import type { MountKind } from "./mount.js";
import type { ComputerKind, Group } from "./protocol.js";
import type { ComputerCapabilities } from "./provider.js";
import type { Result } from "./result.js";

/**
 * What an agent is given. none: the run's folder only, no computer. sandbox: a Linux shell with files and processes.
 * desktop: a screen, a pointer and keys (Linux, Windows or macOS), a shell when it has one. phone: a screen, touch and
 * apps. browser: a CDP target.
 */
export type ComputerSettingKind = "none" | "sandbox" | "desktop" | "phone" | "browser";

/** A setting kind's machine kinds and groups. */
export interface SettingKindSpec {
	/** The capabilities().kind values that can serve it. */
	machineKinds: readonly ComputerKind[];
	/** Every one declared, and passing its conformance cases, to serve it. */
	required: readonly Group[];
	/** Brought when declared. */
	optional: readonly Group[];
}

export const SETTING_KINDS: Readonly<Record<ComputerSettingKind, SettingKindSpec>> = {
	none: { machineKinds: [], required: [], optional: [] },
	sandbox: { machineKinds: ["linux"], required: ["exec", "files", "processes"], optional: [] },
	desktop: { machineKinds: ["desktop"], required: ["screen", "input.pointer", "input.keys"], optional: ["exec", "files", "processes", "apps", "stream"] },
	phone: { machineKinds: ["android", "ios"], required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "apps.ui_tree", "stream"] },
	browser: { machineKinds: ["browser"], required: ["cdp"], optional: ["stream", "downloads"] },
};

/** Every setting kind, in the table's order. */
export const SETTING_KIND_NAMES = Object.keys(SETTING_KINDS) as ComputerSettingKind[];

/** The capabilities serves() and kindOf() read. */
export type KindCapabilities = Pick<ComputerCapabilities, "kind" | "groups">;

/** Why capabilities do not serve a setting kind, in words; none when they do. */
export function servingRefusals(capabilities: KindCapabilities, kind: ComputerSettingKind): string[] {
	const spec = Object.hasOwn(SETTING_KINDS, kind) ? SETTING_KINDS[kind] : undefined;
	if (spec === undefined) return [`${JSON.stringify(kind)} is not a setting kind: ${SETTING_KIND_NAMES.join(", ")}`];
	if (spec.machineKinds.length === 0) return [`kind ${kind} is no computer: no provider serves it`];
	const refusals: string[] = [];
	if (!spec.machineKinds.includes(capabilities.kind)) refusals.push(`kind ${kind} is a ${spec.machineKinds.join(" or ")} machine, not a ${capabilities.kind} one`);
	const groups = Array.isArray(capabilities.groups) ? capabilities.groups : [];
	const missing = spec.required.filter((group) => !groups.includes(group));
	if (missing.length > 0) refusals.push(`kind ${kind} needs groups ${missing.join(", ")}, which the provider does not declare`);
	return refusals;
}

/** Whether a provider with these capabilities serves the kind: its machine kind is one of the kind's, and it declares every required group. */
export function serves(capabilities: KindCapabilities, kind: ComputerSettingKind): boolean {
	return servingRefusals(capabilities, kind).length === 0;
}

/** The setting kind these capabilities serve, or undefined when they serve none. Machine kinds are apart, so at most one. */
export function kindOf(capabilities: KindCapabilities): ComputerSettingKind | undefined {
	return SETTING_KIND_NAMES.find((kind) => serves(capabilities, kind));
}

/** A provider as Settings shows it: its descriptor's data, and the setting kinds it serves. */
export interface ProviderEntry {
	/** Its id: a line of the provider registry (providers.ts). */
	readonly id: string;
	readonly label: string;
	/** Derived: the setting kinds its capabilities serve (serves), never written by hand. */
	readonly kinds: readonly ComputerSettingKind[];
	/** The serve-side key names and the options they fill; never a value. */
	readonly keys: readonly DescriptorKey[];
	/** Settings that are no key but go to its options. */
	readonly settings?: readonly DescriptorSetting[];
	/** The mount kinds its computers take; [] cannot mount the run's folder. */
	readonly mounts: readonly MountKind[];
	/** The vendor bills by time; prices are the vendor's page, not ours. */
	readonly metered: boolean;
	/** Its static capabilities: the machine kind and groups of each configuration it offers. */
	readonly capabilities: readonly KindCapabilities[];
	/**
	 * The image a computer of each setting kind starts from when its setting names none. A kind with no entry has no
	 * default, and the caller refuses the setting in words. Docker's sandbox has none: its image is made (prepareImage).
	 */
	readonly defaultImage?: Partial<Record<ComputerSettingKind, string>>;
	/** Its built providers make or pull their image before the first create (prepareImage()). */
	readonly prepareImage?: boolean;
	/** Its computers run on this machine's container engine. */
	readonly local?: boolean;
	/** create() takes a ledger the server keeps for it, as this option. */
	readonly ledger?: { readonly option: string };
}

/** A descriptor as Settings shows it: its data, and the setting kinds its capabilities serve, derived by serves(). */
export function entryOf(descriptor: ProviderDescriptor): ProviderEntry {
	const { load: _load, ...data } = descriptor;
	return { ...data, kinds: SETTING_KIND_NAMES.filter((kind) => descriptor.capabilities.some((one) => serves(one, kind))) };
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
