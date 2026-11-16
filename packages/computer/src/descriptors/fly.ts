// Fly Machines' descriptor: a Linux sandbox on a Fly Machine (a Firecracker microVM) in the operator's Fly app, started
// from our box image, the public registry tag its prepareImage() answers (box-image.ts), which Fly pulls at each create.
// Its machines dial the server (MachineHost facts.connect "dial"): Fly's exec answers only once the command ends, so
// nothing reaches into a machine from outside, and its computerd dials the server's attach route instead.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const FLY = defineProvider({
	id: "fly",
	label: "Fly Machines",
	keys: [{ name: "FLY_API_TOKEN", option: "apiToken", required: true }],
	// The Fly app its machines live in: one the operator made (fly apps create), as Fly's app names are global.
	settings: [{ name: "flyApp", option: "app" }],
	metered: true,
	// None: a machine that dials takes no Archil mount yet (its helper's root steps run through exec, which it has none of).
	mounts: [],
	// None: its programs run in init's network of their own, their loopback alone (isolation.ts). Open and a list: their
	// one way out is init's egress proxy, which reaches the public internet alone, and with a list its hosts alone
	// (hosted/network.ts). The machine itself always reaches out: it fetches its daemon from the server and dials it.
	network: ["none", "open", "allow"],
	// A linux computer alone: agentrun-dial starts init with no display.
	capabilities: [SANDBOX],
	// No default image: every computer starts from the box image its prepareImage() answers.
	prepareImage: true,
	load: () => import("../fly.js"),
});
