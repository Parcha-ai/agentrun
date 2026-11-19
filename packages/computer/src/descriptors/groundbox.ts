// Groundbox's descriptor: a Linux sandbox on a Groundbox sandbox (a Firecracker microVM), started from our box image, the
// public registry tag its prepareImage() answers (box-image.ts), which Groundbox turns into a disk at the first create.
// A spec may name Groundbox's own image ("default"), a template of the key's team, or another public image instead. Kind
// linux or desktop; the run's folder is a synced folder (derived); no Archil mount yet.
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

/**
 * The name of Groundbox's own image: no template and no image is sent, so Groundbox starts the team's default template
 * when it has one, else its own image (Ubuntu 24.04 with the usual tools). Groundbox reserves the name, so no template
 * can hold it. Not the provider's default: that image keeps toolchains under /opt deeper than the isolation probe
 * searches, so the socket fence can't be proven on it.
 */
export const GROUNDBOX_OWN_IMAGE = "default";

export const GROUNDBOX = defineProvider({
	id: "groundbox",
	label: "Groundbox",
	keys: [{ name: "GROUNDBOX_API_KEY", option: "apiKey", required: true }],
	metered: true,
	// None yet: the guest kernel has FUSE, and Archil's client there is untried.
	mounts: [],
	// All three are ours: root in the guest makes a network namespace, so init's fence holds none and its egress proxy
	// open and a list (hosted/network.ts). Groundbox's own allowlist (allow_hosts) is not used.
	network: ["none", "open", "allow"],
	// A linux computer, or a desktop (create()'s kind: "desktop"): the box image's Xvfb and xfwm4, started through computerd
	// over the exec, as on E2B and boxd. Groundbox's own desktop (desktop: true, its own X server and Chrome) is not used.
	capabilities: [SANDBOX, { ...LINUX_DESKTOP, options: { kind: "desktop" } }],
	// No default image: every computer starts from the box image its prepareImage() answers, unless its spec names one.
	prepareImage: true,
	load: () => import("../groundbox.js"),
});
