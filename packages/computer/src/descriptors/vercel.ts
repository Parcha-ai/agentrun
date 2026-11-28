// Vercel Sandbox's descriptor: a Linux sandbox on a Vercel Sandbox (a Firecracker microVM), started from our box image
// as the project's registry holds it, the tag its prepareImage() answers (agentrun-box:<recipe hash>). Three keys: the
// access token, a secret, and the team and project ids, which aren't secrets but have no default, so Settings asks for
// them. No Archil mount yet: whether its client mounts in the microVM is unverified until a live run.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const VERCEL = defineProvider({
	id: "vercel",
	label: "Vercel Sandbox",
	keys: [
		{ name: "VERCEL_TOKEN", option: "token", required: true },
		{ name: "VERCEL_TEAM_ID", option: "teamId", required: true },
		{ name: "VERCEL_PROJECT_ID", option: "projectId", required: true },
	],
	metered: true,
	mounts: [],
	// All three are ours: root in the microVM makes a network namespace (unverified until the live run), so init's fence
	// holds none and its egress proxy open and a list (hosted/network.ts).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	// No default image: every computer starts from the box image its prepareImage() answers, unless its spec names one.
	prepareImage: true,
	load: () => import("../vercel.js"),
});
