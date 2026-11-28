// Maritime's descriptor: a Linux sandbox on a Maritime virtual machine (a micro-VM with its own kernel), started from our
// box image, which Maritime pulls from its public registry tag at the first create. Its machines dial the server
// (MachineHost facts.connect "dial"): Maritime's own commands take stdin as one string given at the start, which can't
// carry the stdio bridge, so a background command starts agentrun-dial and computerd dials the server's attach route.
// One key, under the name Maritime's own SDK reads (maritime-sdk dist/index.js: process.env.MARITIME_API_KEY).
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const MARITIME = defineProvider({
	id: "maritime",
	label: "Maritime",
	keys: [{ name: "MARITIME_API_KEY", option: "apiKey", required: true }],
	metered: true,
	// Its machines dial the server: Maritime's commands take no live stdin, so nothing reaches into one.
	connect: "dial",
	// None: a machine that dials takes no Archil mount (mountsOf).
	mounts: [],
	// All three are init's, in its own network inside the VM (unverified until the live run: root making a network
	// namespace there). The VM itself always reaches out (egress all): it fetches its daemon from the server and dials it.
	network: ["none", "open", "allow"],
	// A linux computer alone: no desktop until the live run.
	capabilities: [SANDBOX],
	// No default image: Maritime's templates have no agentrun-dial, so every computer starts from the box image its
	// prepareImage() answers.
	prepareImage: true,
	load: () => import("../maritime.js"),
});
