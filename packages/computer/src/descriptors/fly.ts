// Fly Machines' descriptor: a Linux sandbox on a Fly Machine (a Firecracker microVM) in the operator's Fly app, started
// from our box image, the public registry tag its prepareImage() answers (box-image.ts), which Fly pulls at each create.
// Its machines dial the server (MachineHost facts.connect "dial"): Fly's exec answers only once the command ends, so
// nothing reaches into a machine from outside, and its computerd dials the server's attach route instead.
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

export const FLY = defineProvider({
	id: "fly",
	label: "Fly Machines",
	keys: [
		{ name: "FLY_API_TOKEN", option: "apiToken", required: true },
		// The Fly app its machines live in: one the operator made (fly apps create), as Fly's app names are global, so there
		// is no default. Saved beside the token in Settings → Computers, as Orgo's workspace and Daytona's URL are.
		{ name: "FLY_APP", option: "app", required: true },
	],
	metered: true,
	// Its machines dial the server: Fly's exec answers only once the command ends, so nothing reaches into one.
	connect: "dial",
	// None: a machine that dials takes no Archil mount yet (its helper's root steps run through exec, which it has none of).
	mounts: [],
	// None: its programs run in init's network of their own, their loopback alone (isolation.ts). Open and a list: their
	// one way out is init's egress proxy, which reaches the public internet alone, and with a list its hosts alone
	// (hosted/network.ts). The machine itself always reaches out: it fetches its daemon from the server and dials it.
	network: ["none", "open", "allow"],
	// A linux computer, or a desktop: the box image's X server and xfwm4, started through computerd over the socket the
	// machine dialed. A desktop's size is the sandbox's, the adapter's default of 2 shared CPUs and 4 GiB (fly.ts).
	capabilities: [SANDBOX, { ...LINUX_DESKTOP, options: { kind: "desktop" } }],
	// No default image: every computer starts from the box image its prepareImage() answers.
	prepareImage: true,
	load: () => import("../fly.js"),
});
