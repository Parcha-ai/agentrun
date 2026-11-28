// Daytona for the conformance CLI: `--provider daytona [--image <snapshot>]`. It reads its settings from its own
// COMPUTER_DAYTONA_* names (never a bare DAYTONA_ variable, which may hold another organization's key on a host that
// runs other Daytona work). Every sandbox of a run has a bounded life besides its TTL: Daytona stops one after 30 minutes
// with no outside activity and deletes it as soon as it stops (see conformanceNotes).
import { boxRecipeHash } from "../box-image.js";
import { create, type DaytonaProvider, type DaytonaProviderOptions } from "../daytona.js";
import { DAYTONA, DAYTONA_DEFAULT_SNAPSHOT } from "../descriptors/daytona.js";
import type { MachineHost } from "../host.js";
import type { MountKind } from "../mount.js";
import { type ArchilMountOptions, archilRunFolder, archilSettings } from "./archil.js";
import { dialOnlyFromServer } from "./dial-only.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import { type Env, kindFrom, requiredSecret, setOptions } from "./module-kit.js";
import type { RunFolder } from "./types.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

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
	/** gpuSnapshot: the GPU snapshot of box/Dockerfile GPU computers are made from (box/build-daytona.py --gpu); default daytona-gpu. */
	gpuSnapshot: "COMPUTER_DAYTONA_GPU_SNAPSHOT",
	/**
	 * archilEgress: a self-hosted Daytona target's Archil egress relay, <IPv4 gateway>:<mount lane>:<data lane>. Set, the
	 * provider takes an Archil mount; unset, it refuses one (Archil's client hangs on Daytona's hosted cloud).
	 */
	archilEgress: "COMPUTER_DAYTONA_ARCHIL_EGRESS",
	/** attachEgress: a self-hosted Daytona target's attach relay, <IPv4 relay>:<port>, which its machines that dial go through. */
	attachEgress: "COMPUTER_DAYTONA_ATTACH_EGRESS",
	/** publicEgress: a self-hosted Daytona target's public egress, <IPv4>:<port>, which its computers' HTTPS tunnels go through. */
	publicEgress: "COMPUTER_DAYTONA_PUBLIC_EGRESS",
	/** connect: exec (default) or dial, which needs the public server's process (dialKit). */
	connect: "COMPUTER_DAYTONA_CONNECT",
	/** kind: linux (default) or desktop, which create() takes on dial alone. */
	kind: "COMPUTER_DAYTONA_KIND",
} as const;

export const ENV = DAYTONA_ENV;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing one. */
export function settingsFromEnv(env: Env = process.env): DaytonaProviderOptions {
	const apiKey = requiredSecret(env, DAYTONA_ENV.key, "a Daytona API key");
	const set = setOptions(env, {
		apiUrl: DAYTONA_ENV.url,
		target: DAYTONA_ENV.target,
		daemonPath: DAYTONA_ENV.daemon,
		arch: DAYTONA_ENV.arch,
		sandboxClass: DAYTONA_ENV.sandboxClass,
		daemonUser: DAYTONA_ENV.user,
		gpuSnapshot: DAYTONA_ENV.gpuSnapshot,
		archilEgress: DAYTONA_ENV.archilEgress,
		attachEgress: DAYTONA_ENV.attachEgress,
		publicEgress: DAYTONA_ENV.publicEgress,
		connect: DAYTONA_ENV.connect,
	});
	return { apiKey, ...(set as Pick<DaytonaProviderOptions, keyof typeof set>) };
}

/** Minutes without outside activity before Daytona stops a run's sandbox: at most 30, so none outlives a run for long. */
export const CONFORMANCE_AUTO_STOP_MINUTES = 30;
/** Minutes a run's sandbox may stay stopped: 0, Daytona deletes it as soon as it stops. */
export const CONFORMANCE_AUTO_DELETE_MINUTES = 0;

export const conformanceNotes: string[] = [
	`daytona: every sandbox runs with autoStopMinutes ${CONFORMANCE_AUTO_STOP_MINUTES} and autoDeleteMinutes ${CONFORMANCE_AUTO_DELETE_MINUTES}, besides its TTL: Daytona deletes a sandbox as soon as it stops, so this configuration keeps no stopped computer. A computer here is deleted, never stopped: release stop is refused. Full provider.janitor, which needs a stopped computer kept, is skipped (the lifetime being vendor). On dial (${DAYTONA_ENV.connect}=dial) no connection is a toolbox call, so nothing resets Daytona's idle timer: a computer stops, and is deleted, ${CONFORMANCE_AUTO_STOP_MINUTES} minutes after it starts, whatever runs on it.`,
];

