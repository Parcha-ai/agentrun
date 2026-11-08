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
// disk's object API (the shared archilRunFolder, ./archil.ts: the host's disk SDK with COMPUTER_ARCHIL_API_KEY and
// COMPUTER_ARCHIL_S3_URL, or an object API given as archil.objects); with no disk named it makes none, and the cases
// are skipped.
import type { MountKind } from "../mount.js";
import type { ProviderNote } from "../mount-archil.js";
import type { ComputerProvider } from "../provider.js";
import { ENV, fromEnv, type ModalClientConstructor } from "../modal.js";
import { ARCHIL_ENV, type ArchilRunFolderOptions, archilRunFolder, archilSettings } from "./archil.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The environment this module reads, by name: the provider's, the live switch, and the Archil disk of the mount cases. */
export const MODAL_ENV = { live: "AGENTRUN_COMPUTER_LIVE_MODAL", ...ENV, ...ARCHIL_ENV } as const;

/** The Archil disk this module's mount cases mount, from the COMPUTER_ARCHIL_* names: see archilSettings. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): ReturnType<typeof archilSettings> {
	return archilSettings(env);
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
	/** For mountFor("archil"): the disk's object API, or the SDK's Archil client, in place of the host's disk package. */
	archil?: Pick<ArchilRunFolderOptions, "objects" | "Archil" | "baseUrl">;
	/** What the provider says that is no failure: the CLI gives it and puts it in the report. */
	onNote?: ProviderNote;
}

function live(env: Record<string, string | undefined>): void {
	if (env[MODAL_ENV.live] !== "1") {
		throw new Error(`the Modal conformance module makes real sandboxes: set ${MODAL_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
}

export async function createProvider({ env = process.env, ModalClient, daemonPath, onNote }: ModalModuleOptions = {}): Promise<ComputerProvider> {
	live(env);
	return fromEnv(env, { ...(ModalClient ? { ModalClient } : {}), ...(daemonPath === undefined ? {} : { daemonPath }), ...(onNote ? { onNote } : {}), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/**
 * A run folder for an Archil mount, and none for any other kind (a Modal computer takes no bind): a fresh folder on the
 * disk settingsFromEnv names, none when it names none (archilRunFolder, ./archil.ts). Reaching it is a call to Archil,
 * so it needs the live switch.
 */
export async function mountFor(kind: MountKind, { env = process.env, archil = {} }: ModalModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = settingsFromEnv(env);
	if (settings === undefined) return undefined;
	live(env);
	return archilRunFolder({ ...settings, ...archil });
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
