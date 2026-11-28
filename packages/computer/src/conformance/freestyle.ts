// Freestyle VMs for the conformance run. It makes real VMs, which bill while they run, so it runs only with
// AGENTRUN_COMPUTER_LIVE_FREESTYLE=1 and a key for an account you can bill, under COMPUTER_FREESTYLE_API_KEY (never
// FREESTYLE_API_KEY, which may hold another account's key). Its machines dial the server that minted their tokens
// (facts.connect "dial"), so a Core run has to happen inside that server's own process, behind its public address:
// serve's packages/serve/scripts/dial-conformance.mjs --provider freestyle does it: it gives createProvider() its dial (the
// public URL, the minted tokens and the attach hub) and the run a DialKit over the same server. From a laptop's CLI there
// is no such server: dialKit() refuses in words, and the provider refuses every create before Freestyle is called. Every
// computer of a run has a deadline of at most 30 minutes, which the janitor keeps, and Freestyle's ttlSeconds at its backstop.
import { FREESTYLE } from "../descriptors/freestyle.js";
import { accountOf, create, type FreestyleProvider, type FreestyleProviderOptions } from "../freestyle.js";
import { dialOnlyFromServer } from "./dial-only.js";
import { type Env, type HostedModuleOptions, hostedModule, preparedImage, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const FREESTYLE_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_FREESTYLE",
	/** apiKey, required: the account's API key. */
	key: "COMPUTER_FREESTYLE_API_KEY",
	/** The snapshot every computer of the run starts from (its sh- id or slug); default the box snapshot prepareImage() finds or builds. */
	image: "COMPUTER_FREESTYLE_IMAGE",
	/** apiUrl: the API's root; default https://api.freestyle.sh. */
	apiUrl: "COMPUTER_FREESTYLE_API_URL",
} as const;

export const ENV = FREESTYLE_ENV;

export type FreestyleSettings = Pick<FreestyleProviderOptions, "apiKey" | "apiUrl">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without a key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): FreestyleSettings {
	const apiKey = requiredSecret(env, FREESTYLE_ENV.key, "a Freestyle API key");
	return { apiKey, ...setOptions(env, { apiUrl: FREESTYLE_ENV.apiUrl }) };
}

export const conformanceNotes: string[] = [
	"freestyle: every computer is a Freestyle VM (its own kernel, amd64 unverified) from the box image's snapshot, which prepareImage() finds in the key's account or builds there on freestyle/ubuntu (or the one COMPUTER_FREESTYLE_IMAGE names), ephemeral, never restarted, its ttlSeconds at the backstop; the VM dials the server: one exec-await as root starts agentrun-dial detached, the boot env its env; labels are packed into the VM's metadata; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run. Network none, open and a list are init's. No Archil mount and no desktop.",
];

export interface FreestyleModuleOptions extends HostedModuleOptions, Pick<FreestyleProviderOptions, "fetch" | "dial" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<FreestyleModuleOptions, FreestyleSettings, FreestyleProvider>({
	live: { name: FREESTYLE_ENV.live, what: "the Freestyle conformance module makes real VMs, which bill while they run", whose: "a key for an account you can bill" },
	settingsFromEnv,
	create,
	host: ["fetch", "timeouts"],
	run: ["dial", "onNote"],
	runDefined: ["daemonPath"],
	// One key is one account, and one listing covers all of it.
	scope: ({ apiKey, apiUrl }) => accountOf(apiKey, apiUrl),
});

/**
 * The image every computer of the run starts from: COMPUTER_FREESTYLE_IMAGE, else the box snapshot the run's provider
 * finds in the key's account or builds there first (prepareImage, live).
 */
export async function conformanceImage(options: FreestyleModuleOptions = {}, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
	const { env = process.env } = options;
	return env[FREESTYLE_ENV.image] || preparedImage(await createProvider(options), signal, "the Freestyle box snapshot");
}

/** The server the run's machines dial, for provider.dial-token, as the CLI asks for it: refused in words (dial-only.ts). */
export const dialKit = dialOnlyFromServer(FREESTYLE);
