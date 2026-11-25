// The phone harness's descriptor: a cloud Android over adb, its sessions in a ledger the server keeps.
import { defineProvider } from "../descriptor.js";
import type { Group } from "../protocol.js";
import { BASE_ENV_NAMES } from "./env-names.js";

/** The groups a phone harness phone offers: phoned's, the driver it runs (daemon-android/), in its hello's order. */
export const PHONE_GROUPS: readonly Group[] = ["exec", "screen", "input.keys", "input.touch", "apps", "ui"];

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
	// The APKs every phone installs, files on this machine each pinned by its sha256: the operator's setting. And the
	// names every child reads, adb's environment (PATH to be found, HOME for its keys): adb gets those alone.
	hostEnv: ["PHONE_HARNESS_APKS", ...BASE_ENV_NAMES],
	load: () => import("../phone-harness.js"),
});
