// InstaBox's descriptor: a Linux sandbox on an InstaBox machine (a Firecracker microVM), started from one of InstaBox's
// templates, the minimal one by default, or a snapshot of the key's workspace. One key, the workspace's API key, under the
// name InstaBox's own CLI and SDK read. No desktop and no Archil mount: both need our box image, and a machine takes
// InstaBox's templates alone.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** InstaBox's smallest template (unverified until the live run: on every paid plan). */
export const INSTABOX_IMAGE = "minimal";

export const INSTABOX = defineProvider({
	id: "instabox",
	label: "InstaBox",
	keys: [{ name: "INSTABOX_API_KEY", option: "apiKey", required: true }],
	metered: true,
	// Its create answers the size the vendor runs the computer at (resources), which its time is priced by.
	sized: true,
	mounts: [],
	// All three are init's, through root in the microVM (the machine user's passwordless sudo).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: INSTABOX_IMAGE },
	load: () => import("../instabox.js"),
});
