// Browserbase for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider browserbase`.
// It makes a real, billed Browserbase session, so it runs only with AGENTRUN_COMPUTER_LIVE_BROWSERBASE=1 and a key the
// lead has OKed, under COMPUTER_BROWSERBASE_API_KEY (and COMPUTER_BROWSERBASE_PROJECT_ID for a direct key). The provider
// reads no environment: this module reads its own COMPUTER_BROWSERBASE_* names (never BROWSERBASE_API_KEY, which may
// hold another project's key) and passes each to create() as its option. The live switch is checked first, before any
// other setting is read. The run makes one session, shared by every case, and releases it.
import { BROWSER_IMAGE } from "../browser.js";
import { type BrowserbaseProvider, type BrowserbaseProviderOptions, create } from "../browserbase.js";

/** The environment this module reads, by name, each for the option its comment names, and the live switch. */
export const BROWSERBASE_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_BROWSERBASE",
	/** apiKey, required: the Browserbase API key. */
	key: "COMPUTER_BROWSERBASE_API_KEY",
	/** projectId: the project sessions are made in; a key behind a credential proxy names none. */
	project: "COMPUTER_BROWSERBASE_PROJECT_ID",
	/** apiUrl: Browserbase's API; default https://api.browserbase.com. */
	url: "COMPUTER_BROWSERBASE_API_URL",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = BROWSERBASE_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type BrowserbaseSettings = Pick<BrowserbaseProviderOptions, "apiKey" | "projectId" | "apiUrl">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing one. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): BrowserbaseSettings {
	const apiKey = env[BROWSERBASE_ENV.key];
	if (apiKey === undefined || apiKey === "") {
		throw new Error(`set ${BROWSERBASE_ENV.key} to a Browserbase API key: the conformance module reads it there and nowhere else, never from BROWSERBASE_API_KEY`);
	}
	const projectId = env[BROWSERBASE_ENV.project] || undefined;
	const apiUrl = env[BROWSERBASE_ENV.url] || undefined;
	return { apiKey, ...(projectId === undefined ? {} : { projectId }), ...(apiUrl === undefined ? {} : { apiUrl }) };
}

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"browserbase: one session for the whole run, released by its last case (browser.release) and again at the run's end; Browserbase bills at least one minute of it. Browserbase keeps a session's downloads and recordings; the suite does not test them.",
];

export interface BrowserbaseModuleOptions extends Pick<BrowserbaseProviderOptions, "fetch" | "sleep" | "confirm"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
}

/** The image every computer of the run asks for: the vendor's Chromium. */
export function conformanceImage(): string {
	return BROWSER_IMAGE;
}

/** The provider the CLI runs; throws in words without the live switch, or when the key is missing. */
export async function createProvider({ env = process.env, ...transport }: BrowserbaseModuleOptions = {}): Promise<BrowserbaseProvider> {
	if (env[BROWSERBASE_ENV.live] !== "1") {
		throw new Error(`the Browserbase conformance module makes a real, billed session: set ${BROWSERBASE_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
	return create({ ...settingsFromEnv(env), ...transport });
}
