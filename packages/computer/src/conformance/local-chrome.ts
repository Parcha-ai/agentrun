// Local Chrome for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider local-chrome`.
// It starts a real Chrome on this machine (nothing billed, no key).
import { BROWSER_IMAGE } from "../descriptors/shared.js";
import { CHROME_ENV_NAMES, childEnv } from "../child-env.js";
import { create, type LocalBrowserOptions, type LocalBrowserProvider } from "../local-chrome.js";
import { type Env, requireLive, setOptions } from "./module-kit.js";

export const LOCAL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_LOCAL_CHROME",
	/** executablePath: the Chrome or Chromium to run; default the first on PATH, then the usual install places. */
	chrome: "COMPUTER_LOCAL_CHROME_PATH",
	/** headed: "1" shows the window. */
	headed: "COMPUTER_LOCAL_CHROME_HEADED",
} as const;

export const ENV = LOCAL_ENV;

export type LocalSettings = Pick<LocalBrowserOptions, "executablePath" | "headed" | "env">;

/** The provider's options this module reads from env, each only when its name is set; the names Chrome reads go in as the
 *  provider's env (CHROME_ENV_NAMES: PATH, to find a Chrome on it, HOME, the display, locale and fonts), and no other. */
export function settingsFromEnv(env: Env = process.env): LocalSettings {
	const headed = env[LOCAL_ENV.headed] === "1";
	return { ...setOptions(env, { executablePath: LOCAL_ENV.chrome }), ...(headed ? { headed } : {}), env: childEnv(env, CHROME_ENV_NAMES) };
}

export const conformanceNotes: string[] = [
	"local-chrome: this machine's Chrome, one browser for the whole run, deleted by its last case and again at the run's end. Its supervisor ends it at its deadline, which list reads.",
];

export interface LocalModuleOptions {
	env?: Env;
}

/** The image every computer of the run asks for: this machine's Chrome. */
export function conformanceImage(): string {
	return BROWSER_IMAGE;
}

/** The provider the CLI runs; throws in words without the live switch. */
export async function createProvider({ env = process.env }: LocalModuleOptions = {}): Promise<LocalBrowserProvider> {
	requireLive(env, LOCAL_ENV.live, "the Local Chrome conformance module starts a real Chrome on this machine");
	return create(settingsFromEnv(env));
}
