// Freestyle's descriptor: a Linux sandbox on a Freestyle VM (a VM of Freestyle's own, systemd its pid 1), started from a
// snapshot in the key's account that holds agentrun-dial: our box image, built there as box/install.sh says for a vendor
// that builds images in its own account. One key, the account's API key, under the name Freestyle's own SDK and CLI read.
// Its machines dial the server (MachineHost facts.connect "dial"): Freestyle's exec answers a command once it has ended,
// with no live stdin, and its SSH gateway publishes no host key to pin, so nothing reaches into a VM from outside, and its
// computerd dials the server's attach route instead.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const FREESTYLE = defineProvider({
	id: "freestyle",
	label: "Freestyle",
	keys: [{ name: "FREESTYLE_API_KEY", option: "apiKey", required: true }],
	metered: true,
	// Its create answers the size the vendor runs the computer at (resources), which its time is priced by.
	sized: true,
	// Its machines dial the server: Freestyle's exec takes its stdin whole and answers once the command ends.
	connect: "dial",
	// None: a machine that dials takes no Archil mount (mountsOf).
	mounts: [],
	// None: its programs run in init's network of their own, their loopback alone (isolation.ts). Open and a list: their
	// one way out is init's egress proxy, which reaches the public internet alone, and with a list its hosts alone
	// (hosted/network.ts). The VM itself always reaches out (its firewall's public egress): it fetches its daemon from the
	// server and dials it.
	network: ["none", "open", "allow"],
	// A linux computer alone: no desktop yet.
	capabilities: [SANDBOX],
	// No default image: Freestyle's base snapshots have no agentrun-dial, so every computer starts from the box image's
	// snapshot in the account, agentrun-box-<recipe hash>, which its prepareImage() answers and the operator builds once.
	prepareImage: true,
	load: () => import("../freestyle.js"),
});
