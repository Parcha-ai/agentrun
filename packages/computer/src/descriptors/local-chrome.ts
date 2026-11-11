// Local Chrome's descriptor: this machine's Chrome, a browser computer with no key and nothing billed, on public
// addresses through its egress proxy. No live view: a person watching runs it headed. Its id is local-chrome, a token
// nothing else in the code base uses (a folder mode, a region and an API tag are all "local").
import { defineProvider } from "../descriptor.js";
import { BROWSER_IMAGE } from "./shared.js";

export const LOCAL = defineProvider({
	id: "local-chrome",
	label: "Local Chrome",
	keys: [],
	metered: false,
	mounts: [],
	// Public addresses only, through its egress proxy: it cannot be closed or narrowed.
	network: ["open"],
	capabilities: [{ kind: "browser", groups: ["cdp"] }],
	defaultImage: { browser: BROWSER_IMAGE },
	// Where it finds this machine's Chrome (chrome.ts CHROME_ENV, then PATH): the server's own values of these, and no
	// other. Written out, so reading the descriptor loads no provider code (kinds.test holds the two lists together).
	hostEnv: ["PI_BROWSER_CHROME", "CHROME_PATH", "PATH"],
	load: () => import("../local.js"),
});
