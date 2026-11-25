// Kernel's descriptor: a cloud Chromium over CDP, with its live view.
import { defineProvider } from "../descriptor.js";
import { BROWSER_IMAGE } from "./shared.js";

export const KERNEL = defineProvider({
	id: "kernel",
	label: "Kernel",
	keys: [{ name: "KERNEL_API_KEY", option: "apiKey", required: true }],
	metered: true,
	mounts: [],
	// Kernel's own network, open: it cannot be closed or narrowed.
	network: ["open"],
	// A server behind a gateway that fronts Kernel's API names it here.
	hostEnv: ["KERNEL_BASE_URL"],
	capabilities: [{ kind: "browser", groups: ["cdp", "stream"] }],
	defaultImage: { browser: BROWSER_IMAGE },
	// A profile Kernel has written back once the browser that saved to it is deleted: nothing to wait out.
	profiles: { settleMs: 0 },
	load: () => import("../kernel.js"),
});
