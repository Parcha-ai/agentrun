// Daytona's descriptor: a sandbox on Daytona's cloud, the run's folder on an Archil disk.
import { defineProvider } from "../descriptor.js";
import { SANDBOX } from "./shared.js";

/** The image a Daytona computer starts from when its spec names "default": Daytona's own default snapshot. */
export const DAYTONA_DEFAULT_SNAPSHOT = "default";

export const DAYTONA = defineProvider({
	id: "daytona",
	label: "Daytona",
	keys: [
		{ name: "DAYTONA_API_KEY", option: "apiKey", required: true },
		{ name: "DAYTONA_API_URL", option: "apiUrl", required: false },
		{ name: "DAYTONA_TARGET", option: "target", required: false },
	],
	metered: true,
	mounts: ["archil"],
	capabilities: [SANDBOX],
	defaultImage: { sandbox: DAYTONA_DEFAULT_SNAPSHOT },
	load: () => import("../daytona.js"),
});
