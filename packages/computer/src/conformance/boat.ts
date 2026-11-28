// boat for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider boat`. It makes real
// sandboxes, which bill while they run, so it runs only with AGENTRUN_COMPUTER_LIVE_BOAT=1 and your own key, under
// COMPUTER_BOAT_API_KEY (never BOAT_API_KEY, which may hold another account's). Every computer of a run has a deadline
// of at most 30 minutes, which boat's ttlSeconds and the janitor keep. A trial account starts 5 sandboxes a minute
// and holds 2 at once: run it with --concurrency 2.
import { BOAT_IMAGE } from "../descriptors/boat.js";
import { type BoatProvider, type BoatProviderOptions, create, DEFAULT_API_URL } from "../boat.js";
import { httpsBase } from "../hosted/rest.js";
import { type Env, type HostedModuleOptions, hostedModule, keyPrint, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const BOAT_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_BOAT",
	/** apiKey, required: a boat API key (boat_...). */
	key: "COMPUTER_BOAT_API_KEY",
	/** apiUrl: the API's root; default https://boat.dev/api/v1. */
	apiUrl: "COMPUTER_BOAT_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_BOAT_DAEMON",
} as const;

export const ENV = BOAT_ENV;

export type BoatSettings = Pick<BoatProviderOptions, "apiKey" | "apiUrl" | "daemonPath">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): BoatSettings {
	const apiKey = requiredSecret(env, BOAT_ENV.key, "a boat API key");
	return { apiKey, ...setOptions(env, { apiUrl: BOAT_ENV.apiUrl, daemonPath: BOAT_ENV.daemon }) };
}

export const conformanceNotes: string[] = [
	"boat: every computer is a boat sandbox (a Firecracker microVM in boat's EU regions, amd64) from boat's Ubuntu 24.04 base; the daemon is a child of a command over SSH, as boat's user through sudo -n, with this host's own key and the host key boat answers pinned; labels are boat's own, filtered server side and again here; lifetime is boat's ttlSeconds, capped at 30 minutes for the run. Network none, open and a list are init's. No Archil mount and no desktop.",
];

export interface BoatModuleOptions extends HostedModuleOptions, Pick<BoatProviderOptions, "ssh2" | "fetch" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<BoatModuleOptions, BoatSettings, BoatProvider>({
	live: { name: BOAT_ENV.live, what: "the boat conformance module makes real sandboxes, which bill while they run", whose: "your own key" },
	settingsFromEnv,
	create,
	host: ["ssh2", "fetch", "daemonPath", "timeouts"],
	run: ["onNote"],
	// The key's account, the key named by its sha256 prefix alone.
	scope: ({ apiKey, apiUrl }) => `the boat account of the key ${keyPrint(apiKey)} at ${httpsBase(apiUrl ?? DEFAULT_API_URL, `the boat API URL (${BOAT_ENV.apiUrl})`)}`,
});

/** The image every computer of the run starts from: boat's base. */
export async function conformanceImage(_options: Pick<BoatModuleOptions, "env"> = {}): Promise<string> {
	return BOAT_IMAGE;
}
