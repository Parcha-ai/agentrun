// Orgo's descriptor: desktops on Orgo's cloud. The Linux desktop runs computerd (orgo.ts); the Windows and macOS
// desktops are answered over Orgo's API with no daemon inside (orgo-desktop.ts), create()'s os option.
import type { KindCapabilities } from "../kinds.js";
import type { Group } from "../protocol.js";
import { defineProvider } from "../descriptor.js";
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
 * Orgo's configurations, each naming the image an agent's setting selects it by and the create() options that build it
 * (KindCapabilities; serve passes the options to providerFor beside the keys'): the Linux desktop with computerd, then
 * Windows over Orgo's API.
 *
 * macOS is not offered yet: a Mac has no end of Orgo's own and no daemon deadline, so only the janitor ends one, and a
 * server does not run the janitor yet (#2318). create({ os: "macos" }) still builds the provider, for the conformance
 * suite; no agent's setting can select it until the janitor runs.
 */
export const ORGO_CONFIGURATIONS = [
	{ ...LINUX_DESKTOP, image: ORGO_BASE_IMAGE, options: {} },
	{ kind: "desktop", groups: [...WINDOWS_GROUPS], image: ORGO_WINDOWS_IMAGE, options: { os: "windows" } },
] as const satisfies readonly KindCapabilities[];

export const ORGO = defineProvider({
	id: "orgo",
	label: "Orgo",
	// The workspace this server's computers live in: every Orgo provider (Linux, Windows) is built in one, and lists only it.
	keys: [
		{ name: "ORGO_API_KEY", option: "apiKey", required: true },
		{ name: "ORGO_WORKSPACE_ID", option: "workspaceId", required: true },
	],
	metered: true,
	// None yet: an Archil mount needs an Orgo template that bakes the helper.
	mounts: [],
	// The Linux desktop (no os, the default), then Windows (os "windows").
	capabilities: ORGO_CONFIGURATIONS,
	defaultImage: { desktop: ORGO_BASE_IMAGE },
	load: () => import("../orgo.js"),
});
