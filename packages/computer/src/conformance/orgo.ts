// Orgo for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider orgo [--image <template>]`.
// It makes real Orgo desktops, so it runs only with AGENTRUN_COMPUTER_LIVE_ORGO=1 and a key the lead has OKed, under
// COMPUTER_ORGO_API_KEY (never ORGO_API_KEY), in the workspace COMPUTER_ORGO_WORKSPACE names. The live switch is checked
// first, before any other setting is read.
//
// COMPUTER_ORGO_OS picks the desktop: linux (the default), windows or macos. On Linux the daemon is uploaded into each
// computer (dist/computerd-linux-amd64, `npm run build:daemon`); the drifted provider uploads one built with Go as
// version <version>-drift. On Windows and macOS no daemon runs: the provider answers over Orgo's API (daemon none), the
// run's image is "windows" or "macos", and `--kind desktop` runs the desktop's cases, with the Windows fixture this
// package carries. Every computer of a run lives at most 1 h (on Linux and Windows Orgo's shortest end, ends_in_hours
// 1, deletes it then whatever happens to the run; macOS has no Orgo end, so the janitor alone ends it).
import { ORGO_BASE_IMAGE, ORGO_MACOS_IMAGE, ORGO_WINDOWS_IMAGE } from "../descriptors/orgo.js";
import { create, type OrgoChannel, type OrgoProvider, type OrgoWebSocketFactory } from "../orgo.js";
import type { OrgoDesktopProvider } from "../orgo-desktop.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

/** The environment this module reads, by name: the live switch, the run's template, and the provider's settings. */
export const ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_ORGO",
	/** The template every computer of the run starts from; default Orgo's base desktop ("linux"). Linux only. */
	template: "COMPUTER_ORGO_TEMPLATE",
	/** Required: an Orgo API key (never ORGO_API_KEY, which a host may hold for another account). */
	key: "COMPUTER_ORGO_API_KEY",
	/** Required: the workspace the run's computers live in. */
	workspace: "COMPUTER_ORGO_WORKSPACE",
	/** Orgo's API; default https://www.orgo.ai/api. */
	apiUrl: "COMPUTER_ORGO_API_URL",
	/** The desktop: linux (default), windows or macos. */
	os: "COMPUTER_ORGO_OS",
} as const;
const ORGO_ENV = ENV;

/** The longest lifetime a computer of a run may ask for: Orgo's shortest end, 1 h. */
export const CONFORMANCE_MAX_LIFETIME_MS = 60 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"orgo: a Linux desktop on Orgo with computerd inside, on Orgo's own X display :99, its tools as 2510:2510; janitor-ended at the exact deadline its name carries, and within 1 h whatever happens (Orgo deletes it at ends_in_hours 1, the backstop); network none is init's own namespace (--own-network), probed from inside at the outside and at every port root listens on, since Orgo has no egress control; the desktop's path sockets are root's alone but the display's; no mount.",
	"orgo windows and macos (COMPUTER_ORGO_OS): daemon none, the provider answering over Orgo's REST API: the screen from its screenshot, the pointer and keys from its click, drag, scroll, type and key calls, exec from its bash call (PowerShell on Windows), files through PowerShell on Windows; network open, since Orgo has no egress control and no daemon runs inside to hold one; the cases written for Linux (sh, /proc) are skipped in words.",
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

type Os = "linux" | "windows" | "macos";

/** The desktop COMPUTER_ORGO_OS names, linux when it names none; a throw in words for any other. */
function osOf(env: Record<string, string | undefined>): Os {
	const os = env[ORGO_ENV.os] || "linux";
	if (os !== "linux" && os !== "windows" && os !== "macos") throw new Error(`${ORGO_ENV.os} is linux, windows or macos, not ${JSON.stringify(os)}`);
	return os;
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

/** The image every computer of the run starts from: "windows" or "macos" for those desktops; else COMPUTER_ORGO_TEMPLATE, or Orgo's base desktop. */
export function conformanceImage({ env = process.env }: Pick<OrgoModuleOptions, "env"> = {}): string {
	const os = osOf(env);
	if (os === "windows") return ORGO_WINDOWS_IMAGE;
	if (os === "macos") return ORGO_MACOS_IMAGE;
	return env[ORGO_ENV.template] || ORGO_BASE_IMAGE;
}

function build({ env = process.env, fetch, webSocket, channel }: OrgoModuleOptions, daemonPath: string | undefined): OrgoProvider | OrgoDesktopProvider {
	const os = osOf(env);
	if (os !== "linux") return create({ os, ...settingsFromEnv(env), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS, ...(fetch ? { fetch } : {}) });
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
export async function createProvider(options: OrgoModuleOptions = {}): Promise<OrgoProvider | OrgoDesktopProvider> {
	live(options.env ?? process.env);
	return build(options, options.daemonPath);
}

/**
 * The same provider uploading a daemon that reports version <version>-drift, for the drift.version case; on Windows and
 * macOS, where no daemon runs, the provider whose computer's hello reports that version.
 */
export async function createDriftedProvider({ buildDaemon = (version) => buildDriftDaemon("amd64", version), ...options }: OrgoModuleOptions = {}): Promise<OrgoProvider | OrgoDesktopProvider> {
	const env = options.env ?? process.env;
	live(env);
	const os = osOf(env);
	if (os !== "linux") return create({ os, ...settingsFromEnv(env), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS, daemonVersion: DRIFT_VERSION, ...(options.fetch ? { fetch: options.fetch } : {}) });
	return build(options, await buildDaemon(DRIFT_VERSION));
}
