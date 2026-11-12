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
	capabilities: [{ kind: "browser", groups: ["cdp", "stream"] }],
	defaultImage: { browser: BROWSER_IMAGE },
	load: () => import("../kernel.js"),
});
