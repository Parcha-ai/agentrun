// E2B for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider e2b [--image <template>]`.
// It makes real sandboxes, so it runs only with AGENTRUN_COMPUTER_LIVE_E2B=1 and a key the lead has OKed, under
// COMPUTER_E2B_API_KEY: the provider's fromEnv reads that name alone, never E2B_API_KEY, gives the SDK the key, domain
// and API URL explicitly, and refuses an ambient E2B_SANDBOX_URL (see fromEnv in ../e2b.ts). The live switch is checked
// first, before any other setting is read.
//
// The daemon is uploaded into each sandbox (dist/computerd-linux-amd64, `npm run build:daemon`), so a run publishes
// nothing. The drifted provider uploads a daemon built with Go as version <version>-drift. Every computer of a run lives
// at most 30 minutes, E2B Hobby's plan for conformance: E2B's timeout is the lifetime, and a longer one is refused.
//
// For the mount cases, mountFor("archil") makes a fresh run folder on the Archil disk COMPUTER_ARCHIL_DISK names (in
// COMPUTER_ARCHIL_REGION, mounted with the disk token COMPUTER_ARCHIL_TOKEN), and reaches it from outside through the
// disk's object API (the shared archilRunFolder, ./archil.ts: the host's disk SDK with COMPUTER_ARCHIL_API_KEY and
// COMPUTER_ARCHIL_S3_URL, or an object API given as archil.objects); with no disk named it makes none, and the cases
// are skipped. An Archil computer needs a provider whose daemon user is the tool user: COMPUTER_E2B_USER=2510:2510.
import { ENV, type E2BFromEnvOptions, type E2BProvider, fromEnv } from "../e2b.js";
import type { MountKind } from "../mount.js";
import { ARCHIL_ENV, type ArchilRunFolderOptions, archilRunFolder, archilSettings } from "./archil.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The environment this module reads, by name: the provider's, the live switch, the run's template and the Archil disk of the mount cases. */
export const E2B_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_E2B",
	/** The template every computer of the run starts from; default "desktop", E2B Desktop's. */
	template: "COMPUTER_E2B_TEMPLATE",
	...ENV,
	...ARCHIL_ENV,
} as const;

/** The Archil disk this module's mount cases mount, from the COMPUTER_ARCHIL_* names: see archilSettings. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): ReturnType<typeof archilSettings> {
	return archilSettings(env);
}

/** The longest lifetime a computer of a run may ask for: E2B kills each sandbox at its timeout, the lifetime. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"e2b: E2B Hobby plan: every sandbox's timeout is its lifetime, capped at 30 minutes for the run (Hobby caps a sandbox at 1 h, Pro at 24 h). The daemon is a child of E2B's envd, started as a background command; network none is no internet access and no public traffic, read back from E2B and probed from inside; no public stream, so screen.stream is skipped.",
];

export interface E2BModuleOptions extends Pick<E2BFromEnvOptions, "Sandbox" | "daemonPath" | "timeouts" | "onNote"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
	/** For mountFor("archil"): the disk's object API, or the SDK's Archil client, in place of the host's disk package. */
	archil?: Pick<ArchilRunFolderOptions, "objects" | "Archil" | "baseUrl">;
}

function live(env: Record<string, string | undefined>): void {
	if (env[E2B_ENV.live] !== "1") {
		throw new Error(`the E2B conformance module makes real sandboxes: set ${E2B_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
}

/** The template every computer of the run starts from: COMPUTER_E2B_TEMPLATE, or E2B Desktop's ("base" for kind linux). */
export function conformanceImage({ env = process.env }: Pick<E2BModuleOptions, "env"> = {}): string {
	return env[E2B_ENV.template] || (env[ENV.kind] === "linux" ? "base" : "desktop");
}

/** The provider the CLI runs; throws in words without the live switch, or when a setting is missing or wrong. */
export async function createProvider({ env = process.env, Sandbox, daemonPath, timeouts, onNote }: E2BModuleOptions = {}): Promise<E2BProvider> {
	live(env);
	return fromEnv(env, { ...(Sandbox ? { Sandbox } : {}), ...(daemonPath === undefined ? {} : { daemonPath }), ...(timeouts ? { timeouts } : {}), ...(onNote ? { onNote } : {}), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/**
 * A run folder for an Archil mount, and none for any other kind (an E2B computer takes no bind): a fresh folder on the
 * disk settingsFromEnv names, none when it names none (archilRunFolder, ./archil.ts). Reaching it is a call to Archil,
 * so it needs the live switch.
 */
export async function mountFor(kind: MountKind, { env = process.env, archil = {} }: E2BModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = settingsFromEnv(env);
	if (settings === undefined) return undefined;
	live(env);
	return archilRunFolder({ ...settings, ...archil });
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider({ env = process.env, Sandbox, timeouts, buildDaemon = (version) => buildDriftDaemon("amd64", version) }: E2BModuleOptions = {}): Promise<E2BProvider> {
	live(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return fromEnv(env, { ...(Sandbox ? { Sandbox } : {}), ...(timeouts ? { timeouts } : {}), daemonPath, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
