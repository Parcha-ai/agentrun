// boat's descriptor: a Linux sandbox on a boat sandbox (a Firecracker microVM in boat's EU regions), from boat's own
// Ubuntu 24.04 base or a snapshot the account saved. One key, the API key, under the name boat's own SDK reads. No
// desktop and no Archil mount: both need our box image, and boat takes no image of ours.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** boat's base image, the one a sandbox starts from when no snapshot is named. */
export const BOAT_IMAGE = "ubuntu-24.04";

export const BOAT = defineProvider({
	id: "boat",
	label: "boat",
	keys: [{ name: "BOAT_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: [],
	// All three are init's, through root in the microVM (unverified until the live run: netns under the exec user's sudo).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: BOAT_IMAGE },
	load: () => import("../boat.js"),
});
