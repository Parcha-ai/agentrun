// Orgo's descriptor: desktops on Orgo's cloud. The Linux desktop runs computerd (orgo.ts) and is the one offered. The
// Windows and macOS desktops, answered over Orgo's API with no daemon inside (orgo-desktop.ts, create()'s os option),
// are parked: built for the conformance suite, never selected by an agent's setting.
import type { KindCapabilities } from "../kinds.js";
import type { Group } from "../protocol.js";
import { defineProvider, type ParkedConfiguration } from "../descriptor.js";
import { LINUX_DESKTOP } from "./shared.js";

/** Orgo's Linux image: a desktop computer when its setting names none. */
export const ORGO_BASE_IMAGE = "linux";
/** The image a spec names for an Orgo Windows desktop (Windows Server 2019, Orgo's own). */
export const ORGO_WINDOWS_IMAGE = "windows";
/** The image a spec names for an Orgo macOS desktop. */
export const ORGO_MACOS_IMAGE = "macos";
/** What a Windows desktop offers: PowerShell for exec and files, and the screen, the pointer and the keys. */
export const WINDOWS_GROUPS: readonly Group[] = ["exec", "files", "screen", "input.pointer", "input.keys"];
/** What a macOS desktop offers: the shell for exec, and the screen, the pointer and the keys. */
export const MACOS_GROUPS: readonly Group[] = ["exec", "screen", "input.pointer", "input.keys"];

/**
 * Orgo's offered configuration, naming the image an agent's setting selects it by and the create() options that build
 * it (KindCapabilities; serve passes the options to providerFor beside the keys'): the Linux desktop with computerd.
 *
 * Windows and macOS are parked (ORGO_PARKED): create({ os }) still builds them, for the conformance suite and their
 * tests, but no agent's setting selects one, and a setting that names one is refused in words saying so.
 */
export const ORGO_CONFIGURATIONS = [{ ...LINUX_DESKTOP, image: ORGO_BASE_IMAGE, options: {} }] as const satisfies readonly KindCapabilities[];

/** Orgo's desktops not offered yet, each as its module builds it (create()'s os), and why, in the words a setting naming
 *  one is refused in. */
export const ORGO_PARKED = [
	{ kind: "desktop", groups: [...WINDOWS_GROUPS], image: ORGO_WINDOWS_IMAGE, options: { os: "windows" }, why: "Orgo's Windows desktops are parked for now: Orgo offers Linux desktops" },
	{ kind: "desktop", groups: [...MACOS_GROUPS], image: ORGO_MACOS_IMAGE, options: { os: "macos" }, why: "Orgo's macOS desktops are parked for now: Orgo offers Linux desktops" },
] as const satisfies readonly ParkedConfiguration[];

export const ORGO = defineProvider({
	id: "orgo",
	label: "Orgo",
	// The workspace this server's computers live in: every Orgo provider is built in one, and lists only it.
	keys: [
		{ name: "ORGO_API_KEY", option: "apiKey", required: true },
		{ name: "ORGO_WORKSPACE_ID", option: "workspaceId", required: true },
	],
	metered: true,
	// None yet: an Archil mount needs an Orgo template that bakes the helper.
	mounts: [],
	// The Linux desktop's: none (computerd holds its programs to loopback).
	network: ["none"],
	capabilities: ORGO_CONFIGURATIONS,
	parked: ORGO_PARKED,
	defaultImage: { desktop: ORGO_BASE_IMAGE },
	load: () => import("../orgo.js"),
});
