// Daytona for the conformance CLI: `--provider daytona [--image <snapshot>]`. The provider reads no environment: this
// module reads the run's settings from its own COMPUTER_DAYTONA_* names (never a bare DAYTONA_ variable, which may hold
// another organization's key on a host that runs other Daytona work) and passes each to create() as its option, the key
// read only when createProvider() runs. Every sandbox of a run has a bounded life besides its TTL: Daytona stops one
// after 30 minutes with no outside activity and deletes it as soon as it stops, so a stop deletes, and the provider
// declares it (stopDeletes; see conformanceNotes).
import { create, type DaytonaCreateOptions, type DaytonaProvider, type DaytonaProviderOptions } from "../daytona.js";
import { DAYTONA_DEFAULT_SNAPSHOT } from "../descriptors/daytona.js";
import type { MountKind } from "../mount.js";
import { type ArchilRunFolderOptions, archilRunFolder, archilSettings } from "./archil.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

/**
 * A fresh run folder for the mount cases: an Archil one on the disk the COMPUTER_ARCHIL_* settings name (the shared
 * archilRunFolder; the run's snapshot is then one of box/Dockerfile, and COMPUTER_DAYTONA_USER is 2510:2510); none when
 * they name none, and none for a bind, which a remote computer cannot take.
 */
export async function mountFor(
	kind: MountKind,
	{ env = process.env, archil = {} }: { env?: Record<string, string | undefined>; archil?: Pick<ArchilRunFolderOptions, "objects" | "Archil" | "baseUrl"> } = {},
): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = archilSettings(env);
	return settings === undefined ? undefined : archilRunFolder({ ...settings, ...archil });
}

/** The environment this module reads, by name, each for the option its comment names. */
export const DAYTONA_ENV = {
	/** apiKey, required: the Daytona API key. */
	key: "COMPUTER_DAYTONA_API_KEY",
	/** apiUrl; default https://app.daytona.io/api. */
	url: "COMPUTER_DAYTONA_API_URL",
	/** daemonPath; default this package's dist/computerd-linux-<arch>. */
	daemon: "COMPUTER_DAYTONA_DAEMON",
	/** arch: amd64 (default) or arm64, the sandboxes' architecture. */
	arch: "COMPUTER_DAYTONA_ARCH",
	/** target: the Daytona target (region); default the organization's. */
	target: "COMPUTER_DAYTONA_TARGET",
	/** sandboxClass: container (default) or linux-vm, the class the snapshot makes. */
	sandboxClass: "COMPUTER_DAYTONA_CLASS",
	/** daemonUser: uid:gid the daemon runs as; default 2510:2510. */
	user: "COMPUTER_DAYTONA_USER",
	/** The snapshot every computer of the run starts from; default "default", Daytona's default snapshot. */
	snapshot: "COMPUTER_DAYTONA_SNAPSHOT",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = DAYTONA_ENV;

/**
 * The provider's options this module reads from env, each only when its name is set; throws in words without the key,
 * never echoing one. create() checks the rest.
 */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): DaytonaCreateOptions {
	const apiKey = env[DAYTONA_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${DAYTONA_ENV.key} to a Daytona API key: the conformance module reads it there and nowhere else, never from DAYTONA_API_KEY`);
	const named = (name: string) => (env[name] ? { value: env[name] as string } : undefined);
	const url = named(DAYTONA_ENV.url);
	const target = named(DAYTONA_ENV.target);
	const daemon = named(DAYTONA_ENV.daemon);
	const arch = named(DAYTONA_ENV.arch);
	const sandboxClass = named(DAYTONA_ENV.sandboxClass);
	const user = named(DAYTONA_ENV.user);
	return {
		apiKey,
		...(url ? { apiUrl: url.value } : {}),
		...(target ? { target: target.value } : {}),
		...(daemon ? { daemonPath: daemon.value } : {}),
		...(arch ? { arch: arch.value } : {}),
		// create() refuses any other class in words.
		...(sandboxClass ? { sandboxClass: sandboxClass.value as "container" | "linux-vm" } : {}),
		...(user ? { daemonUser: user.value } : {}),
	};
}

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
	/** What the provider says that is no failure: the CLI gives it and puts it in the report. */
	onNote?: DaytonaProviderOptions["onNote"];
}

/** The provider's options: what this module reads from the environment (settingsFromEnv), with the run's bounds. */
function optionsOf({ env = process.env, fetch, webSocket, timeouts, onNote }: DaytonaModuleOptions): DaytonaCreateOptions {
	return {
		...settingsFromEnv(env),
		autoStopMinutes: CONFORMANCE_AUTO_STOP_MINUTES,
		autoDeleteMinutes: CONFORMANCE_AUTO_DELETE_MINUTES,
		...(fetch ? { fetch } : {}),
		...(webSocket ? { webSocket } : {}),
		...(timeouts ? { timeouts } : {}),
		...(onNote ? { onNote } : {}),
	};
}

/** The image every computer of the run starts from: COMPUTER_DAYTONA_SNAPSHOT, or Daytona's default snapshot. */
export function conformanceImage({ env = process.env }: Pick<DaytonaModuleOptions, "env"> = {}): string {
	return env[DAYTONA_ENV.snapshot] || DAYTONA_DEFAULT_SNAPSHOT;
}

/** The provider the CLI runs; throws in words when a setting is missing or wrong. */
export function createProvider(options: DaytonaModuleOptions = {}): DaytonaProvider {
	return create(optionsOf(options));
}

/** The same provider with a daemon that reports another version, built with Go for the drift case. */
export async function createDriftedProvider(options: DaytonaModuleOptions = {}): Promise<DaytonaProvider> {
	const settings = optionsOf(options);
	// Every setting is checked before Go builds anything.
	create(settings);
	return create({ ...settings, daemonPath: await buildDriftDaemon(settings.arch ?? "amd64", DRIFT_VERSION) });
}
