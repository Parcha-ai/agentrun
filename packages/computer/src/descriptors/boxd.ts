// boxd's descriptor: a boxd machine (a microVM) as a sandbox or a desktop, the desktop restored from a snapshot its
// prepareImage() builds. No mount yet.
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

/** boxd's own Ubuntu 24.04 image: a computer whose spec names it starts from no snapshot. */
export const BOXD_DEFAULT_IMAGE = "default";

export const BOXD = defineProvider({
	id: "boxd",
	label: "boxd",
	keys: [
		{ name: "BOXD_API_KEY", option: "apiKey", required: true },
		{ name: "BOXD_ORG", option: "org", required: false },
		{ name: "BOXD_REGION", option: "region", required: false },
	],
	metered: true,
	mounts: [],
	// None: its programs run in a network of their own (isolation.ts OWN_NETWORK_ONLY).
	network: ["none"],
	// Each configuration names the kind its create() options build: the provider's default is linux.
	capabilities: [
		{ ...SANDBOX, options: { kind: "linux" } },
		{ ...LINUX_DESKTOP, options: { kind: "desktop" } },
	],
	// A sandbox starts from boxd's own image. A desktop has no default: it starts from the snapshot its prepareImage()
	// builds once in the key's org (agentrun-desktop-<hash>), boxd's own image with a stock app added.
	defaultImage: { sandbox: BOXD_DEFAULT_IMAGE },
	prepareImage: true,
	load: () => import("../boxd.js"),
});
