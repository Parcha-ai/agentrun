// Orgo for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider orgo [--image <template>]`.
// It makes real Orgo desktops, so it runs only with AGENTRUN_COMPUTER_LIVE_ORGO=1 and a key the lead has OKed, under
// COMPUTER_ORGO_API_KEY (never ORGO_API_KEY), in the workspace COMPUTER_ORGO_WORKSPACE names. The live switch is checked
// first, before any other setting is read.
//
// The daemon is uploaded into each computer (dist/computerd-linux-amd64, `npm run build:daemon`); the drifted provider
// uploads one built with Go as version <version>-drift. Every computer of a run lives at most 1 h, Orgo's shortest end
// (ends_in_hours 1): Orgo deletes it then whatever happens to the run.
import { create, type OrgoChannel, type OrgoProvider, type OrgoWebSocketFactory } from "../orgo.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

/** The environment this module reads, by name: the live switch, the run's template, and the provider's settings. */
export const ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_ORGO",
	/** The template every computer of the run starts from; default Orgo's base desktop ("linux"). */
	template: "COMPUTER_ORGO_TEMPLATE",
	/** Required: an Orgo API key (never ORGO_API_KEY, which a host may hold for another account). */
	key: "COMPUTER_ORGO_API_KEY",
	/** Required: the workspace the run's computers live in. */
	workspace: "COMPUTER_ORGO_WORKSPACE",
	/** Orgo's API; default https://www.orgo.ai/api. */
	apiUrl: "COMPUTER_ORGO_API_URL",
} as const;
const ORGO_ENV = ENV;

/** The longest lifetime a computer of a run may ask for: Orgo's shortest end, 1 h. */
export const CONFORMANCE_MAX_LIFETIME_MS = 60 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"orgo: a Linux desktop on Orgo with computerd inside, on Orgo's own X display :99, its tools as 2510:2510; janitor-ended at the exact deadline its name carries, and within 1 h whatever happens (Orgo deletes it at ends_in_hours 1, the backstop); network none is init's own namespace (--own-network), probed from inside at the outside and at every port root listens on, since Orgo has no egress control; the desktop's path sockets are root's alone but the display's; no mount.",
];

export interface OrgoModuleOptions {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** For tests: the REST calls, the terminal socket, or the whole channel. */
	fetch?: typeof fetch;
	webSocket?: OrgoWebSocketFactory;
	channel?: OrgoChannel;
	/** The daemon to upload; default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
}

function live(env: Record<string, string | undefined>): void {
	if (env[ORGO_ENV.live] !== "1") {
		throw new Error(`the Orgo conformance module makes real computers: set ${ORGO_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
}

/** The provider's settings from COMPUTER_ORGO_* alone: the key, the workspace, and Orgo's API when named. No word holds the key. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): { apiKey: string; workspaceId: string; apiUrl?: string } {
	const apiKey = env[ORGO_ENV.key];
	if (!apiKey) throw new Error(`set ${ORGO_ENV.key} to an Orgo API key: the Orgo module reads it there and nowhere else, never from ORGO_API_KEY`);
	const workspaceId = env[ORGO_ENV.workspace];
	if (!workspaceId) throw new Error(`set ${ORGO_ENV.workspace} to the Orgo workspace the run's computers live in`);
	const apiUrl = env[ORGO_ENV.apiUrl] || undefined;
	return { apiKey, workspaceId, ...(apiUrl ? { apiUrl } : {}) };
}

/** The image every computer of the run starts from: COMPUTER_ORGO_TEMPLATE, or Orgo's base desktop. */
export function conformanceImage({ env = process.env }: Pick<OrgoModuleOptions, "env"> = {}): string {
	return env[ORGO_ENV.template] || "linux";
}

function build({ env = process.env, fetch, webSocket, channel }: OrgoModuleOptions, daemonPath: string | undefined): OrgoProvider {
	return create({
		...settingsFromEnv(env),
		maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS,
		...(fetch ? { fetch } : {}),
		...(webSocket ? { webSocket } : {}),
		...(channel ? { channel } : {}),
		...(daemonPath === undefined ? {} : { daemonPath }),
	});
}

/** The provider the CLI runs; throws in words without the live switch, or when a setting is missing or wrong. */
export async function createProvider(options: OrgoModuleOptions = {}): Promise<OrgoProvider> {
	live(options.env ?? process.env);
	return build(options, options.daemonPath);
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider({ buildDaemon = (version) => buildDriftDaemon("amd64", version), ...options }: OrgoModuleOptions = {}): Promise<OrgoProvider> {
	live(options.env ?? process.env);
	return build(options, await buildDaemon(DRIFT_VERSION));
}
