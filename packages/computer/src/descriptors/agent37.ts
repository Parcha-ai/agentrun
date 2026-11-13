// Agent37's descriptor: a Linux sandbox on an Agent37 instance (a VM by default), the run's folder on an Archil disk.
// Its desktop waits for our box image as an Agent37 template (README, "Agent37"), so it offers kind linux alone.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** Agent37's plain Linux template: a sandbox when its setting names no image. */
export const AGENT37_BASE_TEMPLATE = "agent37-base";

export const AGENT37 = defineProvider({
	id: "agent37",
	label: "Agent37",
	keys: [
		{ name: "AGENT37_API_KEY", option: "apiKey", required: true },
		// The private half of the SSH key registered on the workspace: every command reaches the machine over SSH.
		{ name: "AGENT37_SSH_KEY", option: "sshKey", required: true },
	],
	metered: true,
	mounts: ["archil"],
	// None: its programs run in a network of their own (isolation.ts OWN_NETWORK_ONLY).
	network: ["none"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: AGENT37_BASE_TEMPLATE },
	load: () => import("../agent37.js"),
});
