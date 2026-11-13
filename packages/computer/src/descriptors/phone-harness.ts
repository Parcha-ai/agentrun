// The phone harness's descriptor: a cloud Android over adb, its sessions in a ledger the server keeps.
import { defineProvider } from "../descriptor.js";
import type { Group } from "../protocol.js";

/** The groups a phone harness phone offers. */
export const PHONE_GROUPS: readonly Group[] = ["screen", "input.touch", "input.keys", "apps", "ui"];

/** The phone harness's Android: a phone computer when its setting names no image. */
export const PHONE_IMAGE = "android";

export const PHONE_HARNESS = defineProvider({
	id: "phone-harness",
	label: "Phone harness",
	keys: [{ name: "PHONE_HARNESS_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: [],
	// The vendor's own network, open: it cannot be closed or narrowed.
	network: ["open"],
	capabilities: [{ kind: "android", groups: [...PHONE_GROUPS] }],
	defaultImage: { phone: PHONE_IMAGE },
	// The phones it rents, by session: the server's store backs this ledger, so a phone is never lost across restarts.
	ledger: { option: "ledger" },
	// The phone is driven by adb from the server's machine (the module's adb option, adb on PATH by default). Google
	// builds platform-tools for x86-64 Linux, macOS and x86-64 Windows alone.
	hostCommand: { command: "adb", from: "Android platform-tools", builds: ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"] },
	load: () => import("../phone-harness.js"),
});
