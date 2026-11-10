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
	capabilities: [{ kind: "browser", groups: ["cdp", "stream"] }],
	defaultImage: { browser: BROWSER_IMAGE },
	load: () => import("../browserbase.js"),
});
