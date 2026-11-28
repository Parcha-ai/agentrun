// InstaBox for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider instabox`. It makes
// real machines, which bill while they run, so it runs only with AGENTRUN_COMPUTER_LIVE_INSTABOX=1 and a key for a
// workspace you can bill, on a paid plan (a computer switches off the idle pause, which the free plan refuses), under
// COMPUTER_INSTABOX_API_KEY (never INSTABOX_API_KEY, which may hold another workspace's key). Every computer of a run
// has a deadline of at most 30 minutes, which the janitor keeps, and InstaBox's delete timer at its backstop.
import { INSTABOX_IMAGE } from "../descriptors/instabox.js";
import { accountOf, create, type InstaboxProvider, type InstaboxProviderOptions } from "../instabox.js";
import { type Env, type HostedModuleOptions, hostedModule, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const INSTABOX_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_INSTABOX",
	/** apiKey, required: the workspace's API key. */
	key: "COMPUTER_INSTABOX_API_KEY",
	/** The template or snapshot every computer of the run starts from; default minimal. */
	image: "COMPUTER_INSTABOX_IMAGE",
	/** apiUrl: the API's root; default https://api.instabox.sh. */
	apiUrl: "COMPUTER_INSTABOX_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_INSTABOX_DAEMON",
} as const;

export const ENV = INSTABOX_ENV;

export type InstaboxSettings = Pick<InstaboxProviderOptions, "apiKey" | "apiUrl" | "daemonPath">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without a key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): InstaboxSettings {
	const apiKey = requiredSecret(env, INSTABOX_ENV.key, "an InstaBox API key");
	return { apiKey, ...setOptions(env, { apiUrl: INSTABOX_ENV.apiUrl, daemonPath: INSTABOX_ENV.daemon }) };
}

export const conformanceNotes: string[] = [
	"instabox: every computer is an InstaBox machine (a Firecracker microVM) from the minimal template unless COMPUTER_INSTABOX_IMAGE names another or a snapshot, its idle pause and maximum run off, its delete timer at the backstop; the daemon is a child, started over SSH through InstaBox's gateway as a token the API mints per machine, the gateway's host key pinned to the fingerprint the token names, and every command goes over that SSH with the machine user's sudo; labels are packed into the machine's metadata; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run. Network none, open and a list are init's. No Archil mount and no desktop.",
];

export interface InstaboxModuleOptions extends HostedModuleOptions, Pick<InstaboxProviderOptions, "ssh2" | "fetch" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<InstaboxModuleOptions, InstaboxSettings, InstaboxProvider>({
	live: { name: INSTABOX_ENV.live, what: "the InstaBox conformance module makes real machines, which bill while they run", whose: "a key for a workspace on a paid plan you can bill" },
	settingsFromEnv,
	create,
	host: ["ssh2", "fetch", "timeouts", "onNote"],
	run: [],
	runDefined: ["daemonPath"],
	// One key is one workspace, and one listing covers all of it.
	scope: ({ apiKey, apiUrl }) => accountOf(apiKey, apiUrl),
});

/** The image every computer of the run starts from: COMPUTER_INSTABOX_IMAGE, else the minimal template. */
export async function conformanceImage({ env = process.env }: Pick<InstaboxModuleOptions, "env"> = {}): Promise<string> {
	return env[INSTABOX_ENV.image] || INSTABOX_IMAGE;
}
