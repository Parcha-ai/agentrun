// smol cloud's descriptor: a Linux sandbox on a smol cloud machine (a microVM booted from an OCI image), started from
// our box image, the public registry tag its prepareImage() answers (box-image.ts), which smol cloud pulls at create. No
// mount yet: smol cloud binds the machine's own storage disk at /workspace, where a synced folder needs nothing mounted.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const SMOLCLOUD = defineProvider({
	id: "smolcloud",
	label: "smol cloud",
	keys: [{ name: "SMOLCLOUD_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: [],
	unmounted: { sync: "smol cloud binds each machine's own storage disk at /workspace, and a synced folder needs nothing mounted there" },
	// All three are ours: root in the guest makes a network namespace, so init's fence holds none and its egress proxy
	// open and a list (hosted/network.ts).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	// No default image: every computer starts from the box image its prepareImage() answers, unless its spec names one.
	prepareImage: true,
	load: () => import("../smolcloud.js"),
});
