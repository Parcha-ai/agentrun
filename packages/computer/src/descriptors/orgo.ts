// Orgo's descriptor: a Linux desktop on Orgo's cloud.
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP } from "./shared.js";

/** Orgo's Linux image: a desktop computer when its setting names none. */
export const ORGO_BASE_IMAGE = "linux";

export const ORGO = defineProvider({
	id: "orgo",
	label: "Orgo",
	keys: [{ name: "ORGO_API_KEY", option: "apiKey", required: true }],
	metered: true,
	// None yet: an Archil mount needs an Orgo template that bakes the helper.
	mounts: [],
	capabilities: [LINUX_DESKTOP],
	defaultImage: { desktop: ORGO_BASE_IMAGE },
	load: () => import("../orgo.js"),
});
