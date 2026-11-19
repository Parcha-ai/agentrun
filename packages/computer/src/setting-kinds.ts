// The setting kinds: what an agent is given in Settings, `computer: { kind, provider? }`, as machine kinds and capability
// groups. A leaf of types and data alone, so a descriptor's check (descriptor.ts) reads the one list the kind registry
// (kinds.ts) serves from, though kinds.ts loads the descriptors.
import type { ComputerKind, Group } from "./protocol.js";

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
	desktop: { machineKinds: ["desktop"], required: ["screen", "input.pointer", "input.keys"], optional: ["exec", "files", "processes", "apps", "ui", "stream"] },
	phone: { machineKinds: ["android", "ios"], required: ["screen", "input.touch", "apps"], optional: ["input.keys", "apps.install", "ui", "stream"] },
	browser: { machineKinds: ["browser"], required: ["cdp"], optional: ["stream", "downloads"] },
};

/** Every setting kind, in the table's order. */
export const SETTING_KIND_NAMES = Object.keys(SETTING_KINDS) as ComputerSettingKind[];
