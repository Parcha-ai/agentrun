// Morph Cloud's descriptor: a Linux sandbox on a Morph instance (a VM started from a snapshot). Every computer starts
// from the box image built in the key's own account as a Morph snapshot, which its prepareImage() makes once per recipe.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const MORPH = defineProvider({
	id: "morph",
	label: "Morph",
	keys: [{ name: "MORPH_API_KEY", option: "apiKey", required: true }],
	metered: true,
	// None yet: Morph's guests have /dev/fuse (docs: documentation/instances/fuse), and Archil's client there is unproven.
	mounts: [],
	// Morph has no egress control at all (no network field in its OpenAPI): all three are ours. None: its programs run in
	// a network of their own, their loopback alone (isolation.ts). Open and a list: their one way out is init's egress
	// proxy, which reaches the public internet alone, and with a list its hosts alone (hosted/network.ts).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	// No default image: a Morph image is an account's own snapshot id, so every computer starts from the box snapshot
	// its prepareImage() finds or builds in the key's account.
	prepareImage: true,
	load: () => import("../morph.js"),
});
