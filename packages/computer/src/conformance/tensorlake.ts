// Tensorlake for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider tensorlake`. It
// makes real sandboxes, which bill while they run, so it runs only with AGENTRUN_COMPUTER_LIVE_TENSORLAKE=1 and a key for
// a project you can bill, under COMPUTER_TENSORLAKE_API_KEY (never TENSORLAKE_API_KEY, which may hold another project's
// key). Every computer of a run has a deadline of at most 30 minutes, which the janitor keeps, and an idle threshold at
// its backstop.
import { TENSORLAKE_IMAGE } from "../descriptors/tensorlake.js";
import { accountOf, create, type TensorlakeProvider, type TensorlakeProviderOptions } from "../tensorlake.js";
import { type Env, type HostedModuleOptions, hostedModule, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const TENSORLAKE_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_TENSORLAKE",
	/** apiKey, required: the project's API key. */
	key: "COMPUTER_TENSORLAKE_API_KEY",
	/** The image every computer of the run starts from; default tensorlake/ubuntu-minimal. */
	image: "COMPUTER_TENSORLAKE_IMAGE",
	/** apiUrl: the API's root; default https://api.tensorlake.ai. */
	apiUrl: "COMPUTER_TENSORLAKE_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_TENSORLAKE_DAEMON",
} as const;

export const ENV = TENSORLAKE_ENV;

export type TensorlakeSettings = Pick<TensorlakeProviderOptions, "apiKey" | "apiUrl" | "daemonPath">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without a key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): TensorlakeSettings {
	const apiKey = requiredSecret(env, TENSORLAKE_ENV.key, "a Tensorlake API key");
	return { apiKey, ...setOptions(env, { apiUrl: TENSORLAKE_ENV.apiUrl, daemonPath: TENSORLAKE_ENV.daemon }) };
}

export const conformanceNotes: string[] = [
	"tensorlake: every computer is a Tensorlake sandbox (a microVM) from tensorlake/ubuntu-minimal unless COMPUTER_TENSORLAKE_IMAGE names another image of the project, its idle threshold at the backstop and no auto resume; the daemon is a child, started over SSH that the sandbox proxy enables for this process's own key and carries through its TCP tunnel, as tl-user with its sudo; the run, the epoch and the deadline are in the sandbox's name, every label in a root-only file the processes API reads; lifetime is the janitor's, by the deadline in the name, capped at 30 minutes for the run. Network none, open and a list are init's. No Archil mount and no desktop.",
];

export interface TensorlakeModuleOptions extends HostedModuleOptions, Pick<TensorlakeProviderOptions, "ssh2" | "fetch" | "WebSocket" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<TensorlakeModuleOptions, TensorlakeSettings, TensorlakeProvider>({
	live: { name: TENSORLAKE_ENV.live, what: "the Tensorlake conformance module makes real sandboxes, which bill while they run", whose: "a key for a project you can bill" },
	settingsFromEnv,
	create,
	host: ["ssh2", "fetch", "WebSocket", "timeouts", "onNote"],
	run: [],
	runDefined: ["daemonPath"],
	// One key is one project, and one listing covers all of it.
	scope: ({ apiKey, apiUrl }) => accountOf(apiKey, apiUrl),
});

/** The image every computer of the run starts from: COMPUTER_TENSORLAKE_IMAGE, else tensorlake/ubuntu-minimal. */
export async function conformanceImage({ env = process.env }: Pick<TensorlakeModuleOptions, "env"> = {}): Promise<string> {
	return env[TENSORLAKE_ENV.image] || TENSORLAKE_IMAGE;
}
