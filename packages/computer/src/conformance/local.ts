// The local browser for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider local`. It
// starts a real Chrome on this machine (nothing billed, no key), so it runs only with AGENTRUN_COMPUTER_LIVE_LOCAL=1. The
// provider reads no environment: this module reads its own COMPUTER_LOCAL_* names, and PATH to find a Chrome, and passes
// each to create() as its option.
import { BROWSER_IMAGE } from "../browser.js";
import { create, type LocalBrowserOptions, type LocalBrowserProvider } from "../local.js";

/** The environment this module reads, by name, each for the option its comment names, and the live switch. */
export const LOCAL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_LOCAL",
	/** executablePath: the Chrome or Chromium to run; default the first on PATH, then the usual install places. */
	chrome: "COMPUTER_LOCAL_CHROME",
	/** headed: "1" shows the window. */
	headed: "COMPUTER_LOCAL_HEADED",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = LOCAL_ENV;

export type LocalSettings = Pick<LocalBrowserOptions, "executablePath" | "headed" | "env">;

/** The provider's options this module reads from env, each only when its name is set; PATH goes in as the provider's env, to find a Chrome on it. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): LocalSettings {
	const executablePath = env[LOCAL_ENV.chrome] || undefined;
	const headed = env[LOCAL_ENV.headed] === "1";
	return { ...(executablePath === undefined ? {} : { executablePath }), ...(headed ? { headed } : {}), env: { PATH: env.PATH } };
}

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"local: this machine's Chrome, one browser for the whole run, deleted by its last case and again at the run's end. Its supervisor ends it at its deadline, which list reads.",
];

export interface LocalModuleOptions {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
}

/** The image every computer of the run asks for: this machine's Chrome. */
export function conformanceImage(): string {
	return BROWSER_IMAGE;
}

/** The provider the CLI runs; throws in words without the live switch. */
export async function createProvider({ env = process.env }: LocalModuleOptions = {}): Promise<LocalBrowserProvider> {
	if (env[LOCAL_ENV.live] !== "1") throw new Error(`the local conformance module starts a real Chrome on this machine: set ${LOCAL_ENV.live}=1 to run it`);
	return create(settingsFromEnv(env));
}
