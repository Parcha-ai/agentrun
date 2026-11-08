// Daytona for the conformance CLI: `--provider daytona [--image <snapshot>]`. The provider's settings come from the
// environment by the provider's fromEnv names (COMPUTER_DAYTONA_*, never a bare DAYTONA_ variable), and the key is read
// only when createProvider() runs. Every sandbox of a run has a bounded life besides its TTL: Daytona stops one after 30
// minutes with no outside activity and deletes it as soon as it stops, so a stop deletes, and the provider declares it
// (stopDeletes; see conformanceNotes).
import { DAYTONA_DEFAULT_SNAPSHOT, DaytonaProvider, type DaytonaProviderOptions, ENV, optionsFromEnv } from "../daytona.js";
import type { MountKind } from "../mount.js";
import { archilFolder, archilSettingsFromEnv } from "./archil.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

/**
 * A fresh run folder for the mount cases: an Archil one when the disk's settings are given (the run's snapshot is then
 * one of box/Dockerfile, and COMPUTER_DAYTONA_USER is 2510:2510); none for a bind, which a remote computer cannot take.
 */
export async function mountFor(kind: MountKind, { env = process.env }: { env?: Record<string, string | undefined> } = {}): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = archilSettingsFromEnv(env);
	return settings === undefined ? undefined : archilFolder(settings);
}

/** The environment variables this module reads, by name: the provider's, and the run's snapshot. */
export const DAYTONA_ENV = {
	...ENV,
	/** The snapshot every computer of the run starts from; default "default", Daytona's default snapshot. */
	snapshot: "COMPUTER_DAYTONA_SNAPSHOT",
} as const;

/** Minutes without outside activity before Daytona stops a run's sandbox: at most 30, so none outlives a run for long. */
export const CONFORMANCE_AUTO_STOP_MINUTES = 30;
/** Minutes a run's sandbox may stay stopped: 0, Daytona deletes it as soon as it stops. */
export const CONFORMANCE_AUTO_DELETE_MINUTES = 0;

/**
 * For the run's report: what this configuration means for the suite. The provider declares it (stopDeletes), and the
 * note says it in words.
 */
export const conformanceNotes: string[] = [
	`daytona: every sandbox runs with autoStopMinutes ${CONFORMANCE_AUTO_STOP_MINUTES} and autoDeleteMinutes ${CONFORMANCE_AUTO_DELETE_MINUTES}, besides its TTL: Daytona deletes a sandbox as soon as it stops, so this configuration keeps no stopped computer, and the provider declares stopDeletes. Core provider.stop holds it to that: a stopped computer is gone, neither listed nor attachable. Full provider.janitor, which needs a stopped computer kept, is skipped (the lifetime being vendor).`,
];

export interface DaytonaModuleOptions {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	fetch?: DaytonaProviderOptions["fetch"];
	webSocket?: DaytonaProviderOptions["webSocket"];
	/** The provider's bounds; the sweep sets how long a release waits. */
	timeouts?: DaytonaProviderOptions["timeouts"];
}

/** The provider's options from the environment (optionsFromEnv), with the run's bounds. */
function optionsOf({ env = process.env, fetch, webSocket, timeouts }: DaytonaModuleOptions): DaytonaProviderOptions {
	return optionsFromEnv(env, {
		autoStopMinutes: CONFORMANCE_AUTO_STOP_MINUTES,
		autoDeleteMinutes: CONFORMANCE_AUTO_DELETE_MINUTES,
		...(fetch ? { fetch } : {}),
		...(webSocket ? { webSocket } : {}),
		...(timeouts ? { timeouts } : {}),
	});
}

/** The image every computer of the run starts from: COMPUTER_DAYTONA_SNAPSHOT, or Daytona's default snapshot. */
export function conformanceImage({ env = process.env }: Pick<DaytonaModuleOptions, "env"> = {}): string {
	return env[DAYTONA_ENV.snapshot] || DAYTONA_DEFAULT_SNAPSHOT;
}

/** The provider the CLI runs; throws in words when a setting is missing or wrong. */
export function createProvider(options: DaytonaModuleOptions = {}): DaytonaProvider {
	return new DaytonaProvider(optionsOf(options));
}

/** The same provider with a daemon that reports another version, built with Go for the drift case. */
export async function createDriftedProvider(options: DaytonaModuleOptions = {}): Promise<DaytonaProvider> {
	const settings = optionsOf(options);
	return new DaytonaProvider({ ...settings, daemonPath: await buildDriftDaemon(settings.arch ?? "amd64", DRIFT_VERSION) });
}
