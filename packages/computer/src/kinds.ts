// The kind registry: the computer an agent is given, its setting kind, and the providers Settings offers for it. Two
// axes: the machine kind is the protocol's (capabilities().kind, KIND_SHAPES); the setting kind is what an agent is
// given in Settings, `computer: { kind, provider? }`, as machine kinds and capability groups. Whether a provider serves
// a setting kind is computed from its capabilities alone (serves), never kept beside them: a provider that drops a
// group stops serving the kind. The model's tools are not here: they live in the kernel's tool registry, keyed by
// these groups.
// The default images are values: each from the provider module that owns it. Those modules import this one for types
// alone, so this is no import cycle.
import { BROWSER_IMAGE } from "./browser.js";
import { DAYTONA_DEFAULT_SNAPSHOT, DAYTONA_GPU_MAX, DAYTONA_GPU_TYPES } from "./daytona.js";
import { E2B_BASE_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "./e2b.js";
import { MODAL_DEFAULT_IMAGE, MODAL_GPU_MAX, MODAL_GPU_TYPES } from "./modal.js";
import type { MountKind } from "./mount.js";
import { ORGO_BASE_IMAGE } from "./orgo.js";
import { PHONE_IMAGE } from "./phone-harness.js";
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

/** The capabilities serves() and kindOf() read, and the GPUs a configuration offers (Settings' GPU choice). */
export type KindCapabilities = Pick<ComputerCapabilities, "kind" | "groups" | "gpu">;

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

/** One key a provider takes in Settings: its serve-side name (Settings accepts only these), and whether it is needed. */
export interface ProviderKey {
	name: string;
	required: boolean;
}

/** A provider as Settings shows it. */
export interface ProviderEntry {
	/** Its id: a line of the provider registry (providers.ts) once its file lands. */
	id: string;
	label: string;
	/** Derived: the setting kinds its capabilities serve (serves), never written by hand. */
	kinds: readonly ComputerSettingKind[];
	/** The serve-side key names only; never a value. */
	keys: readonly ProviderKey[];
	/** The mount kinds its computers take; [] cannot mount the run's folder. Its module's MOUNT, once its file lands. */
	mounts: readonly MountKind[];
	/** The vendor bills by time; prices are the vendor's page, not ours. */
	metered: boolean;
	/**
	 * Its static capabilities: the machine kind and groups of each configuration it offers. Its module's CAPABILITIES,
	 * once its file lands, and each built configuration's capabilities().
	 */
	capabilities: readonly KindCapabilities[];
	/**
	 * The image a computer of each setting kind starts from when its setting names none, each the constant its provider
	 * module owns. A kind with no entry has no default, and the caller refuses the setting in words. Docker's sandbox has
	 * none: serve builds its image itself (DOCKER_RECIPE).
	 */
	defaultImage?: Partial<Record<ComputerSettingKind, string>>;
}

const SANDBOX: KindCapabilities = { kind: "linux", groups: ["exec", "files", "processes"] };
const LINUX_DESKTOP: KindCapabilities = { kind: "desktop", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"] };

/** An entry with its kinds derived from its capabilities. */
function entry(fields: Omit<ProviderEntry, "kinds">): ProviderEntry {
	return { ...fields, kinds: SETTING_KIND_NAMES.filter((kind) => fields.capabilities.some((one) => serves(one, kind))) };
}

/**
 * Every provider Settings offers, each with its provider file in the registry;
 * a unit test then holds each to its module (CAPABILITIES, MOUNT). daytona, modal and e2b take archil mounts.
 */
export const PROVIDERS: readonly ProviderEntry[] = [
	entry({ id: "docker", label: "Docker", keys: [], mounts: ["bind"], metered: false, capabilities: [SANDBOX, LINUX_DESKTOP] }),
	entry({
		id: "daytona",
		label: "Daytona",
		keys: [
			{ name: "DAYTONA_API_KEY", required: true },
			{ name: "DAYTONA_API_URL", required: false },
			{ name: "DAYTONA_TARGET", required: false },
		],
		mounts: ["archil"],
		metered: true,
		capabilities: [{ ...SANDBOX, gpu: { types: [...DAYTONA_GPU_TYPES], max: DAYTONA_GPU_MAX } }],
		defaultImage: { sandbox: DAYTONA_DEFAULT_SNAPSHOT },
	}),
	entry({
		id: "modal",
		label: "Modal",
		keys: [
			{ name: "MODAL_TOKEN_ID", required: true },
			{ name: "MODAL_TOKEN_SECRET", required: true },
		],
		mounts: ["archil"],
		metered: true,
		capabilities: [{ ...SANDBOX, gpu: { types: [...MODAL_GPU_TYPES], max: MODAL_GPU_MAX } }],
		defaultImage: { sandbox: MODAL_DEFAULT_IMAGE },
	}),
	entry({
		id: "e2b",
		label: "E2B",
		keys: [{ name: "E2B_API_KEY", required: true }],
		mounts: ["archil"],
		metered: true,
		capabilities: [SANDBOX, LINUX_DESKTOP],
		defaultImage: { sandbox: E2B_BASE_TEMPLATE, desktop: E2B_DESKTOP_TEMPLATE },
	}),
	entry({
		id: "orgo",
		label: "Orgo",
		keys: [{ name: "ORGO_API_KEY", required: true }],
		mounts: [],
		metered: true,
		capabilities: [LINUX_DESKTOP],
		defaultImage: { desktop: ORGO_BASE_IMAGE },
	}),
	entry({
		id: "phone-harness",
		label: "Phone harness",
		keys: [{ name: "PHONE_HARNESS_API_KEY", required: true }],
		mounts: [],
		metered: true,
		capabilities: [{ kind: "android", groups: ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"] }],
		defaultImage: { phone: PHONE_IMAGE },
	}),
	entry({
		id: "browserbase",
		label: "Browserbase",
		keys: [
			{ name: "BROWSERBASE_API_KEY", required: true },
			{ name: "BROWSERBASE_PROJECT_ID", required: true },
		],
		mounts: [],
		metered: true,
		capabilities: [{ kind: "browser", groups: ["cdp", "stream"] }],
		defaultImage: { browser: BROWSER_IMAGE },
	}),
	entry({
		id: "kernel",
		label: "Kernel",
		keys: [{ name: "KERNEL_API_KEY", required: true }],
		mounts: [],
		metered: true,
		capabilities: [{ kind: "browser", groups: ["cdp", "stream"] }],
		defaultImage: { browser: BROWSER_IMAGE },
	}),
];

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
