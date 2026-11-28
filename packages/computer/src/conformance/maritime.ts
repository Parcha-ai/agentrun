// Maritime for the conformance CLI. It makes real VMs, which bill while they run, so it runs only with
// AGENTRUN_COMPUTER_LIVE_MARITIME=1 and your own key, under COMPUTER_MARITIME_API_KEY (never MARITIME_API_KEY, which may
// hold another account's). Its machines dial the server that minted their tokens, so its Core runs inside a server the
// internet reaches: packages/serve/scripts/dial-conformance.mjs --provider maritime (dialKit here refuses in words).
// Every computer of a run has a deadline of at most 30 minutes, which the janitor keeps, and a backstop Maritime keeps.
import { boxImageRef } from "../box-image.js";
import { MARITIME } from "../descriptors/maritime.js";
import { httpsBase } from "../hosted/rest.js";
import { create, DEFAULT_API_URL, type MaritimeProvider, type MaritimeProviderOptions } from "../maritime.js";
import { dialOnlyFromServer } from "./dial-only.js";
import { type Env, type HostedModuleOptions, hostedModule, keyPrint, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const MARITIME_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_MARITIME",
	/** apiKey, required: a Maritime API key with the sandboxes scope. */
	key: "COMPUTER_MARITIME_API_KEY",
	/** apiUrl: the API's root; default https://api.maritime.sh. */
	apiUrl: "COMPUTER_MARITIME_API_URL",
	/** The image every computer of the run starts from; default the box image's public tag. */
	image: "COMPUTER_MARITIME_IMAGE",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_MARITIME_DAEMON",
} as const;

export const ENV = MARITIME_ENV;

export type MaritimeSettings = Pick<MaritimeProviderOptions, "apiKey" | "apiUrl" | "daemonPath">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): MaritimeSettings {
	const apiKey = requiredSecret(env, MARITIME_ENV.key, "a Maritime API key");
	return { apiKey, ...setOptions(env, { apiUrl: MARITIME_ENV.apiUrl, daemonPath: MARITIME_ENV.daemon }) };
}

export const conformanceNotes: string[] = [
	"maritime: every computer is a Maritime VM (a micro-VM with its own kernel, amd64 unverified) from the box image's public tag; it dials the server: agentrun-dial is a background command started over the VM's data plane with the boot env as its env, kept by its command id for the dial log, exit and redial; labels are the VM's metadata; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run, with the backstop as Maritime's time limit. Network none, open and a list are init's (root's network namespace in the VM unverified). No Archil mount and no desktop.",
];

export interface MaritimeModuleOptions extends HostedModuleOptions, Pick<MaritimeProviderOptions, "fetch" | "daemonPath" | "timeouts" | "onNote" | "dial"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<MaritimeModuleOptions, MaritimeSettings, MaritimeProvider>({
	live: { name: MARITIME_ENV.live, what: "the Maritime conformance module makes real VMs, which bill while they run", whose: "your own key" },
	settingsFromEnv,
	create,
	host: ["fetch", "daemonPath", "timeouts"],
	run: ["onNote", "dial"],
	// The key's account, the key named by its sha256 prefix alone.
	scope: ({ apiKey, apiUrl }) => `the Maritime account of the key ${keyPrint(apiKey)} at ${httpsBase(apiUrl ?? DEFAULT_API_URL, `the Maritime API URL (${MARITIME_ENV.apiUrl})`)}`,
});

/** The image every computer of the run starts from: COMPUTER_MARITIME_IMAGE, else the box image (only it holds agentrun-dial). */
export async function conformanceImage({ env = process.env }: Pick<MaritimeModuleOptions, "env"> = {}): Promise<string> {
	return env[MARITIME_ENV.image] || boxImageRef();
}

export const dialKit = dialOnlyFromServer(MARITIME);
