// smol cloud's descriptor: a Linux sandbox on a smol cloud machine (a microVM booted from an OCI image), started from
// our box image, the public registry tag its prepareImage() answers (box-image.ts), which smol cloud pulls at create. No
// mount yet: smol cloud binds the machine's own storage disk at /workspace, and the adapter holds a synced folder only
// where nothing is mounted there, so the run's folder can't be a synced folder on smol cloud.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const SMOLCLOUD = defineProvider({
	id: "smolcloud",
	label: "smol cloud",
	keys: [{ name: "SMOLCLOUD_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: [],
	unmounted: { sync: "smol cloud binds each machine's own storage disk at /workspace, and a synced folder can be held only where nothing is mounted there" },
	// All three are ours: root in the guest makes a network namespace, so init's fence holds none and its egress proxy
	// open and a list (hosted/network.ts).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	// No default image: every computer starts from the box image its prepareImage() answers, unless its spec names one.
	prepareImage: true,
	load: () => import("../smolcloud.js"),
});
