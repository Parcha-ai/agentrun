// smol cloud's descriptor: a Linux sandbox on a smol cloud machine (a microVM booted from an OCI image). No mount yet.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** The image a smol cloud sandbox starts from when its spec names none: any OCI reference works. */
export const SMOLCLOUD_DEFAULT_IMAGE = "alpine:3.20";

export const SMOLCLOUD = defineProvider({
	id: "smolcloud",
	label: "smol cloud",
	keys: [{ name: "SMOLCLOUD_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: [],
	// All three are ours: root in the guest makes a network namespace, so init's fence holds none and its egress proxy
	// open and a list (hosted/network.ts).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: SMOLCLOUD_DEFAULT_IMAGE },
	load: () => import("../smolcloud.js"),
});
