// Agent37's descriptor: a Linux sandbox or a Linux desktop on an Agent37 instance (a VM by default), the run's folder on
// an Archil disk. The desktop starts from our box image built as a workspace template (box/build-agent37.mjs).
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

/** Agent37's plain Linux template: a sandbox when its setting names no image. */
export const AGENT37_BASE_TEMPLATE = "agent37-base";
/**
 * Our box image (box/Dockerfile and Xvfb) as a template of the key's own workspace, which box/build-agent37.mjs builds
 * and publishes under this one name: a desktop when its setting names no image.
 */
export const AGENT37_BOX_TEMPLATE = "agentrun-box";

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
	// Each configuration built by its own create() options: kind linux is the provider's default.
	capabilities: [SANDBOX, { ...LINUX_DESKTOP, options: { kind: "desktop" } }],
	defaultImage: { sandbox: AGENT37_BASE_TEMPLATE, desktop: AGENT37_BOX_TEMPLATE },
	load: () => import("../agent37.js"),
});
