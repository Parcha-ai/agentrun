// E2B's descriptor: a sandbox (the base template) or a desktop (E2B Desktop), the run's folder on an Archil disk.
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

/** E2B Desktop's template: a desktop computer when its setting names no image. */
export const E2B_DESKTOP_TEMPLATE = "desktop";
/** E2B's base template: a sandbox when its setting names no image. */
export const E2B_BASE_TEMPLATE = "base";

export const E2B = defineProvider({
	id: "e2b",
	label: "E2B",
	keys: [{ name: "E2B_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: ["archil"],
	capabilities: [SANDBOX, LINUX_DESKTOP],
	defaultImage: { sandbox: E2B_BASE_TEMPLATE, desktop: E2B_DESKTOP_TEMPLATE },
	load: () => import("../e2b.js"),
});
