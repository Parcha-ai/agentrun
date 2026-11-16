// Agent37's descriptor: a Linux sandbox or a Linux desktop on an Agent37 instance (a VM by default), the run's folder on
// an Archil disk. Both start from our box image, which its prepareImage() registers in the key's own workspace from the
// public image the release publishes (box-image.ts).
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

/** Agent37's plain Linux template, a spec's image for a caller of the provider that names its own. */
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
	// None: its programs run in a network of their own, their loopback alone (isolation.ts), and the instance is made
	// deny-all. Open and a list: the instance is made allow-all, and its programs' one way out is init's egress proxy,
	// which reaches the public internet alone, and with a list its hosts alone (hosted/network.ts).
	network: ["none", "open", "allow"],
	// Each configuration built by its own create() options: kind linux is the provider's default.
	capabilities: [SANDBOX, { ...LINUX_DESKTOP, options: { kind: "desktop" } }],
	// No default image: every computer starts from the box template its prepareImage() registers (agentrun-box-<hash>).
	prepareImage: true,
	load: () => import("../agent37.js"),
});
