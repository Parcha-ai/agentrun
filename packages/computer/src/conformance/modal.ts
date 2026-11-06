// Modal for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider dist/conformance/modal.js`.
// It builds a real Modal client, so it runs only with AGENTRUN_COMPUTER_LIVE_MODAL=1 and a key the lead has OKed, under
// COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET. Never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET: a host may hold a
// production token under those names, and the SDK reads them, else the active profile of ~/.modal.toml, on its own
// (modal-client@64880502:js/src/config.ts:139-145; client.ts:123). So the client is given the COMPUTER_MODAL_ pair
// explicitly: a tokenId and tokenSecret passed to ModalClient replace what the environment or the profile held, and
// clear any OAuth credentials (client.ts:124-148). The modal package is the host's: it is imported only when a
// provider is made.
import { ModalProvider, type ModalSdk } from "../modal.js";
import type { ComputerProvider } from "../provider.js";

/** The environment this module reads, by name. */
export const MODAL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_MODAL",
	tokenId: "COMPUTER_MODAL_TOKEN_ID",
	tokenSecret: "COMPUTER_MODAL_TOKEN_SECRET",
	app: "COMPUTER_MODAL_APP",
	daemonImage: "COMPUTER_MODAL_DAEMON_IMAGE",
	/** The same daemon built as version <version>-drift, for the drift.version case. */
	driftedDaemonImage: "COMPUTER_MODAL_DRIFTED_DAEMON_IMAGE",
} as const;

/** What this module gives the SDK's ModalClient: the token, explicitly, so the SDK fills none of it in. */
export interface ModalClientParams {
	tokenId: string;
	tokenSecret: string;
}

export interface ModalModuleOptions {
	/** The environment to read; process.env by default. */
	env?: Record<string, string | undefined>;
	/** The SDK's ModalClient; imported from the host's modal package by default. */
	ModalClient?: new (params: ModalClientParams) => unknown;
}

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const MODAL_PACKAGE: string = "modal";

/** A value of the environment by name, or a refusal that names what is missing. */
function setting(env: Record<string, string | undefined>, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`the Modal conformance module needs ${name} in the environment`);
	return value;
}

async function client({ env = process.env, ModalClient }: ModalModuleOptions): Promise<ModalSdk> {
	if (env[MODAL_ENV.live] !== "1") {
		throw new Error(`the Modal conformance module makes real sandboxes: set ${MODAL_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
	const tokenId = env[MODAL_ENV.tokenId];
	const tokenSecret = env[MODAL_ENV.tokenSecret];
	if (!tokenId || !tokenSecret) {
		throw new Error(
			`the Modal conformance module needs ${MODAL_ENV.tokenId} and ${MODAL_ENV.tokenSecret} in the environment: ` +
				"it takes a key from those names only, never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET",
		);
	}
	const Client = ModalClient ?? ((await import(MODAL_PACKAGE)) as { ModalClient: new (params: ModalClientParams) => unknown }).ModalClient;
	return new Client({ tokenId, tokenSecret }) as ModalSdk;
}

export async function createProvider(options: ModalModuleOptions = {}): Promise<ComputerProvider> {
	const env = options.env ?? process.env;
	const app = setting(env, MODAL_ENV.app);
	const daemonImage = setting(env, MODAL_ENV.daemonImage);
	return new ModalProvider({ sdk: await client(options), app, daemonImage });
}

export async function createDriftedProvider(options: ModalModuleOptions = {}): Promise<ComputerProvider> {
	const env = options.env ?? process.env;
	const app = setting(env, MODAL_ENV.app);
	const daemonImage = setting(env, MODAL_ENV.driftedDaemonImage);
	return new ModalProvider({ sdk: await client(options), app, daemonImage });
}
