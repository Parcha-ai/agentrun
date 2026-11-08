// E2B for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider e2b [--image <template>]`.
// It makes real sandboxes, so it runs only with AGENTRUN_COMPUTER_LIVE_E2B=1 and a key the lead has OKed, under
// COMPUTER_E2B_API_KEY: the provider's fromEnv reads that name alone, never E2B_API_KEY, gives the SDK the key, domain
// and API URL explicitly, and refuses an ambient E2B_SANDBOX_URL (see fromEnv in ../e2b.ts). The live switch is checked
// first, before any other setting is read.
//
// The daemon is uploaded into each sandbox (dist/computerd-linux-amd64, `npm run build:daemon`), so a run publishes
// nothing. The drifted provider uploads a daemon built with Go as version <version>-drift. Every computer of a run lives
// at most 30 minutes, E2B Hobby's plan for conformance: E2B's timeout is the lifetime, and a longer one is refused.
import { ENV, type E2BFromEnvOptions, type E2BProvider, fromEnv } from "../e2b.js";
import { buildDriftDaemon, DRIFT_VERSION } from "./drift-daemon.js";

/** The environment this module reads, by name: the provider's, the live switch and the run's template. */
export const E2B_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_E2B",
	/** The template every computer of the run starts from; default "desktop", E2B Desktop's. */
	template: "COMPUTER_E2B_TEMPLATE",
	...ENV,
} as const;

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

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider({ env = process.env, Sandbox, timeouts, buildDaemon = (version) => buildDriftDaemon("amd64", version) }: E2BModuleOptions = {}): Promise<E2BProvider> {
	live(env);
	const daemonPath = await buildDaemon(DRIFT_VERSION);
	return fromEnv(env, { ...(Sandbox ? { Sandbox } : {}), ...(timeouts ? { timeouts } : {}), daemonPath, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
