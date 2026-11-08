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
// disk's object API, given as archilDisk; with no disk named it makes none, and the cases are skipped. An Archil computer
// needs a provider whose daemon user is the tool user: COMPUTER_E2B_USER=2510:2510.
import { randomBytes } from "node:crypto";
import { ENV, type E2BFromEnvOptions, type E2BProvider, fromEnv } from "../e2b.js";
import type { MountKind } from "../mount.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The Archil disk mountFor("archil") makes run folders on, by name: the disk, its region and a disk token for the mount. */
const ARCHIL_ENV = { archilDisk: "COMPUTER_ARCHIL_DISK", archilRegion: "COMPUTER_ARCHIL_REGION", archilToken: "COMPUTER_ARCHIL_TOKEN" } as const;

/** The environment this module reads, by name: the provider's, the live switch, the run's template and the Archil disk of the mount cases. */
export const E2B_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_E2B",
	/** The template every computer of the run starts from; default "desktop", E2B Desktop's. */
	template: "COMPUTER_E2B_TEMPLATE",
	...ENV,
	...ARCHIL_ENV,
} as const;

/** The part of an Archil disk's object API mountFor("archil") reaches a run folder through from outside: keys relative to the disk's root. */
export interface ArchilObjects {
	getObject(key: string): Promise<Uint8Array>;
	putObject(key: string, body: Uint8Array): Promise<unknown>;
	deleteObject(key: string): Promise<void>;
}

/**
 * The Archil disk this module's mount cases mount, from COMPUTER_ARCHIL_DISK, _REGION and _TOKEN; undefined when none
 * of them is set. Some set and some not is a mistake, said in words that name what is missing and hold no value.
 */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): { disk: string; region: string; token: string } | undefined {
	const [disk, region, token] = [env[ARCHIL_ENV.archilDisk], env[ARCHIL_ENV.archilRegion], env[ARCHIL_ENV.archilToken]];
	if (!disk && !region && !token) return undefined;
	if (!disk || !region || !token) {
		const missing = Object.values(ARCHIL_ENV).filter((name) => !env[name]);
		throw new Error(`the Archil mount cases need ${Object.values(ARCHIL_ENV).join(", ")} together: ${missing.join(", ")} is not set`);
	}
	return { disk, region, token };
}

/**
 * A fresh run folder, agents/conformance/runs/<r>/work on the disk, reached from outside through its object API. A file
 * not there reads undefined (the SDK's 404); any other failure is thrown. close removes every file the case wrote or read
 * there, which covers the ones the computer wrote; the folder's other keys are the disk's to keep.
 */
function archilRunFolder({ disk, region, token }: { disk: string; region: string; token: string }, objects: ArchilObjects): RunFolder {
	const folder = `agents/conformance/runs/c${randomBytes(6).toString("hex")}/work`;
	const touched = new Set<string>();
	const key = (path: string) => {
		if (path === "" || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`a run folder's file is a path inside it, not ${JSON.stringify(path)}`);
		const at = `${folder}/${path}`;
		touched.add(at);
		return at;
	};
	return {
		mount: { kind: "archil", disk, region, folder, token },
		read: async (path) => {
			try {
				return await objects.getObject(key(path));
			} catch (error) {
				if ((error as { status?: unknown } | null)?.status === 404) return undefined;
				throw error;
			}
		},
		write: async (path, data) => {
			await objects.putObject(key(path), data);
		},
		close: async () => {
			for (const at of touched) await objects.deleteObject(at).catch(() => {});
		},
	};
}

/** The longest lifetime a computer of a run may ask for: E2B kills each sandbox at its timeout, the lifetime. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"e2b: E2B Hobby plan: every sandbox's timeout is its lifetime, capped at 30 minutes for the run (Hobby caps a sandbox at 1 h, Pro at 24 h). The daemon is a child of E2B's envd, started as a background command; network none is no internet access and no public traffic, read back from E2B and probed from inside; no public stream, so screen.stream is skipped.",
];

export interface E2BModuleOptions extends Pick<E2BFromEnvOptions, "Sandbox" | "daemonPath" | "timeouts"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
	/** The object API of the disk COMPUTER_ARCHIL_DISK names, through which mountFor("archil") reaches a run folder from outside. */
	archilDisk?: ArchilObjects;
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
export async function createProvider({ env = process.env, Sandbox, daemonPath, timeouts }: E2BModuleOptions = {}): Promise<E2BProvider> {
	live(env);
	return fromEnv(env, { ...(Sandbox ? { Sandbox } : {}), ...(daemonPath === undefined ? {} : { daemonPath }), ...(timeouts ? { timeouts } : {}), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/**
 * A run folder for an Archil mount, and none for any other kind (an E2B computer takes no bind): a fresh folder on the
 * disk settingsFromEnv names, none when it names none. Reaching it is a call to Archil, so it needs the live switch,
 * and the disk's object API, archilDisk.
 */
export async function mountFor(kind: MountKind, { env = process.env, archilDisk }: E2BModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = settingsFromEnv(env);
	if (settings === undefined) return undefined;
	live(env);
	if (archilDisk === undefined) {
		throw new Error(`mountFor("archil") reaches the run folder from outside through the disk's object API: pass archilDisk, the API of the disk ${ARCHIL_ENV.archilDisk} names`);
	}
	return archilRunFolder(settings, archilDisk);
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider({ env = process.env, Sandbox, timeouts, buildDaemon = (version) => buildDriftDaemon("amd64", version) }: E2BModuleOptions = {}): Promise<E2BProvider> {
	live(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return fromEnv(env, { ...(Sandbox ? { Sandbox } : {}), ...(timeouts ? { timeouts } : {}), daemonPath, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
