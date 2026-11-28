// Tensorlake's descriptor: a Linux sandbox on a Tensorlake sandbox (a microVM), started from one of Tensorlake's images,
// tensorlake/ubuntu-minimal by default, or one registered in the key's project. One key, the project's API key, under the
// name Tensorlake's own CLI and SDK read. No desktop and no Archil mount: both need our box image, and a sandbox boots
// a registered image alone.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** Tensorlake's default sandbox image (https://docs.tensorlake.ai/sandboxes/tensorlake-images.md). */
export const TENSORLAKE_IMAGE = "tensorlake/ubuntu-minimal";

export const TENSORLAKE = defineProvider({
	id: "tensorlake",
	label: "Tensorlake",
	keys: [{ name: "TENSORLAKE_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: [],
	// All three are init's, through root in the microVM (tl-user's passwordless sudo).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: TENSORLAKE_IMAGE },
	load: () => import("../tensorlake.js"),
});
