// Northflank's descriptor: a Linux sandbox on a Northflank service (a Kata microVM on Northflank Cloud) in the customer's
// own project, started from our box image, the public registry tag its prepareImage() answers (box-image.ts), which
// Northflank pulls at each create. The token is under the name Northflank's own client reads (NORTHFLANK_API_TOKEN,
// @northflank/js-client). The project has no default, so Settings asks for it; its key is neither NF_PROJECT_ID, which
// Northflank injects into every service it runs, nor NORTHFLANK_PROJECT_ID, a name other tools use, so a server
// Northflank runs never takes its own project for the computers'. The team is for an organisation token alone. No Archil mount and no desktop yet: both are unverified until
// a live run.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

export const NORTHFLANK = defineProvider({
	id: "northflank",
	label: "Northflank",
	keys: [
		{ name: "NORTHFLANK_API_TOKEN", option: "token", required: true },
		{ name: "NORTHFLANK_COMPUTER_PROJECT_ID", option: "projectId", required: true },
		{ name: "NORTHFLANK_COMPUTER_TEAM_ID", option: "teamId", required: false },
	],
	metered: true,
	// Its create answers the size the vendor runs the computer at (resources), which its time is priced by: Northflank's
	// get-service (API docs, services/get-service) answers billing.deploymentPlan, required, and the plan maps to its
	// vCPUs and MB.
	sized: true,
	mounts: [],
	// All three are init's, through root in the microVM (unverified until the live run: root makes a network namespace).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	// No default image: every computer starts from the box image its prepareImage() answers, unless its spec names one.
	prepareImage: true,
	load: () => import("../northflank.js"),
});
