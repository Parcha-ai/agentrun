// Groundbox for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider groundbox`. It makes
// real sandboxes, which bill until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_GROUNDBOX=1 and your own key,
// under COMPUTER_GROUNDBOX_API_KEY (never GROUNDBOX_API_KEY, which may hold another team's key). Every computer of a run
// has a deadline of at most 30 minutes, and Groundbox's own timer ends it 5 minutes past that.
import { boxImageRef } from "../box-image.js";
import { create, DEFAULT_API_URL, type GroundboxProvider, type GroundboxProviderOptions } from "../groundbox.js";
import { type Env, type HostedModuleOptions, hostedModule, keyPrint, kindFrom, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const GROUNDBOX_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_GROUNDBOX",
	/** apiKey, required: the Groundbox API key. */
	key: "COMPUTER_GROUNDBOX_API_KEY",
	/** apiUrl: the REST API, ending in /v1; default https://api.groundbox.dev/v1. */
	apiUrl: "COMPUTER_GROUNDBOX_API_URL",
	/** The image every computer of the run starts from: a public image, a template, or "default" (Groundbox's own); default the box image (boxImageRef). */
	image: "COMPUTER_GROUNDBOX_IMAGE",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_GROUNDBOX_DAEMON",
	/** daemonUser: uid:gid the daemon runs as; default 2510:2510. */
	user: "COMPUTER_GROUNDBOX_USER",
	/** kind: linux (default) or desktop. */
	kind: "COMPUTER_GROUNDBOX_KIND",
} as const;

export const ENV = GROUNDBOX_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type GroundboxSettings = Pick<GroundboxProviderOptions, "apiKey" | "apiUrl" | "daemonPath" | "daemonUser" | "kind">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): GroundboxSettings {
	const apiKey = requiredSecret(env, GROUNDBOX_ENV.key, "a Groundbox API key");
	return { apiKey, ...setOptions(env, { apiUrl: GROUNDBOX_ENV.apiUrl, daemonPath: GROUNDBOX_ENV.daemon, daemonUser: GROUNDBOX_ENV.user }), ...kindFrom(env, GROUNDBOX_ENV.kind) };
}

export const conformanceNotes: string[] = [
	"groundbox: every computer is a Groundbox sandbox (a Firecracker microVM, amd64) whose own timer is set to the adapter's backstop; the daemon is a child of a resumable command of the WebSocket command stream, installed as root (the box image) or through passwordless sudo (Groundbox's own image), its output read by position across sockets and its stdin written to a fifo one answered call at a time; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run. Network none, open and a list are init's. The run's folder is a synced folder; no Archil mount. Kind desktop (COMPUTER_GROUNDBOX_KIND=desktop) starts from the box image too, with Xvfb on :0 and xfwm4 started through the daemon as the tool user.",
];

export interface GroundboxModuleOptions extends HostedModuleOptions, Pick<GroundboxProviderOptions, "fetch" | "webSocket" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<GroundboxModuleOptions, GroundboxSettings, GroundboxProvider>({
	live: { name: GROUNDBOX_ENV.live, what: "the Groundbox conformance module makes real sandboxes, which bill until deleted", whose: "your own key" },
	settingsFromEnv,
	create,
	host: ["fetch", "webSocket", "daemonPath", "timeouts"],
	run: ["onNote"],
	// The key's team, the key named by its sha256 prefix alone.
	scope: ({ apiKey, apiUrl }) => `the Groundbox team of the key ${keyPrint(apiKey)} at ${apiUrl ?? DEFAULT_API_URL}`,
});

/** The image every computer of the run starts from: COMPUTER_GROUNDBOX_IMAGE, else the box image prepareImage() answers. */
export async function conformanceImage({ env = process.env }: Pick<GroundboxModuleOptions, "env"> = {}): Promise<string> {
	return env[GROUNDBOX_ENV.image] || boxImageRef();
}
