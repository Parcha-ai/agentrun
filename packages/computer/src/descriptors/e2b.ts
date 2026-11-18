// E2B's descriptor: a sandbox or a desktop, the run's folder on an Archil disk. Both start from our box template, the
// public E2B template its prepareImage() answers (box-image.ts boxE2bTemplate), which has Archil's client and a desktop.
import { defineProvider } from "../descriptor.js";
import { LINUX_DESKTOP, SANDBOX } from "./shared.js";

export const E2B = defineProvider({
	id: "e2b",
	label: "E2B",
	keys: [{ name: "E2B_API_KEY", option: "apiKey", required: true }],
	// How the server reaches its machines: exec (the provider's default, when the server's settings name none), a bridge
	// through envd per connection, or dial, the machine dials the server (a sandbox or a desktop, as on exec).
	settings: [{ name: "e2bConnect", option: "connect" }],
	metered: true,
	mounts: ["archil"],
	// None: its programs run in a network of their own, their loopback alone (isolation.ts), and the sandbox is made with
	// no internet access. Open and a list: the sandbox gets internet access, and its programs' one way out is init's egress
	// proxy, which reaches the public internet alone, and with a list its hosts alone (hosted/network.ts).
	network: ["none", "open", "allow"],
	capabilities: [SANDBOX, LINUX_DESKTOP],
	// No default image: every computer, sandbox or desktop, starts from the box template its prepareImage() answers.
	prepareImage: true,
	load: () => import("../e2b.js"),
});
