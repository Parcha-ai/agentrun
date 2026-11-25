// Morph for the conformance CLI: `pnpm --filter @parcha/agentrun-computer run conformance --provider morph`. It makes real
// instances, which bill until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_MORPH=1 and a key for an account you
// can bill, under COMPUTER_MORPH_API_KEY. The provider reads no environment: this module reads its own COMPUTER_MORPH_*
// names (never MORPH_API_KEY, which may hold another team's key) and passes each to create() as its option. The live
// switch is checked first, before any other setting is read. The live sweep (sweep.ts, --provider morph) reads the same
// names through createHost, which needs no live switch: it makes nothing.
//
// The run's snapshot is COMPUTER_MORPH_SNAPSHOT, else the box snapshot, which the run finds or builds in the key's
// account first through the provider's prepareImage() (a first build takes minutes). The daemon is uploaded into each
// instance over SSH (dist/computerd-linux-amd64, `npm run build:daemon`); the drifted provider uploads one built with Go
// as version <version>-drift. Every computer of a run lives at most 30 minutes, by Morph's TTL and init's deadline, and
// the run's sweep deletes what is left.
import type { MachineHost } from "../host.js";
import { accountOf, create, type MorphOptions, type MorphProvider } from "../morph.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

/** The environment this module reads, by name, each for the option its comment names, the live switch and the run's snapshot. */
export const MORPH_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_MORPH",
	/** apiKey, required: the account's API key. */
	key: "COMPUTER_MORPH_API_KEY",
	/** The snapshot every computer of the run starts from; default the box snapshot (prepareImage). */
	snapshot: "COMPUTER_MORPH_SNAPSHOT",
	/** apiUrl: Morph's REST API; default https://cloud.morph.so/api. */
	apiUrl: "COMPUTER_MORPH_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_MORPH_DAEMON",
	/** maxLifetimeMs: the cap, in ms, at most 86400000; a run takes it when it is under 30 minutes, else 30 minutes. */
	maxLifetimeMs: "COMPUTER_MORPH_MAX_LIFETIME_MS",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = MORPH_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type MorphSettings = Pick<MorphOptions, "apiKey" | "apiUrl" | "daemonPath" | "maxLifetimeMs">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without a key, never echoing it. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): MorphSettings {
	const apiKey = env[MORPH_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${MORPH_ENV.key} to a Morph API key: the conformance module reads it there and nowhere else, never from MORPH_API_KEY`);
	const lifetime = env[MORPH_ENV.maxLifetimeMs] || undefined;
	if (lifetime !== undefined && !/^\d+$/.test(lifetime)) throw new Error(`${MORPH_ENV.maxLifetimeMs} is a whole number of milliseconds, such as 86400000`);
	const apiUrl = env[MORPH_ENV.apiUrl] || undefined;
	const daemonPath = env[MORPH_ENV.daemon] || undefined;
	return {
		apiKey,
		...(apiUrl === undefined ? {} : { apiUrl }),
		...(daemonPath === undefined ? {} : { daemonPath }),
		...(lifetime === undefined ? {} : { maxLifetimeMs: Number(lifetime) }),
	};
}

/** The longest lifetime a computer of a run may ask for: Morph's TTL and init end it at its deadline, the sweep deletes it. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"morph: every computer is a Morph instance started from a snapshot (the box snapshot, built in the key's account, unless COMPUTER_MORPH_SNAPSHOT names one), with a TTL whose action is stop, read back from Morph and probed from inside; the daemon is a child, started over SSH through Morph's gateway (ssh.cloud.morph.so, as the instance id with the instance's own key), and every command goes over that SSH. Morph has no egress control: network none, open and a list are all init's. No Archil mount yet and no desktop; no stream(), so screen.stream is skipped.",
];

export interface MorphModuleOptions extends Pick<MorphOptions, "ssh2" | "fetch" | "daemonPath" | "timeouts" | "onNote" | "sshHost" | "sshPort"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
}

function live(env: Record<string, string | undefined>): void {
	if (env[MORPH_ENV.live] !== "1") {
		throw new Error(`the Morph conformance module makes real instances, which bill until deleted: set ${MORPH_ENV.live}=1, with a key for an account you can bill, to run it`);
	}
}

/** The test doubles a caller hands in, each only when given. */
const doubles = ({ ssh2, fetch, timeouts, onNote, sshHost, sshPort }: MorphModuleOptions) => ({
	...(ssh2 ? { ssh2 } : {}),
	...(fetch ? { fetch } : {}),
	...(timeouts ? { timeouts } : {}),
	...(onNote ? { onNote } : {}),
	...(sshHost ? { sshHost } : {}),
	...(sshPort ? { sshPort } : {}),
});

/** A run's cap: COMPUTER_MORPH_MAX_LIFETIME_MS when it is shorter, else CONFORMANCE_MAX_LIFETIME_MS. */
const runCap = (settings: MorphSettings) => Math.min(settings.maxLifetimeMs ?? CONFORMANCE_MAX_LIFETIME_MS, CONFORMANCE_MAX_LIFETIME_MS);

/** The provider the CLI runs; throws in words without the live switch, or when a setting is missing or wrong. */
export async function createProvider(options: MorphModuleOptions = {}): Promise<MorphProvider> {
	const { env = process.env, daemonPath } = options;
	live(env);
	const settings = settingsFromEnv(env);
	return create({ ...settings, ...doubles(options), ...(daemonPath === undefined ? {} : { daemonPath }), maxLifetimeMs: runCap(settings) });
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider(options: MorphModuleOptions = {}): Promise<MorphProvider> {
	const { env = process.env, buildDaemon = (version) => buildDriftDaemon("amd64", version) } = options;
	live(env);
	const settings = settingsFromEnv(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return create({ ...settings, ...doubles(options), daemonPath, maxLifetimeMs: runCap(settings) });
}

/** The run's snapshot: COMPUTER_MORPH_SNAPSHOT, else the box snapshot, found or built in the key's account first (live). */
export async function conformanceImage(options: MorphModuleOptions = {}, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
	const { env = process.env } = options;
	const named = env[MORPH_ENV.snapshot];
	if (named) return named;
	const ready = await (await createProvider(options)).prepareImage(signal ? { signal } : {});
	if (!ready.ok) throw new Error(`the Morph box snapshot: ${ready.error.message}`);
	return ready.value;
}

/**
 * The Morph host the live sweep (sweep.ts) lists and deletes through, from the same settings; it needs no live switch,
 * since the sweep makes nothing, and it calls nothing until the sweep does.
 */
export async function createHost(options: Pick<MorphModuleOptions, "env" | "ssh2" | "fetch"> = {}): Promise<MachineHost> {
	return (await create({ ...settingsFromEnv(options.env ?? process.env), ...doubles(options) })).host;
}

/** Where the host lists, in words: one key is one account, and one listing covers all of it. The key is named by its sha256 prefix alone. */
export function sweepScope({ env = process.env }: Pick<MorphModuleOptions, "env"> = {}): string {
	const { apiKey, apiUrl } = settingsFromEnv(env);
	return accountOf(apiKey, apiUrl);
}
