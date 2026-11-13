// Browserbase's descriptor: a cloud Chromium over CDP, with its live view.
import { defineProvider } from "../descriptor.js";
import { BROWSER_IMAGE } from "./shared.js";

export const BROWSERBASE = defineProvider({
	id: "browserbase",
	label: "Browserbase",
	keys: [
		{ name: "BROWSERBASE_API_KEY", option: "apiKey", required: true },
		{ name: "BROWSERBASE_PROJECT_ID", option: "projectId", required: true },
	],
	metered: true,
	mounts: [],
	// Browserbase's own network, open: it cannot be closed or narrowed.
	network: ["open"],
	// A server behind a gateway that fronts Browserbase's API or its sessions' sockets names it here.
	hostEnv: ["BROWSERBASE_BASE_URL", "BROWSERBASE_CONNECT_BASE_URL"],
	capabilities: [{ kind: "browser", groups: ["cdp", "stream"] }],
	defaultImage: { browser: BROWSER_IMAGE },
	load: () => import("../browserbase.js"),
});
