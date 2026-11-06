// Modal for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider dist/conformance/modal.js`.
// It builds a real Modal client, so it runs only with AGENTRUN_COMPUTER_LIVE_MODAL=1 and a key the lead has OKed:
// MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, which the SDK reads itself (modal-client@64880502:js/src/config.ts:144-145);
// nothing here reads their values. The modal package is the host's: it is imported only when a provider is made.
import { ModalProvider, type ModalSdk } from "../modal.js";
import type { ComputerProvider } from "../provider.js";

/** The environment this module reads, by name. */
export const MODAL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_MODAL",
	tokenId: "MODAL_TOKEN_ID",
	tokenSecret: "MODAL_TOKEN_SECRET",
	app: "AGENTRUN_COMPUTER_MODAL_APP",
	daemonImage: "AGENTRUN_COMPUTER_MODAL_DAEMON_IMAGE",
	/** The same daemon built as version <version>-drift, for the drift.version case. */
	driftedDaemonImage: "AGENTRUN_COMPUTER_MODAL_DRIFTED_DAEMON_IMAGE",
} as const;

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const MODAL_PACKAGE: string = "modal";

/** A value of the environment by name, or a refusal that names what is missing. Never a token: those the SDK reads. */
function setting(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`the Modal conformance module needs ${name} in the environment`);
	return value;
}

async function client(): Promise<ModalSdk> {
	if (process.env[MODAL_ENV.live] !== "1") {
		throw new Error(`the Modal conformance module makes real sandboxes: set ${MODAL_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
	const missing = [MODAL_ENV.tokenId, MODAL_ENV.tokenSecret].filter((name) => !(name in process.env));
	if (missing.length > 0) throw new Error(`the Modal conformance module needs ${missing.join(" and ")} in the environment`);
	const sdk = (await import(MODAL_PACKAGE)) as { ModalClient: new () => unknown };
	return new sdk.ModalClient() as ModalSdk;
}

export async function createProvider(): Promise<ComputerProvider> {
	const app = setting(MODAL_ENV.app);
	const daemonImage = setting(MODAL_ENV.daemonImage);
	return new ModalProvider({ sdk: await client(), app, daemonImage });
}

export async function createDriftedProvider(): Promise<ComputerProvider> {
	const app = setting(MODAL_ENV.app);
	const daemonImage = setting(MODAL_ENV.driftedDaemonImage);
	return new ModalProvider({ sdk: await client(), app, daemonImage });
}
