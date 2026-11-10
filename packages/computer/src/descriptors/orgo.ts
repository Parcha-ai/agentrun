// Orgo's descriptor: desktops on Orgo's cloud. The Linux desktop runs computerd (orgo.ts); the Windows and macOS
// desktops are answered over Orgo's API with no daemon inside (orgo-desktop.ts), create()'s os option.
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

export const ORGO = defineProvider({
	id: "orgo",
	label: "Orgo",
	keys: [{ name: "ORGO_API_KEY", option: "apiKey", required: true }],
	metered: true,
	// None yet: an Archil mount needs an Orgo template that bakes the helper.
	mounts: [],
	// The Linux desktop (no os), then Windows and macOS (os "windows", "macos").
	capabilities: [LINUX_DESKTOP, { kind: "desktop", groups: [...WINDOWS_GROUPS] }, { kind: "desktop", groups: [...MACOS_GROUPS] }],
	defaultImage: { desktop: ORGO_BASE_IMAGE },
	load: () => import("../orgo.js"),
});
