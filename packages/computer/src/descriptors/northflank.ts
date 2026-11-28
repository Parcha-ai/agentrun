// Northflank's descriptor: a Linux sandbox on a Northflank service (a Kata microVM on Northflank Cloud) in the customer's
// own project, started from our box image, the public registry tag its prepareImage() answers (box-image.ts), which
// Northflank pulls at each create. The token is under the name Northflank's own client reads (NORTHFLANK_API_TOKEN,
// @northflank/js-client). The project has no default, so Settings asks for it; its key is not NORTHFLANK_PROJECT_ID, the
// name Northflank sets inside its own services, so a server Northflank runs never takes its own project for the
// computers'. The team is for an organisation token alone. No Archil mount and no desktop yet: both are unverified until
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
	mounts: [],
	// All three are init's, through root in the microVM (unverified until the live run: root makes a network namespace).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX],
	// No default image: every computer starts from the box image its prepareImage() answers, unless its spec names one.
	prepareImage: true,
	load: () => import("../northflank.js"),
});
