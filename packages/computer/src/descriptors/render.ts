// Render's descriptor: a Linux sandbox on a Render Sandbox (a microVM) in the operator's Render workspace, started from
// our box image, imported once into the workspace as a sandbox build by its prepareImage() (box-image.ts).
// Its machines dial the server (MachineHost facts.connect "dial"): Render's runs answer a command with no stdin, so
// nothing reaches into a sandbox from outside, and its computerd dials the server's attach route instead.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const RENDER = defineProvider({
	id: "render",
	label: "Render",
	keys: [
		{ name: "RENDER_API_KEY", option: "apiKey", required: true },
		// The workspace (owner) every sandbox is made in and listed from: Render's list needs it (tea-... or usr-...).
		{ name: "RENDER_WORKSPACE_ID", option: "ownerId", required: true },
	],
	metered: true,
	// Its machines dial the server: Render's runs take no stdin, so nothing reaches into one.
	connect: "dial",
	// None: a machine that dials takes no Archil mount (mountsOf).
	mounts: [],
	// None: its programs run in init's network of their own, their loopback alone (isolation.ts). Open and a list: their
	// one way out is init's egress proxy, which reaches the public internet alone, and with a list its hosts alone
	// (hosted/network.ts). The sandbox itself always reaches out (Render's allow-all): it fetches its daemon from the
	// server and dials it.
	network: ["none", "open", "allow"],
	// A linux computer alone: no desktop yet.
	capabilities: [SANDBOX],
	// No default image: Render's base image has no agentrun-dial, so every computer starts from the box build its
	// prepareImage() answers.
	prepareImage: true,
	load: () => import("../render.js"),
});
