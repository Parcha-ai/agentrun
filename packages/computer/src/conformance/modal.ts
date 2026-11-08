// Modal for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider modal`. It builds a real
// Modal client, so it runs only with AGENTRUN_COMPUTER_LIVE_MODAL=1 and a key the lead has OKed, under
// COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET. The provider reads no environment: this module reads its own
// COMPUTER_MODAL_* names (never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET, which may hold a production token) and passes each
// to create() as its option; the provider gives the token to the client explicitly, pins the server it goes to and
// refuses an ambient MODAL_SERVER_URL (see modalClient in ../modal.ts). The live switch is checked first, before any
// other setting is read. The sweep (modal-sweep.ts) reads the same names through settingsFromEnv.
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
import { create, type ModalClientConstructor, type ModalCreateOptions } from "../modal.js";
import { type ArchilRunFolderOptions, archilRunFolder, archilSettings } from "./archil.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

/** The environment this module reads, by name, each for the option its comment names, and the live switch. */
export const MODAL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_MODAL",
	/** tokenId and tokenSecret, required: the Modal token. */
	tokenId: "COMPUTER_MODAL_TOKEN_ID",
	tokenSecret: "COMPUTER_MODAL_TOKEN_SECRET",
	/** app, required: the Modal App the run's sandboxes live in, made when missing. */
	app: "COMPUTER_MODAL_APP",
	/** daemonImage: an image holding the daemon, pinned by digest, to COPY --from instead of uploading it. */
	daemonImage: "COMPUTER_MODAL_DAEMON_IMAGE",
	/** serverUrl: the server the token goes to; the SDK's default when unset. */
	serverUrl: "COMPUTER_MODAL_SERVER_URL",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = MODAL_ENV;

/** What this module reads from the environment: the token, the app, and the server and daemon image when set. */
export type ModalSettings = Pick<ModalCreateOptions, "tokenId" | "tokenSecret" | "app" | "serverUrl" | "daemonImage">;

/**
 * The provider's options this module reads from env; throws in words without the token or the app, or while
 * MODAL_SERVER_URL is set there (the SDK would send the token to it), never echoing a token.
 */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): ModalSettings {
	const tokenId = env[MODAL_ENV.tokenId];
	const tokenSecret = env[MODAL_ENV.tokenSecret];
	if (!tokenId || !tokenSecret) {
		throw new Error(`the Modal conformance module needs ${MODAL_ENV.tokenId} and ${MODAL_ENV.tokenSecret}: it takes a key from those names only, never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET`);
	}
	if (env.MODAL_SERVER_URL) {
		throw new Error(`the Modal provider refuses to start while MODAL_SERVER_URL is set: the SDK would send the key there. Unset it, and name the server in ${MODAL_ENV.serverUrl} if it is not the SDK's default`);
	}
	const app = env[MODAL_ENV.app];
	if (!app) throw new Error(`the Modal conformance module needs ${MODAL_ENV.app}: the app the run's sandboxes live in`);
	const serverUrl = env[MODAL_ENV.serverUrl];
	const daemonImage = env[MODAL_ENV.daemonImage];
	return { tokenId, tokenSecret, app, ...(serverUrl ? { serverUrl } : {}), ...(daemonImage ? { daemonImage } : {}) };
}

/** The longest lifetime a computer of a run may ask for: Modal ends each sandbox at its timeout, the lifetime. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

export interface ModalModuleOptions {
	/** The environment to read; process.env by default. */
	env?: Record<string, string | undefined>;
	/** The SDK's ModalClient; imported from the host's modal package by default. */
	ModalClient?: ModalClientConstructor;
	/** The daemon to upload, when COMPUTER_MODAL_DAEMON_IMAGE names no image; default this package's dist/computerd-linux-amd64. */
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
	// Given COMPUTER_MODAL_DAEMON_IMAGE and a daemonPath, create() takes the image.
	return create({ ...settingsFromEnv(env), ...(daemonPath === undefined ? {} : { daemonPath }), ...(ModalClient ? { ModalClient } : {}), ...(onNote ? { onNote } : {}), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/**
 * A run folder for an Archil mount, and none for any other kind (a Modal computer takes no bind): a fresh folder on the
 * disk the COMPUTER_ARCHIL_* names name (archilSettings), none when they name none (archilRunFolder, ./archil.ts).
 * Reaching it is a call to Archil, so it needs the live switch.
 */
export async function mountFor(kind: MountKind, { env = process.env, archil = {} }: ModalModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "archil") return undefined;
	const settings = archilSettings(env);
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
	const { daemonImage: _image, ...settings } = settingsFromEnv(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return create({ ...settings, daemonPath, ...(ModalClient ? { ModalClient } : {}), maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
