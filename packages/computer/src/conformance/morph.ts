// Morph for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider morph`. It makes real
// instances, which bill until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_MORPH=1 and a key for an account you
// can bill, under COMPUTER_MORPH_API_KEY (never MORPH_API_KEY, which may hold another team's key). The box snapshot's
// first build in an account takes minutes. Every computer of a run lives at most 30 minutes, by Morph's TTL and init's
// deadline, and the run's sweep deletes what is left.
import { accountOf, create, type MorphOptions, type MorphProvider } from "../morph.js";
import { type Env, type HostedModuleOptions, hostedModule, lifetimeFromEnv, preparedImage, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const MORPH_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_MORPH",
	/** apiKey, required: the account's API key. */
	key: "COMPUTER_MORPH_API_KEY",
	/** The snapshot every computer of the run starts from; default the box snapshot (prepareImage). */
	snapshot: "COMPUTER_MORPH_SNAPSHOT",
	/** apiUrl: Morph's REST API. */
	apiUrl: "COMPUTER_MORPH_API_URL",
	/** daemonPath: the daemon binary. */
	daemon: "COMPUTER_MORPH_DAEMON",
	/** maxLifetimeMs: the cap, in ms, at most 86400000; a run takes it when it is under 30 minutes, else 30 minutes. */
	maxLifetimeMs: "COMPUTER_MORPH_MAX_LIFETIME_MS",
} as const;

export const ENV = MORPH_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type MorphSettings = Pick<MorphOptions, "apiKey" | "apiUrl" | "daemonPath" | "maxLifetimeMs">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without a key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): MorphSettings {
	const apiKey = requiredSecret(env, MORPH_ENV.key, "a Morph API key");
	const lifetime = lifetimeFromEnv(env, MORPH_ENV.maxLifetimeMs, "86400000");
	return { apiKey, ...setOptions(env, { apiUrl: MORPH_ENV.apiUrl, daemonPath: MORPH_ENV.daemon }), ...lifetime };
}

export const conformanceNotes: string[] = [
	"morph: every computer is a Morph instance started from a snapshot (the box snapshot, built in the key's account, unless COMPUTER_MORPH_SNAPSHOT names one), with a TTL whose action is stop, read back from Morph and probed from inside; the daemon is a child, started over SSH through Morph's gateway (ssh.cloud.morph.so, as the instance id with the instance's own key), and every command goes over that SSH. Morph has no egress control: network none, open and a list are all init's. No Archil mount yet and no desktop; no stream(), so screen.stream is skipped.",
];

export interface MorphModuleOptions extends HostedModuleOptions, Pick<MorphOptions, "ssh2" | "fetch" | "daemonPath" | "timeouts" | "onNote" | "sshHost" | "sshPort"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<MorphModuleOptions, MorphSettings, MorphProvider>({
	live: { name: MORPH_ENV.live, what: "the Morph conformance module makes real instances, which bill until deleted", whose: "a key for an account you can bill" },
	settingsFromEnv,
	create,
	host: ["ssh2", "fetch", "timeouts", "onNote", "sshHost", "sshPort"],
	run: [],
	runDefined: ["daemonPath"],
	// One key is one account, and one listing covers all of it.
	scope: ({ apiKey, apiUrl }) => accountOf(apiKey, apiUrl),
});

/** The run's snapshot: COMPUTER_MORPH_SNAPSHOT, else the box snapshot, found or built in the key's account first (live). */
export async function conformanceImage(options: MorphModuleOptions = {}, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
	const { env = process.env } = options;
	const named = env[MORPH_ENV.snapshot];
	if (named) return named;
	return preparedImage(await createProvider(options), signal, "the Morph box snapshot");
}
