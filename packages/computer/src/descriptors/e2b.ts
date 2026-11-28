// E2B's descriptor: a sandbox or a desktop, the run's folder on an Archil disk. Both start from our box template, the
// public E2B template its prepareImage() answers (box-image.ts boxE2bTemplate), which has Archil's client and a desktop,
// unless the operator names another (AGENTRUN_E2B_TEMPLATE).
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

/** The operator's template for every E2B computer, in place of the box template: a key, and the descriptor's imageEnv. */
const E2B_TEMPLATE_ENV = "AGENTRUN_E2B_TEMPLATE";

export const E2B = defineProvider({
	id: "e2b",
	label: "E2B",
	// The key, then three operator settings, none a secret: the domain of a cloud that speaks E2B's API (its API is
	// https://api.<domain> unless AGENTRUN_E2B_API_URL names another), and the template every computer starts from. The key
	// is whichever cloud's the domain names.
	keys: [
		{ name: "E2B_API_KEY", option: "apiKey", required: true },
		{ name: "AGENTRUN_E2B_DOMAIN", option: "domain", required: false },
		{ name: "AGENTRUN_E2B_API_URL", option: "apiUrl", required: false },
		{ name: E2B_TEMPLATE_ENV, option: "template", required: false },
	],
	// How the server reaches its machines: exec (the provider's default, when the server's settings name none), a bridge
	// through envd per connection, or dial, the machine dials the server (a sandbox or a desktop, as on exec).
	settings: [{ name: "e2bConnect", option: "connect" }],
	connect: "either",
	metered: true,
	// Its create answers the size the vendor runs the computer at (resources), which its time is priced by.
	sized: true,
	mounts: ["archil"],
	// None: its programs run in a network of their own, their loopback alone (isolation.ts), and the sandbox is made with
	// no internet access. Open and a list: the sandbox gets internet access, and its programs' one way out is init's egress
	// proxy, which reaches the public internet alone, and with a list its hosts alone (hosted/network.ts).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX, LINUX_DESKTOP],
	// No default image: every computer, sandbox or desktop, starts from the template its prepareImage() answers, the box
	// one or the operator's.
	prepareImage: true,
	// The operator's template, as Daytona's AGENTRUN_DAYTONA_SNAPSHOT: serve reads it as the image of every E2B computer,
	// and takes a computer.image that names it. A Mode 2 folder mounts Archil in it, so it needs box/Dockerfile's client.
	imageEnv: E2B_TEMPLATE_ENV,
	load: () => import("../e2b.js"),
});
