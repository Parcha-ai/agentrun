// Agent37 for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider agent37`.
// It makes real instances, which bill per minute until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_AGENT37=1
// and a key the lead has OKed, under COMPUTER_AGENT37_API_KEY, beside COMPUTER_AGENT37_SSH_KEY, the private half (its
// contents) of an SSH key registered on the same workspace. The provider reads no environment: this module reads its
// own COMPUTER_AGENT37_* names (never AGENT37_API_KEY, which may hold another team's key) and passes each to create()
// as its option. The live switch is checked first, before any other setting is read. The live sweep (sweep.ts,
// --provider agent37) reads the same names through createHost, which needs no live switch: it makes nothing.
//
// The daemon is uploaded into each instance over SSH (dist/computerd-linux-amd64, `npm run build:daemon`), so a run
// publishes nothing. The drifted provider uploads a daemon built with Go as version <version>-drift. Agent37 never
// ends an instance on its own: every computer of a run lives at most 30 minutes, by init's deadline and the janitor's
// label, and the run's sweep deletes what is left.
//
// COMPUTER_AGENT37_KIND=desktop runs the desktop's cases (screen, input) on agentrun-box, the box template
// box/build-agent37.mjs publishes in the key's workspace: build it there first, or name another with an X server in
// COMPUTER_AGENT37_TEMPLATE.
//
// For the mount cases, mountFor("archil") makes a fresh run folder on the Archil disk COMPUTER_ARCHIL_DISK names, as
// the E2B module does (./archil.ts); with no disk named it makes none, and the cases are skipped. An Archil computer
// needs a provider whose daemon user is the tool user: COMPUTER_AGENT37_USER=2510:2510, the default.
import { type Agent37Options, type Agent37Provider, type Agent37Region, type Agent37Type, create, workspaceOf } from "../agent37.js";
import { AGENT37_BASE_TEMPLATE, AGENT37_BOX_TEMPLATE } from "../descriptors/agent37.js";
import type { MachineHost } from "../host.js";
import type { MountKind } from "../mount.js";
import { type ArchilRunFolderOptions, archilRunFolder, archilSettings } from "./archil.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

/** The environment this module reads, by name, each for the option its comment names, the live switch and the run's template. */
export const AGENT37_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_AGENT37",
	/** The template every computer of the run starts from; default agent37-base, or agentrun-box for kind desktop. */
	template: "COMPUTER_AGENT37_TEMPLATE",
	/** kind: linux (default) or desktop. */
	kind: "COMPUTER_AGENT37_KIND",
	/** apiKey, required: the workspace's API key. */
	key: "COMPUTER_AGENT37_API_KEY",
	/** sshKey, required: the private SSH key registered on the workspace, its contents. */
	sshKey: "COMPUTER_AGENT37_SSH_KEY",
	/** type: vm (default) or default. */
	type: "COMPUTER_AGENT37_TYPE",
	/** region: us (default), eu or ap-south. */
	region: "COMPUTER_AGENT37_REGION",
	/** apiUrl: Agent37's REST API; default https://api.agent37.com. */
	apiUrl: "COMPUTER_AGENT37_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_AGENT37_DAEMON",
	/** maxLifetimeMs: the cap, in ms, at most 86400000; a run takes it when it is under 30 minutes, else 30 minutes. */
	maxLifetimeMs: "COMPUTER_AGENT37_MAX_LIFETIME_MS",
	/** daemonUser: uid:gid the daemon runs as; default 2510:2510. */
	user: "COMPUTER_AGENT37_USER",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = AGENT37_ENV;

/** What this module reads from the environment: the keys, and each other option whose name is set. */
export type Agent37Settings = Omit<Agent37Options, "ssh2" | "fetch" | "WebSocket" | "timeouts" | "probeTargets" | "proxyDomain">;

