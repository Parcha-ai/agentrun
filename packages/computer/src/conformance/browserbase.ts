// Browserbase for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider browserbase`.
// It makes a real, billed Browserbase session, so it runs only with AGENTRUN_COMPUTER_LIVE_BROWSERBASE=1 and a key for
// an account you can bill, under COMPUTER_BROWSERBASE_API_KEY (and COMPUTER_BROWSERBASE_PROJECT_ID for a direct key),
// never BROWSERBASE_API_KEY, which may hold another project's key.
import { BROWSER_IMAGE } from "../descriptors/shared.js";
import { type BrowserbaseProvider, type BrowserbaseProviderOptions, create } from "../browserbase.js";
import { type Env, requiredSecret, requireLive, setOptions } from "./module-kit.js";

export const BROWSERBASE_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_BROWSERBASE",
	/** apiKey, required: the Browserbase API key. */
	key: "COMPUTER_BROWSERBASE_API_KEY",
	/** projectId: the project sessions are made in; a key behind a credential proxy names none. */
	project: "COMPUTER_BROWSERBASE_PROJECT_ID",
	/** apiUrl: Browserbase's API. */
	url: "COMPUTER_BROWSERBASE_API_URL",
} as const;

export const ENV = BROWSERBASE_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type BrowserbaseSettings = Pick<BrowserbaseProviderOptions, "apiKey" | "projectId" | "apiUrl">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing one. */
export function settingsFromEnv(env: Env = process.env): BrowserbaseSettings {
	const apiKey = requiredSecret(env, BROWSERBASE_ENV.key, "a Browserbase API key");
	return { apiKey, ...setOptions(env, { projectId: BROWSERBASE_ENV.project, apiUrl: BROWSERBASE_ENV.url }) };
}

export const conformanceNotes: string[] = [
	"browserbase: one session for the whole run, released by its last case (browser.release) and again at the run's end; Browserbase bills at least one minute of it. Browserbase keeps a session's downloads and recordings; the suite does not test them.",
];

export interface BrowserbaseModuleOptions extends Pick<BrowserbaseProviderOptions, "fetch" | "sleep" | "confirm"> {
	env?: Env;
}

/** The image every computer of the run asks for: the vendor's Chromium. */
export function conformanceImage(): string {
	return BROWSER_IMAGE;
}

/** The provider the CLI runs; throws in words without the live switch, or when the key is missing. */
export async function createProvider({ env = process.env, ...transport }: BrowserbaseModuleOptions = {}): Promise<BrowserbaseProvider> {
	requireLive(env, BROWSERBASE_ENV.live, "the Browserbase conformance module makes a real, billed session", "a key for an account you can bill");
	return create({ ...settingsFromEnv(env), ...transport });
}
