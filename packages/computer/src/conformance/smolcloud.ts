// smol cloud for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider smolcloud`. It
// makes real machines, which bill until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_SMOLCLOUD=1 and your own
// key, under COMPUTER_SMOLCLOUD_API_KEY (never SMOLCLOUD_API_KEY, which may hold another account's key). Every computer
// of a run has a deadline of at most 30 minutes, and smol cloud's delete timer is set 5 minutes past it.
import { boxImageRef } from "../box-image.js";
import { create, type SmolcloudProvider, type SmolcloudProviderOptions } from "../smolcloud.js";
import { type Env, type HostedModuleOptions, hostedModule, keyPrint, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const SMOLCLOUD_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_SMOLCLOUD",
	/** apiKey, required: the smol cloud API key. */
	key: "COMPUTER_SMOLCLOUD_API_KEY",
	/** apiUrl: the REST API; default https://api.smolmachines.com. */
	apiUrl: "COMPUTER_SMOLCLOUD_API_URL",
	/** The OCI image every computer of the run starts from; default the box image (boxImageRef). */
	image: "COMPUTER_SMOLCLOUD_IMAGE",
} as const;

export const ENV = SMOLCLOUD_ENV;

/** The provider's options this module reads from env; throws in words without the key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): Pick<SmolcloudProviderOptions, "apiKey" | "apiUrl"> {
	const apiKey = requiredSecret(env, SMOLCLOUD_ENV.key, "a smol cloud API key");
	return { apiKey, ...setOptions(env, { apiUrl: SMOLCLOUD_ENV.apiUrl }) };
}

export const conformanceNotes: string[] = [
	"smolcloud: every computer is a smol cloud machine (a microVM on an amd64 node) with its idle stop off and its delete timer at the adapter's backstop; the daemon is a child of a resumable interactive exec, its stdio the exec's long-polled output and numbered stdin frames; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run. Network none, open and a list are init's. No mount (smol cloud binds its storage disk at /workspace) and no desktop.",
];

export interface SmolcloudModuleOptions extends HostedModuleOptions, Pick<SmolcloudProviderOptions, "fetch" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<SmolcloudModuleOptions, Pick<SmolcloudProviderOptions, "apiKey" | "apiUrl">, SmolcloudProvider>({
	live: { name: SMOLCLOUD_ENV.live, what: "the smol cloud conformance module makes real machines, which bill until deleted", whose: "your own key" },
	settingsFromEnv,
	create,
	host: ["fetch", "daemonPath", "timeouts"],
	run: ["onNote"],
	// The key's account, the key named by its sha256 prefix alone.
	scope: ({ apiKey, apiUrl }) => `the smol cloud account of the key ${keyPrint(apiKey)} at ${apiUrl ?? "https://api.smolmachines.com"}`,
});

/** The image every computer of the run starts from: COMPUTER_SMOLCLOUD_IMAGE, else the box image prepareImage() answers. */
export async function conformanceImage({ env = process.env }: Pick<SmolcloudModuleOptions, "env"> = {}): Promise<string> {
	return env[SMOLCLOUD_ENV.image] || boxImageRef();
}
