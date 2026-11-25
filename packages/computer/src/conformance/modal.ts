// Modal for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider modal`. It takes its
// token from COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET alone (never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET,
// which may hold a production token); the provider gives the token to the client explicitly, pins the server it goes to
// and refuses an ambient MODAL_SERVER_URL (see modalClient in ../modal.ts).
// For the mount cases, mountFor("archil") makes a fresh run folder on the Archil disk COMPUTER_ARCHIL_DISK names (in
// COMPUTER_ARCHIL_REGION, mounted with the disk token COMPUTER_ARCHIL_TOKEN), and reaches it from outside with the
// host's disk SDK (COMPUTER_ARCHIL_API_KEY and COMPUTER_ARCHIL_S3_URL, ./archil.ts); with no disk named the cases are
// skipped.
import { boxImageRef } from "../box-image.js";
import { MODAL } from "../descriptors/modal.js";
import { httpsBase } from "../hosted/rest.js";
import { create, MODAL_DEFAULT_SERVER_URL, type ModalClientConstructor, type ModalCreateOptions, type ModalProvider } from "../modal.js";
import type { ProviderNote } from "../mount-archil.js";
import { type ArchilMountOptions, archilMountFor } from "./archil.js";
import { dialOnlyFromServer } from "./dial-only.js";
import { type Env, type HostedModuleOptions, hostedModule, kindFrom } from "./module-kit.js";

// Modal ends each sandbox at its timeout, the lifetime.
export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

export const MODAL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_MODAL",
	/** tokenId and tokenSecret, required: the Modal token. */
	tokenId: "COMPUTER_MODAL_TOKEN_ID",
	tokenSecret: "COMPUTER_MODAL_TOKEN_SECRET",
	/** app, required: the Modal App the run's sandboxes live in, made when missing. */
	app: "COMPUTER_MODAL_APP",
	/** serverUrl: the server the token goes to; the SDK's default when unset. */
	serverUrl: "COMPUTER_MODAL_SERVER_URL",
	/** connect: exec (default) or dial, which needs the public server's process (dialKit). */
	connect: "COMPUTER_MODAL_CONNECT",
	/** kind: linux (default) or desktop, which create() takes on dial alone. */
	kind: "COMPUTER_MODAL_KIND",
} as const;

export const ENV = MODAL_ENV;

/** What this module reads from the environment: the token, the app, and the server when set. */
export type ModalSettings = Pick<ModalCreateOptions, "tokenId" | "tokenSecret" | "app" | "serverUrl" | "connect">;

/**
 * The provider's options this module reads from env; throws in words without the token or the app, or while
 * MODAL_SERVER_URL is set there (the SDK would send the token to it), never echoing a token.
 */
export function settingsFromEnv(env: Env = process.env): ModalSettings {
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
	const connect = env[MODAL_ENV.connect] as "exec" | "dial" | undefined;
	return { tokenId, tokenSecret, app, ...(serverUrl ? { serverUrl } : {}), ...(connect ? { connect } : {}) };
}

export interface ModalModuleOptions extends HostedModuleOptions, ArchilMountOptions {
	/** The SDK's ModalClient; imported from the host's modal package by default. */
	ModalClient?: ModalClientConstructor;
	/** The daemon to upload. */
	daemonPath?: string;
	/** What the provider says that is no failure: the CLI gives it and puts it in the report. */
	onNote?: ProviderNote;
	/** The public server a dial machine dials (COMPUTER_MODAL_CONNECT=dial): its process alone gives it (dialKit). */
	dial?: ModalCreateOptions["dial"];
}

const modal = hostedModule<ModalModuleOptions, ModalSettings, ModalProvider>({
	live: { name: MODAL_ENV.live, what: "the Modal conformance module makes real sandboxes", whose: "a key for an account you can bill" },
	settingsFromEnv,
	create,
	host: ["ModalClient"],
	run: ["onNote", "dial"],
	runDefined: ["daemonPath"],
	runFromEnv: (env) => kindFrom(env, MODAL_ENV.kind),
	// A before file of another app, or of the same app name on another server, would make every computer there read as new.
	scope: ({ app, serverUrl = MODAL_DEFAULT_SERVER_URL }) => `the app ${app} on ${httpsBase(serverUrl, `the Modal server URL (${MODAL_ENV.serverUrl})`)}`,
});

export const { createProvider, createDriftedProvider, createHost, sweepScope } = modal;

/**
 * The image every computer of the run starts from: on dial the box image, since only it holds agentrun-dial; on exec
 * debian:bookworm-slim, the CLI's own default.
 */
export function conformanceImage({ env = process.env }: Pick<ModalModuleOptions, "env"> = {}): string {
	return env[MODAL_ENV.connect] === "dial" ? boxImageRef() : "debian:bookworm-slim";
}

export const dialKit = dialOnlyFromServer(MODAL, `${MODAL_ENV.connect}=dial`);

export const mountFor = archilMountFor(modal.live);
