// boxd for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider boxd [--image <snapshot>]`.
// It makes real machines, so it runs only with AGENTRUN_COMPUTER_LIVE_BOXD=1 and a key the lead has OKed, under
// COMPUTER_BOXD_API_KEY. The provider reads no environment: this module reads its own COMPUTER_BOXD_* names (never
// BOXD_API_KEY, which may hold another account's key) and passes each to create() as its option. The live switch is
// checked first, before any other setting is read. The live sweep (sweep.ts, --provider boxd) reads the same names
// through createHost, which needs no live switch: it makes nothing; sweepScope names the key, org and region a before
// file must have been listed from.
//
// The daemon is uploaded into each machine (dist/computerd-linux-amd64, `npm run build:daemon`), so a run publishes
// nothing. The drifted provider uploads a daemon built with Go as version <version>-drift. Every computer of a run has
// a deadline of at most 30 minutes, and the runner sweeps the run's computers by its label when it ends.
import { createHash } from "node:crypto";
import { BOXD_DEFAULT_IMAGE } from "../descriptors/boxd.js";
import { type BoxdOptions, type BoxdProvider, create } from "../boxd.js";
import type { MachineHost } from "../host.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

/** The environment this module reads, by name, each for the option its comment names, the live switch and the run's image. */
export const BOXD_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_BOXD",
	/** The image every computer of the run starts from: "default" (boxd's own), or a snapshot's name. */
	image: "COMPUTER_BOXD_IMAGE",
	/** apiKey, required: the boxd API key. */
	key: "COMPUTER_BOXD_API_KEY",
	/** org: the org machines are made in; default the key's own. */
	org: "COMPUTER_BOXD_ORG",
	/** region: fra, nyc, ...; default the API's home region. */
	region: "COMPUTER_BOXD_REGION",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_BOXD_DAEMON",
	/** kind: linux (default) or desktop. */
	kind: "COMPUTER_BOXD_KIND",
	/** daemonUser: uid:gid the daemon runs as; default 2510:2510. */
	user: "COMPUTER_BOXD_USER",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = BOXD_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type BoxdSettings = Pick<BoxdOptions, "apiKey" | "org" | "region" | "daemonPath" | "kind" | "daemonUser">;

/**
 * The provider's options this module reads from env, each only when its name is set; throws in words without the key,
 * never echoing it. create() checks the rest.
 */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): BoxdSettings {
	const apiKey = env[BOXD_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${BOXD_ENV.key} to a boxd API key: the conformance module reads it there and nowhere else, never from BOXD_API_KEY`);
	const org = env[BOXD_ENV.org] || undefined;
	const region = env[BOXD_ENV.region] || undefined;
	const daemonPath = env[BOXD_ENV.daemon] || undefined;
	const kind = env[BOXD_ENV.kind] || undefined;
	const daemonUser = env[BOXD_ENV.user] || undefined;
	return {
		apiKey,
		...(org === undefined ? {} : { org }),
		...(region === undefined ? {} : { region }),
		...(daemonPath === undefined ? {} : { daemonPath }),
		// create() refuses any other kind in words.
		...(kind === undefined ? {} : { kind: kind as "desktop" | "linux" }),
		...(daemonUser === undefined ? {} : { daemonUser }),
	};
}

/** The longest lifetime a computer of a run may ask for. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"boxd: every computer is an isolated boxd machine with the egress allowlist none, no standby and no hibernation; the daemon is a child of boxd's own agent, started as a detached root command; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run; no stream() (a screen is streamed through agentrun), so screen.stream is skipped.",
];

export interface BoxdModuleOptions extends Pick<BoxdOptions, "Boxd" | "daemonPath" | "timeouts"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
}

function live(env: Record<string, string | undefined>): void {
	if (env[BOXD_ENV.live] !== "1") throw new Error(`the boxd conformance module makes real machines: set ${BOXD_ENV.live}=1, with a key the lead has OKed, to run it`);
}

/** The image every computer of the run starts from: COMPUTER_BOXD_IMAGE, or boxd's own. */
export function conformanceImage({ env = process.env }: Pick<BoxdModuleOptions, "env"> = {}): string {
	return env[BOXD_ENV.image] || BOXD_DEFAULT_IMAGE;
}

/** The provider the CLI runs; throws in words without the live switch, or when a setting is missing or wrong. */
export async function createProvider({ env = process.env, Boxd, daemonPath, timeouts }: BoxdModuleOptions = {}): Promise<BoxdProvider> {
	live(env);
	return create({ ...settingsFromEnv(env), ...(Boxd ? { Boxd } : {}), ...(daemonPath === undefined ? {} : { daemonPath }), ...(timeouts ? { timeouts } : {}), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/**
 * The boxd host the live sweep (sweep.ts) lists and deletes through, from the same settings; it needs no live switch,
 * since the sweep makes nothing, and it calls nothing until the sweep does.
 */
export async function createHost({ env = process.env, Boxd }: Pick<BoxdModuleOptions, "env" | "Boxd"> = {}): Promise<MachineHost> {
	return (await create({ ...settingsFromEnv(env), ...(Boxd ? { Boxd } : {}) })).host;
}

/**
 * Where the sweep lists, in words: the org and region the settings name, under the key named by its sha256 prefix alone.
 * A before file listed with another key, org or region would make every computer there read as new, so the sweep
 * refuses it.
 */
export function sweepScope({ env = process.env }: Pick<BoxdModuleOptions, "env"> = {}): string {
	const { apiKey, org, region } = settingsFromEnv(env);
	const key = createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 12);
	return `the boxd org ${org ?? "of the key"} in the region ${region ?? "home"}, with the key sha256:${key}`;
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider({ env = process.env, Boxd, timeouts, buildDaemon = (version) => buildDriftDaemon("amd64", version) }: BoxdModuleOptions = {}): Promise<BoxdProvider> {
	live(env);
	const settings = settingsFromEnv(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return create({ ...settings, ...(Boxd ? { Boxd } : {}), ...(timeouts ? { timeouts } : {}), daemonPath, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
