// E2B for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider e2b [--image <template>]`.
// It makes real sandboxes, so it runs only with AGENTRUN_COMPUTER_LIVE_E2B=1 and a key the lead has OKed, under
// COMPUTER_E2B_API_KEY. The provider reads no environment: this module reads its own COMPUTER_E2B_* names (never
// E2B_API_KEY, which may hold another team's key) and passes each to create() as its option; the provider gives the SDK
// the key, domain and API URL explicitly, and refuses an ambient E2B_SANDBOX_URL (see create in ../e2b.ts). The live
// switch is checked first, before any other setting is read. The sweep and the network diagnostic (e2b-sweep.ts,
// e2b-diagnose.ts) read the same names through settingsFromEnv.
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
import { E2B_BASE_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "../descriptors/e2b.js";
import { create, type E2BOptions, type E2BProvider } from "../e2b.js";
import type { MountKind } from "../mount.js";
import { type ArchilRunFolderOptions, archilRunFolder, archilSettings } from "./archil.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

/** The environment this module reads, by name, each for the option its comment names, the live switch and the run's template. */
export const E2B_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_E2B",
	/** The template every computer of the run starts from; default "desktop", E2B Desktop's. */
	template: "COMPUTER_E2B_TEMPLATE",
	/** apiKey, required: the E2B API key. */
	key: "COMPUTER_E2B_API_KEY",
	/** domain: E2B's domain; default e2b.app. */
	domain: "COMPUTER_E2B_DOMAIN",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_E2B_DAEMON",
	/** kind: desktop (default) or linux. */
	kind: "COMPUTER_E2B_KIND",
	/** maxLifetimeMs: the cap, in ms, 3600000 (Hobby, default) up to 86400000 (Pro); a run caps it at 30 minutes. */
	maxLifetimeMs: "COMPUTER_E2B_MAX_LIFETIME_MS",
	/** daemonUser: uid:gid the daemon runs as; default 2510:2510. */
	user: "COMPUTER_E2B_USER",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = E2B_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type E2BSettings = Omit<E2BOptions, "Sandbox" | "desktop" | "timeouts" | "probeTargets">;

/**
 * The provider's options this module reads from env, each only when its name is set; throws in words without the key,
 * on a value it cannot read, or while E2B_SANDBOX_URL is set there (the SDK would send every sandbox call to it), never
 * echoing a key. create() checks the rest.
 */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): E2BSettings {
	const apiKey = env[E2B_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${E2B_ENV.key} to an E2B API key: the conformance module reads it there and nowhere else, never from E2B_API_KEY`);
	if (env.E2B_SANDBOX_URL) throw new Error("the E2B provider refuses to start while E2B_SANDBOX_URL is set: the SDK would send every call into a sandbox there. Unset it");
	const lifetime = env[E2B_ENV.maxLifetimeMs] || undefined;
	if (lifetime !== undefined && !/^\d+$/.test(lifetime)) throw new Error(`${E2B_ENV.maxLifetimeMs} is a whole number of milliseconds, such as 3600000 (Hobby) or 86400000 (Pro)`);
	const domain = env[E2B_ENV.domain] || undefined;
	const daemonPath = env[E2B_ENV.daemon] || undefined;
	const kind = env[E2B_ENV.kind] || undefined;
	const daemonUser = env[E2B_ENV.user] || undefined;
	return {
		apiKey,
		...(domain === undefined ? {} : { domain }),
		...(daemonPath === undefined ? {} : { daemonPath }),
		// create() refuses any other kind in words.
		...(kind === undefined ? {} : { kind: kind as "desktop" | "linux" }),
		...(lifetime === undefined ? {} : { maxLifetimeMs: Number(lifetime) }),
		...(daemonUser === undefined ? {} : { daemonUser }),
	};
}

/** The longest lifetime a computer of a run may ask for: E2B kills each sandbox at its timeout, the lifetime. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"e2b: E2B Hobby plan: every sandbox's timeout is its lifetime, capped at 30 minutes for the run (Hobby caps a sandbox at 1 h, Pro at 24 h). The daemon is a child of E2B's envd, started as a background command; network none is no internet access and no public traffic, read back from E2B and probed from inside; no stream() (a screen is streamed through agentrun, never a vendor URL), so screen.stream is skipped.",
];

export interface E2BModuleOptions extends Pick<E2BOptions, "Sandbox" | "daemonPath" | "timeouts" | "onNote"> {
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

/** The template every computer of the run starts from: COMPUTER_E2B_TEMPLATE, or E2B Desktop's (the plain one for kind linux). */
export function conformanceImage({ env = process.env }: Pick<E2BModuleOptions, "env"> = {}): string {
	return env[E2B_ENV.template] || (env[E2B_ENV.kind] === "linux" ? E2B_BASE_TEMPLATE : E2B_DESKTOP_TEMPLATE);
}

/** The provider the CLI runs; throws in words without the live switch, or when a setting is missing or wrong. */
export async function createProvider({ env = process.env, Sandbox, daemonPath, timeouts, onNote }: E2BModuleOptions = {}): Promise<E2BProvider> {
	live(env);
	return create({ ...settingsFromEnv(env), ...(Sandbox ? { Sandbox } : {}), ...(daemonPath === undefined ? {} : { daemonPath }), ...(timeouts ? { timeouts } : {}), ...(onNote ? { onNote } : {}), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/**
 * A run folder for an Archil mount, and none for any other kind (an E2B computer takes no bind): a fresh folder on the
 * disk the COMPUTER_ARCHIL_* names name (archilSettings), none when they name none (archilRunFolder, ./archil.ts).
 * Reaching it is a call to Archil, so it needs the live switch.
 */
export async function mountFor(kind: MountKind, { env = process.env, archil = {} }: E2BModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = archilSettings(env);
	if (settings === undefined) return undefined;
	live(env);
	return archilRunFolder({ ...settings, ...archil });
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider({ env = process.env, Sandbox, timeouts, buildDaemon = (version) => buildDriftDaemon("amd64", version) }: E2BModuleOptions = {}): Promise<E2BProvider> {
	live(env);
	const settings = settingsFromEnv(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return create({ ...settings, ...(Sandbox ? { Sandbox } : {}), ...(timeouts ? { timeouts } : {}), daemonPath, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