export interface DaytonaModuleOptions {
	env?: Env;
	fetch?: DaytonaProviderOptions["fetch"];
	webSocket?: DaytonaProviderOptions["webSocket"];
	/** The provider's bounds; the sweep sets how long a release waits. */
	timeouts?: DaytonaProviderOptions["timeouts"];
	/** What the provider says that is no failure: the CLI gives it and puts it in the report. */
	onNote?: DaytonaProviderOptions["onNote"];
	/** The public server a dial machine dials (COMPUTER_DAYTONA_CONNECT=dial): its process alone gives it (dialKit). */
	dial?: DaytonaProviderOptions["dial"];
	/** The daemon binary, over COMPUTER_DAYTONA_DAEMON: dial-conformance.mjs gives drift.version's daemon here. */
	daemonPath?: DaytonaProviderOptions["daemonPath"];
}

/** The provider's options: what this module reads from the environment (settingsFromEnv), with the run's bounds. */
function optionsOf({ env = process.env, fetch, webSocket, timeouts, onNote, dial, daemonPath }: DaytonaModuleOptions): DaytonaProviderOptions {
	return {
		...settingsFromEnv(env),
		...kindFrom(env, DAYTONA_ENV.kind),
		...(daemonPath === undefined ? {} : { daemonPath }),
		autoStopMinutes: CONFORMANCE_AUTO_STOP_MINUTES,
		autoDeleteMinutes: CONFORMANCE_AUTO_DELETE_MINUTES,
		...(fetch ? { fetch } : {}),
		...(webSocket ? { webSocket } : {}),
		...(timeouts ? { timeouts } : {}),
		...(onNote ? { onNote } : {}),
		...(dial ? { dial } : {}),
	};
}

/**
 * The image every computer of the run starts from: COMPUTER_DAYTONA_SNAPSHOT; else on dial the box image's snapshot,
 * agentrun-box-<recipe hash> (box/build-daytona.py), since only it holds agentrun-dial and runs it; else Daytona's default
 * snapshot.
 */
export function conformanceImage({ env = process.env }: Pick<DaytonaModuleOptions, "env"> = {}): string {
	return env[DAYTONA_ENV.snapshot] || (env[DAYTONA_ENV.connect] === "dial" ? `agentrun-box-${boxRecipeHash()}` : DAYTONA_DEFAULT_SNAPSHOT);
}

export const dialKit = dialOnlyFromServer(DAYTONA, `${DAYTONA_ENV.connect}=dial`);

/**
 * A fresh run folder for the mount cases: an Archil one on the disk the COMPUTER_ARCHIL_* settings name (the shared
 * archilRunFolder; the run's snapshot is then one of box/Dockerfile, and COMPUTER_DAYTONA_USER is 2510:2510), only where
 * COMPUTER_DAYTONA_ARCHIL_EGRESS names the target's relay, since the provider takes an Archil mount only then; none
 * otherwise, and none for a bind, which a remote computer cannot take.
 */
export async function mountFor(
	kind: MountKind,
	{ env = process.env, archil = {} }: ArchilMountOptions = {},
): Promise<RunFolder | undefined> {
	if (kind !== "archil" || !env[DAYTONA_ENV.archilEgress]) return undefined;
	const settings = archilSettings(env);
	return settings === undefined ? undefined : archilRunFolder({ ...settings, ...archil });
}

/** The provider the CLI runs; throws in words when a setting is missing or wrong. */
export function createProvider(options: DaytonaModuleOptions = {}): DaytonaProvider {
	return create(optionsOf(options));
}

export async function createHost({ env = process.env, fetch }: Pick<DaytonaModuleOptions, "env" | "fetch"> = {}): Promise<MachineHost> {
	return create({ ...settingsFromEnv(env), ...(fetch ? { fetch } : {}) }).host;
}

/** The same provider with a daemon that reports another version, built with Go for the drift case. */
export async function createDriftedProvider(options: DaytonaModuleOptions = {}): Promise<DaytonaProvider> {
	const settings = optionsOf(options);
	// Every setting is checked before Go builds anything.
	create(settings);
	return create({ ...settings, daemonPath: await buildDriftDaemon(settings.arch ?? "amd64", DRIFT_VERSION) });
}
