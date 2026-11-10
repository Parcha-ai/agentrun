// Docker's descriptor: computers on this machine's Docker, a sandbox or a desktop; no key, no meter.
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

export const DOCKER = defineProvider({
	id: "docker",
	label: "Docker",
	keys: [],
	metered: false,
	mounts: ["bind"],
	capabilities: [SANDBOX, LINUX_DESKTOP],
	// No default image: the server makes one from the provider's recipe (prepareImage) before the first create.
	prepareImage: true,
	local: true,
	load: () => import("../docker.js"),
});