/**
 * The provider's options this module reads from env, each only when its name is set; throws in words without a key,
 * or on a value it cannot read, never echoing a key. create() checks the rest.
 */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): Agent37Settings {
	const apiKey = env[AGENT37_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${AGENT37_ENV.key} to an Agent37 API key: the conformance module reads it there and nowhere else, never from AGENT37_API_KEY`);
	const sshKey = env[AGENT37_ENV.sshKey];
	if (sshKey === undefined || sshKey === "") throw new Error(`set ${AGENT37_ENV.sshKey} to the private SSH key registered on the Agent37 workspace (its contents, never a path)`);
	const lifetime = env[AGENT37_ENV.maxLifetimeMs] || undefined;
	if (lifetime !== undefined && !/^\d+$/.test(lifetime)) throw new Error(`${AGENT37_ENV.maxLifetimeMs} is a whole number of milliseconds, such as 86400000`);
	const type = env[AGENT37_ENV.type] || undefined;
	const region = env[AGENT37_ENV.region] || undefined;
	const apiUrl = env[AGENT37_ENV.apiUrl] || undefined;
	const daemonPath = env[AGENT37_ENV.daemon] || undefined;
	const daemonUser = env[AGENT37_ENV.user] || undefined;
	const kind = env[AGENT37_ENV.kind] || undefined;
	return {
		apiKey,
		sshKey,
		// create() refuses any other type or region in words.
		...(type === undefined ? {} : { type: type as Agent37Type }),
		...(region === undefined ? {} : { region: region as Agent37Region }),
		...(kind === undefined ? {} : { kind: kind as "desktop" | "linux" }),
		...(apiUrl === undefined ? {} : { apiUrl }),
		...(daemonPath === undefined ? {} : { daemonPath }),
		...(lifetime === undefined ? {} : { maxLifetimeMs: Number(lifetime) }),
		...(daemonUser === undefined ? {} : { daemonUser }),
	};
}

/** The longest lifetime a computer of a run may ask for: init ends it at its deadline, the sweep deletes it. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"agent37: every computer is an instance (type vm by default), made with network deny-all, auto-sleep off and no public port, read back from Agent37 and probed from inside; the daemon is a child, started over SSH through the platform's sshd (port 22022; it and the platform's web terminal on 7681 are declared as the vendor's agent), and every command goes over that SSH as root. Agent37 never ends an instance on its own: lifetime janitor, capped at 30 minutes for the run. No stream() (a screen is streamed through agentrun), so screen.stream is skipped. Kind desktop (COMPUTER_AGENT37_KIND=desktop) starts from agentrun-box, our box image as a template of the key's workspace (box/build-agent37.mjs), with Xvfb on :0 started through the daemon as the tool user.",
];

export interface Agent37ModuleOptions extends Pick<Agent37Options, "ssh2" | "fetch" | "WebSocket" | "daemonPath" | "timeouts" | "onNote"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
	/** For mountFor("archil"): the disk's object API, or the SDK's Archil client, in place of the host's disk package. */
	archil?: Pick<ArchilRunFolderOptions, "objects" | "Archil" | "baseUrl">;
}

function live(env: Record<string, string | undefined>): void {
	if (env[AGENT37_ENV.live] !== "1") {
		throw new Error(`the Agent37 conformance module makes real instances, which bill until deleted: set ${AGENT37_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
}

/** The template every computer of the run starts from: COMPUTER_AGENT37_TEMPLATE, or agentrun-box for kind desktop, else agent37-base. */
export function conformanceImage({ env = process.env }: Pick<Agent37ModuleOptions, "env"> = {}): string {
	return env[AGENT37_ENV.template] || (env[AGENT37_ENV.kind] === "desktop" ? AGENT37_BOX_TEMPLATE : AGENT37_BASE_TEMPLATE);
}

/** The test doubles a caller hands in, each only when given. */
const doubles = ({ ssh2, fetch, WebSocket, timeouts, onNote }: Agent37ModuleOptions) => ({
	...(ssh2 ? { ssh2 } : {}),
	...(fetch ? { fetch } : {}),
	...(WebSocket ? { WebSocket } : {}),
	...(timeouts ? { timeouts } : {}),
	...(onNote ? { onNote } : {}),
});

/** A run's cap: COMPUTER_AGENT37_MAX_LIFETIME_MS when it is shorter, else CONFORMANCE_MAX_LIFETIME_MS. */
const runCap = (settings: Agent37Settings) => Math.min(settings.maxLifetimeMs ?? CONFORMANCE_MAX_LIFETIME_MS, CONFORMANCE_MAX_LIFETIME_MS);

/** The provider the CLI runs; throws in words without the live switch, or when a setting is missing or wrong. */
export async function createProvider(options: Agent37ModuleOptions = {}): Promise<Agent37Provider> {
	const { env = process.env, daemonPath } = options;
	live(env);
	const settings = settingsFromEnv(env);
	return create({ ...settings, ...doubles(options), ...(daemonPath === undefined ? {} : { daemonPath }), maxLifetimeMs: runCap(settings) });
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider(options: Agent37ModuleOptions = {}): Promise<Agent37Provider> {
	const { env = process.env, buildDaemon = (version) => buildDriftDaemon("amd64", version) } = options;
	live(env);
	const settings = settingsFromEnv(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return create({ ...settings, ...doubles(options), daemonPath, maxLifetimeMs: runCap(settings) });
}

/**
 * A run folder for an Archil mount, and none for any other kind (an Agent37 computer takes no bind): a fresh folder on
 * the disk the COMPUTER_ARCHIL_* names name (archilSettings), none when they name none. Reaching it is a call to
 * Archil, so it needs the live switch.
 */
export async function mountFor(kind: MountKind, { env = process.env, archil = {} }: Agent37ModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = archilSettings(env);
	if (settings === undefined) return undefined;
	live(env);
	return archilRunFolder({ ...settings, ...archil });
}

/**
 * The Agent37 host the live sweep (sweep.ts) lists and deletes through, from the same settings; it needs no live
 * switch, since the sweep makes nothing, and it calls nothing until the sweep does.
 */
export async function createHost(options: Pick<Agent37ModuleOptions, "env" | "ssh2" | "fetch" | "WebSocket"> = {}): Promise<MachineHost> {
	return (await create({ ...settingsFromEnv(options.env ?? process.env), ...doubles(options) })).host;
}

/**
 * Where the host lists, in words: one key is one workspace, and one listing covers all of it, every region and type
 * (docs: instances/list). The key is named by its sha256 prefix alone, so a before file of another key is refused.
 */
export function sweepScope({ env = process.env }: Pick<Agent37ModuleOptions, "env"> = {}): string {
	const { apiKey, apiUrl } = settingsFromEnv(env);
	return workspaceOf(apiKey, apiUrl);
}
