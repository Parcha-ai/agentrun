// Modal for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider modal`. It builds a real
// Modal client, so it runs only with AGENTRUN_COMPUTER_LIVE_MODAL=1 and a key the lead has OKed, under
// COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET: the provider's fromEnv reads those names alone, never
// MODAL_TOKEN_ID or MODAL_TOKEN_SECRET, pins the server the key goes to and refuses an ambient MODAL_SERVER_URL (see
// modalClient in ../modal.ts). The live switch is checked first, before any other setting is read.
//
// The daemon is uploaded into each sandbox (dist/computerd-linux-amd64, `npm run build:daemon`) unless
// COMPUTER_MODAL_DAEMON_IMAGE names an image to copy it from, so a run publishes nothing. The drifted provider uploads
// a daemon built with Go as version <version>-drift. Every computer of a run lives at most 30 minutes: Modal's timeout
// is its lifetime, and a longer one is refused in words.
//
// For the mount cases, mountFor("archil") makes a fresh run folder on the Archil disk COMPUTER_ARCHIL_DISK names (in
// COMPUTER_ARCHIL_REGION, mounted with the disk token COMPUTER_ARCHIL_TOKEN), and reaches it from outside through the
// disk's object API, given as archilDisk; with no disk named it makes none, and the cases are skipped.
import { randomBytes } from "node:crypto";
import type { MountKind } from "../mount.js";
import type { ComputerProvider } from "../provider.js";
import { ENV, fromEnv, type ModalClientConstructor } from "../modal.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The Archil disk mountFor("archil") makes run folders on, by name: the disk, its region and a disk token for the mount. */
const ARCHIL_ENV = { archilDisk: "COMPUTER_ARCHIL_DISK", archilRegion: "COMPUTER_ARCHIL_REGION", archilToken: "COMPUTER_ARCHIL_TOKEN" } as const;

/** The environment this module reads, by name: the provider's, the live switch, and the Archil disk of the mount cases. */
export const MODAL_ENV = { live: "AGENTRUN_COMPUTER_LIVE_MODAL", ...ENV, ...ARCHIL_ENV } as const;

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

/** The longest lifetime a computer of a run may ask for: Modal ends each sandbox at its timeout, the lifetime. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

export interface ModalModuleOptions {
	/** The environment to read; process.env by default. */
	env?: Record<string, string | undefined>;
	/** The SDK's ModalClient; imported from the host's modal package by default. */
	ModalClient?: ModalClientConstructor;
	/** The daemon to upload; default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
	/** The object API of the disk COMPUTER_ARCHIL_DISK names, through which mountFor("archil") reaches a run folder from outside. */
	archilDisk?: ArchilObjects;
}

function live(env: Record<string, string | undefined>): void {
	if (env[MODAL_ENV.live] !== "1") {
		throw new Error(`the Modal conformance module makes real sandboxes: set ${MODAL_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
}

export async function createProvider({ env = process.env, ModalClient, daemonPath }: ModalModuleOptions = {}): Promise<ComputerProvider> {
	live(env);
	return fromEnv(env, { ...(ModalClient ? { ModalClient } : {}), ...(daemonPath === undefined ? {} : { daemonPath }), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/**
 * A run folder for an Archil mount, and none for any other kind (a Modal computer takes no bind): a fresh folder on the
 * disk settingsFromEnv names, none when it names none. Reaching it is a call to Archil, so it needs the live switch,
 * and the disk's object API, archilDisk.
 */
export async function mountFor(kind: MountKind, { env = process.env, archilDisk }: ModalModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = settingsFromEnv(env);
	if (settings === undefined) return undefined;
	live(env);
	if (archilDisk === undefined) {
		throw new Error(`mountFor("archil") reaches the run folder from outside through the disk's object API: pass archilDisk, the API of the disk ${ARCHIL_ENV.archilDisk} names`);
	}
	return archilRunFolder(settings, archilDisk);
}

/**
 * The same provider uploading a daemon that reports version <version>-drift, for the drift.version case, whatever image
 * COMPUTER_MODAL_DAEMON_IMAGE names.
 */
export async function createDriftedProvider({ env = process.env, ModalClient, buildDaemon = (version) => buildDriftDaemon("amd64", version) }: ModalModuleOptions = {}): Promise<ComputerProvider> {
	live(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return fromEnv({ ...env, [ENV.daemonImage]: undefined }, { ...(ModalClient ? { ModalClient } : {}), daemonPath, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
