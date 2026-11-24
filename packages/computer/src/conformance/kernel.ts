// Kernel for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider kernel`. It makes a
// real, billed Kernel browser, under COMPUTER_KERNEL_API_KEY (never KERNEL_API_KEY, which may hold another organization's key).
import { BROWSER_IMAGE } from "../descriptors/shared.js";
import { create, type KernelProvider, type KernelProviderOptions } from "../kernel.js";
import { type Env, requiredSecret, requireLive, setOptions } from "./module-kit.js";

export const KERNEL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_KERNEL",
	/** apiKey, required: the Kernel API key. */
	key: "COMPUTER_KERNEL_API_KEY",
	/** apiUrl: Kernel's API. */
	url: "COMPUTER_KERNEL_API_URL",
} as const;

export const ENV = KERNEL_ENV;

/** What this module reads from the environment: the key, and the API URL when its name is set. */
export type KernelSettings = Pick<KernelProviderOptions, "apiKey" | "apiUrl">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing one. */
export function settingsFromEnv(env: Env = process.env): KernelSettings {
	const apiKey = requiredSecret(env, KERNEL_ENV.key, "a Kernel API key");
	return { apiKey, ...setOptions(env, { apiUrl: KERNEL_ENV.url }) };
}

export const conformanceNotes: string[] = [
	"kernel: one browser for the whole run, deleted by its last case (browser.release) and again at the run's end. Kernel's lifetime is an idle timeout (no wall clock), so list reads no deadline.",
];

export interface KernelModuleOptions extends Pick<KernelProviderOptions, "fetch" | "sleep" | "confirm"> {
	env?: Env;
}

/** The image every computer of the run asks for: the vendor's Chromium. */
export function conformanceImage(): string {
	return BROWSER_IMAGE;
}

/** The provider the CLI runs; throws in words without the live switch, or when the key is missing. */
export async function createProvider({ env = process.env, ...transport }: KernelModuleOptions = {}): Promise<KernelProvider> {
	requireLive(env, KERNEL_ENV.live, "the Kernel conformance module makes a real, billed browser", "a key for an account you can bill");
	return create({ ...settingsFromEnv(env), ...transport });
}
