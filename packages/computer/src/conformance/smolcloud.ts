// smol cloud for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider smolcloud`. It
// makes real machines, which bill until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_SMOLCLOUD=1 and your own
// key, under COMPUTER_SMOLCLOUD_API_KEY. The provider reads no environment: this module reads its own COMPUTER_SMOLCLOUD_*
// names (never SMOLCLOUD_API_KEY, which may hold another account's key) and passes each to create() as its option. The
// live sweep (sweep.ts, --provider smolcloud) reads the same names through createHost, which needs no live switch: it
// makes nothing. Every computer of a run has a deadline of at most 30 minutes, and smol cloud's delete timer is set
// 5 minutes past it.
import { createHash } from "node:crypto";
import { boxImageRef } from "../box-image.js";
import type { MachineHost } from "../host.js";
import { create, type SmolcloudProvider, type SmolcloudProviderOptions } from "../smolcloud.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

/** The environment this module reads, by name, each for the option its comment names, the live switch and the run's image. */
export const SMOLCLOUD_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_SMOLCLOUD",
	/** apiKey, required: the smol cloud API key. */
	key: "COMPUTER_SMOLCLOUD_API_KEY",
	/** apiUrl: the REST API; default https://api.smolmachines.com. */
	apiUrl: "COMPUTER_SMOLCLOUD_API_URL",
	/** The OCI image every computer of the run starts from; default the box image (boxImageRef). */
	image: "COMPUTER_SMOLCLOUD_IMAGE",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = SMOLCLOUD_ENV;

/** The provider's options this module reads from env; throws in words without the key, never echoing it. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): Pick<SmolcloudProviderOptions, "apiKey" | "apiUrl"> {
	const apiKey = env[SMOLCLOUD_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${SMOLCLOUD_ENV.key} to a smol cloud API key: the conformance module reads it there and nowhere else, never from SMOLCLOUD_API_KEY`);
	const apiUrl = env[SMOLCLOUD_ENV.apiUrl] || undefined;
	return { apiKey, ...(apiUrl === undefined ? {} : { apiUrl }) };
}

/** The longest lifetime a computer of a run may ask for. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"smolcloud: every computer is a smol cloud machine (a microVM on an amd64 node) with its idle stop off and its delete timer at the adapter's backstop; the daemon is a child of a resumable interactive exec, its stdio the exec's long-polled output and numbered stdin frames; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run. Network none, open and a list are init's. No mount (smol cloud binds its storage disk at /workspace) and no desktop.",
];

export interface SmolcloudModuleOptions extends Pick<SmolcloudProviderOptions, "fetch" | "daemonPath" | "timeouts"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
}

function live(env: Record<string, string | undefined>): void {
	if (env[SMOLCLOUD_ENV.live] !== "1") throw new Error(`the smol cloud conformance module makes real machines, which bill until deleted: set ${SMOLCLOUD_ENV.live}=1, with your own key, to run it`);
}

/** The test doubles a caller hands in, each only when given. */
const doubles = ({ fetch, daemonPath, timeouts }: SmolcloudModuleOptions) => ({ ...(fetch ? { fetch } : {}), ...(daemonPath ? { daemonPath } : {}), ...(timeouts ? { timeouts } : {}) });

/** The provider the CLI runs; throws in words without the live switch or the key. */
export async function createProvider(options: SmolcloudModuleOptions = {}): Promise<SmolcloudProvider> {
	const { env = process.env } = options;
	live(env);
	return create({ ...settingsFromEnv(env), ...doubles(options), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider(options: SmolcloudModuleOptions = {}): Promise<SmolcloudProvider> {
	const { env = process.env, buildDaemon = (version) => buildDriftDaemon("amd64", version) } = options;
	live(env);
	const settings = settingsFromEnv(env);
	return create({ ...settings, ...doubles(options), daemonPath: await buildDaemon(DRIFT_VERSION), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/** The image every computer of the run starts from: COMPUTER_SMOLCLOUD_IMAGE, else the box image prepareImage() answers. */
export async function conformanceImage({ env = process.env }: Pick<SmolcloudModuleOptions, "env"> = {}): Promise<string> {
	return env[SMOLCLOUD_ENV.image] || boxImageRef();
}

/**
 * The smol cloud host the live sweep (sweep.ts) lists and deletes through, from the same settings; it needs no live
 * switch, since the sweep makes nothing, and it calls nothing until the sweep does.
 */
export async function createHost(options: Pick<SmolcloudModuleOptions, "env" | "fetch"> = {}): Promise<MachineHost> {
	return (await create({ ...settingsFromEnv(options.env ?? process.env), ...doubles(options) })).host;
}

/** Where the sweep lists, in words: the key's account, the key named by its sha256 prefix alone. */
export function sweepScope({ env = process.env }: Pick<SmolcloudModuleOptions, "env"> = {}): string {
	const { apiKey, apiUrl } = settingsFromEnv(env);
	const key = createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12);
	return `the smol cloud account of the key sha256:${key} at ${apiUrl ?? "https://api.smolmachines.com"}`;
}
