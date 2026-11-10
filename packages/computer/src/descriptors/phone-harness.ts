// The phone harness's descriptor: a cloud Android over adb, its sessions in a ledger the server keeps.
import { defineProvider } from "../descriptor.js";
import type { Group } from "../protocol.js";

/** The groups a phone harness phone offers. */
export const PHONE_GROUPS: readonly Group[] = ["screen", "input.touch", "input.keys", "apps", "apps.ui_tree"];

/** The phone harness's Android: a phone computer when its setting names no image. */
export const PHONE_IMAGE = "android";

export const PHONE_HARNESS = defineProvider({
	id: "phone-harness",
	label: "Phone harness",
	keys: [{ name: "PHONE_HARNESS_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: [],
	capabilities: [{ kind: "android", groups: [...PHONE_GROUPS] }],
	defaultImage: { phone: PHONE_IMAGE },
	// The phones it rents, by session: the server's store backs this ledger, so a phone is never lost across restarts.
	ledger: { option: "ledger" },
	load: () => import("../phone-harness.js"),
});
