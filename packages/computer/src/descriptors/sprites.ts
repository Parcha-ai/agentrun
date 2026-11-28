// Fly Sprites' descriptor: a Linux sandbox on a sprite (a Firecracker microVM Fly keeps by name), started from Fly's own
// Ubuntu image, the one image Sprites has. One key, the API token, under the name Fly's own CLI and SDK test client read.
// No desktop and no Archil mount: both need our box image, and a sprite takes no image.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** Fly's own image, the only one a sprite starts from. */
export const SPRITES_IMAGE = "default";

export const SPRITES = defineProvider({
	id: "sprites",
	label: "Fly Sprites",
	keys: [{ name: "SPRITES_TOKEN", option: "token", required: true }],
	metered: true,
	mounts: [],
	// All three are init's, through root in the microVM (unverified until the live run: the exec user's passwordless sudo).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: SPRITES_IMAGE },
	load: () => import("../sprites.js"),
});
