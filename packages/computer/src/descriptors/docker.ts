// Docker's descriptor: computers on this machine's Docker, a sandbox or a desktop; no key, no meter.
import { DOCKER_ENV_NAMES } from "./env-names.js";
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

export const DOCKER = defineProvider({
	id: "docker",
	label: "Docker",
	keys: [],
	metered: false,
	mounts: ["bind"],
	// None, open, or an allowlist through the server's egress proxy.
	network: ["none", "open", "allow"],
	// Each configuration built by its own create() options: the desktop's start the X server (desktop: {}); without them
	// the provider makes a linux computer, with no screen and no apps.
	capabilities: [SANDBOX, { ...LINUX_DESKTOP, options: { desktop: {} } }],
	// No default image: the server makes one from the provider's recipe (prepareImage) before the first create.
	prepareImage: true,
	local: true,
	// What the docker CLI reads (env-names.ts DOCKER_ENV_NAMES): the server's own values of these, and no other.
	hostEnv: DOCKER_ENV_NAMES,
	load: () => import("../docker.js"),
});
