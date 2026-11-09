// Kernel for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider kernel`. It makes a
// real, billed Kernel browser, so it runs only with AGENTRUN_COMPUTER_LIVE_KERNEL=1 and a key the lead has OKed, under
// COMPUTER_KERNEL_API_KEY. The provider reads no environment: this module reads its own COMPUTER_KERNEL_* names (never
// KERNEL_API_KEY, which may hold another organization's key) and passes each to create() as its option. The live switch
// is checked first, before any other setting is read. The run makes one browser, shared by every case, and deletes it.
import { BROWSER_IMAGE } from "../browser.js";
import { create, type KernelProvider, type KernelProviderOptions } from "../kernel.js";

/** The environment this module reads, by name, each for the option its comment names, and the live switch. */
export const KERNEL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_KERNEL",
	/** apiKey, required: the Kernel API key. */
	key: "COMPUTER_KERNEL_API_KEY",
	/** apiUrl: Kernel's API; default https://api.onkernel.com. */
	url: "COMPUTER_KERNEL_API_URL",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = KERNEL_ENV;

/** What this module reads from the environment: the key, and the API URL when its name is set. */
export type KernelSettings = Pick<KernelProviderOptions, "apiKey" | "apiUrl">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing one. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): KernelSettings {
	const apiKey = env[KERNEL_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${KERNEL_ENV.key} to a Kernel API key: the conformance module reads it there and nowhere else, never from KERNEL_API_KEY`);
	const apiUrl = env[KERNEL_ENV.url] || undefined;
	return { apiKey, ...(apiUrl === undefined ? {} : { apiUrl }) };
}

/** For the run's report: what this configuration means for the suite. */
export const conformanceNotes: string[] = [
	"kernel: one browser for the whole run, deleted by its last case (browser.release) and again at the run's end. Kernel's lifetime is an idle timeout (no wall clock), so list reads no deadline.",
];

export interface KernelModuleOptions extends Pick<KernelProviderOptions, "fetch" | "sleep" | "confirm"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
}

/** The image every computer of the run asks for: the vendor's Chromium. */
export function conformanceImage(): string {
	return BROWSER_IMAGE;
}

/** The provider the CLI runs; throws in words without the live switch, or when the key is missing. */
export async function createProvider({ env = process.env, ...transport }: KernelModuleOptions = {}): Promise<KernelProvider> {
	if (env[KERNEL_ENV.live] !== "1") {
		throw new Error(`the Kernel conformance module makes a real, billed browser: set ${KERNEL_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
	return create({ ...settingsFromEnv(env), ...transport });
}
