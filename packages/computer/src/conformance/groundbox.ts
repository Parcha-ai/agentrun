// Groundbox for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider groundbox`. It makes
// real sandboxes, which bill until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_GROUNDBOX=1 and your own key,
// under COMPUTER_GROUNDBOX_API_KEY. The provider reads no environment: this module reads its own COMPUTER_GROUNDBOX_*
// names (never GROUNDBOX_API_KEY, which may hold another team's key) and passes each to create() as its option. The live
// switch is checked first, before any other setting is read. The live sweep (sweep.ts, --provider groundbox) reads the
// same names through createHost, which needs no live switch: it makes nothing; sweepScope names the key and API a
// before file must have been listed from.
//
// The daemon is uploaded into each sandbox (dist/computerd-linux-amd64, `npm run build:daemon`), so a run publishes
// nothing. The drifted provider uploads a daemon built with Go as version <version>-drift. Every computer of a run has
// a deadline of at most 30 minutes, and Groundbox's own timer ends it 5 minutes past that.
import { createHash } from "node:crypto";
import { boxImageRef } from "../box-image.js";
import { create, type GroundboxProvider, type GroundboxProviderOptions } from "../groundbox.js";
import type { MachineHost } from "../host.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

/** The environment this module reads, by name, each for the option its comment names, the live switch and the run's image. */
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
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = GROUNDBOX_ENV;

const DEFAULT_API_URL = "https://api.groundbox.dev/v1";

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type GroundboxSettings = Pick<GroundboxProviderOptions, "apiKey" | "apiUrl" | "daemonPath" | "daemonUser">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing it. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): GroundboxSettings {
	const apiKey = env[GROUNDBOX_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${GROUNDBOX_ENV.key} to a Groundbox API key: the conformance module reads it there and nowhere else, never from GROUNDBOX_API_KEY`);
	const apiUrl = env[GROUNDBOX_ENV.apiUrl] || undefined;
	const daemonPath = env[GROUNDBOX_ENV.daemon] || undefined;
	const daemonUser = env[GROUNDBOX_ENV.user] || undefined;
	return { apiKey, ...(apiUrl === undefined ? {} : { apiUrl }), ...(daemonPath === undefined ? {} : { daemonPath }), ...(daemonUser === undefined ? {} : { daemonUser }) };
}

/** The longest lifetime a computer of a run may ask for. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"groundbox: every computer is a Groundbox sandbox (a Firecracker microVM, amd64) whose own timer is set to the adapter's backstop; the daemon is a child of a resumable command of the WebSocket command stream, installed as root (the box image) or through passwordless sudo (Groundbox's own image), its output read by position across sockets and its stdin written to a fifo one answered call at a time; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run. Network none, open and a list are init's. The run's folder is a synced folder; no Archil mount, no desktop.",
];

export interface GroundboxModuleOptions extends Pick<GroundboxProviderOptions, "fetch" | "webSocket" | "daemonPath" | "timeouts"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
}

function live(env: Record<string, string | undefined>): void {
	if (env[GROUNDBOX_ENV.live] !== "1") throw new Error(`the Groundbox conformance module makes real sandboxes, which bill until deleted: set ${GROUNDBOX_ENV.live}=1, with your own key, to run it`);
}

/** The test doubles a caller hands in, each only when given. */
const doubles = ({ fetch, webSocket, daemonPath, timeouts }: GroundboxModuleOptions) => ({ ...(fetch ? { fetch } : {}), ...(webSocket ? { webSocket } : {}), ...(daemonPath ? { daemonPath } : {}), ...(timeouts ? { timeouts } : {}) });

/** The provider the CLI runs; throws in words without the live switch or the key. */
export async function createProvider(options: GroundboxModuleOptions = {}): Promise<GroundboxProvider> {
	const { env = process.env } = options;
	live(env);
	return create({ ...settingsFromEnv(env), ...doubles(options), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider(options: GroundboxModuleOptions = {}): Promise<GroundboxProvider> {
	const { env = process.env, buildDaemon = (version) => buildDriftDaemon("amd64", version) } = options;
	live(env);
	const settings = settingsFromEnv(env);
	return create({ ...settings, ...doubles(options), daemonPath: await buildDaemon(DRIFT_VERSION), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/** The image every computer of the run starts from: COMPUTER_GROUNDBOX_IMAGE, else the box image prepareImage() answers. */
export async function conformanceImage({ env = process.env }: Pick<GroundboxModuleOptions, "env"> = {}): Promise<string> {
	return env[GROUNDBOX_ENV.image] || boxImageRef();
}

/**
 * The Groundbox host the live sweep (sweep.ts) lists and deletes through, from the same settings; it needs no live
 * switch, since the sweep makes nothing, and it calls nothing until the sweep does.
 */
export async function createHost(options: Pick<GroundboxModuleOptions, "env" | "fetch" | "webSocket"> = {}): Promise<MachineHost> {
	return (await create({ ...settingsFromEnv(options.env ?? process.env), ...doubles(options) })).host;
}

/** Where the sweep lists, in words: the key's team, the key named by its sha256 prefix alone. */
export function sweepScope({ env = process.env }: Pick<GroundboxModuleOptions, "env"> = {}): string {
	const { apiKey, apiUrl } = settingsFromEnv(env);
	const key = createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12);
	return `the Groundbox team of the key sha256:${key} at ${apiUrl ?? DEFAULT_API_URL}`;
}
