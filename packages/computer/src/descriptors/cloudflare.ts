// Cloudflare's descriptor: a Linux sandbox in a Cloudflare Container (a Firecracker microVM) in the operator's own
// account, started by the relay Worker the operator deploys from packages/computer/relays/cloudflare, from the box image
// that relay was built FROM. Its containers dial the server (MachineHost facts.connect "dial"): Cloudflare has no REST
// call that starts or reaches into a container, so the relay creates, lists and deletes them, and computerd dials the
// server's attach route.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** The relay's routes and rows this package speaks: the relay template's RELAY_VERSION; testConnection refuses another. */
export const CLOUDFLARE_RELAY_VERSION = 1;

export const CLOUDFLARE = defineProvider({
	id: "cloudflare",
	label: "Cloudflare",
	keys: [
		{ name: "CLOUDFLARE_RELAY_URL", option: "relayUrl", required: true },
		{ name: "CLOUDFLARE_RELAY_TOKEN", option: "relayToken", required: true },
	],
	metered: true,
	// None: a machine that dials takes no Archil mount yet (its helper's root steps run through exec, which it has none of).
	mounts: [],
	// None: its programs run in init's network of their own, their loopback alone (isolation.ts). Open and a list: their
	// one way out is init's egress proxy (hosted/network.ts). The container itself always reaches out (enableInternet): it
	// fetches its daemon from the server and dials it.
	network: ["none", "open", "allow"],
	// A linux computer alone: no desktop configuration yet, though the box image has one (PROVIDERS.md, Machines that dial in).
	capabilities: [SANDBOX],
	// No default image: every computer starts from the box image the relay was deployed with, which prepareImage() reads.
	prepareImage: true,
	load: () => import("../cloudflare.js"),
});
