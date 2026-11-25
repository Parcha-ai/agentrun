// Cloudflare for the conformance run. Its containers dial the server that minted their tokens (facts.connect "dial"), so
// a Core run happens inside that server's own process, behind its public address: serve's
// packages/serve/scripts/dial-conformance.mjs --provider cloudflare gives createProvider() its dial and the run a DialKit.
// From a laptop's CLI, dialKit() refuses in words, and the provider refuses every create before the relay is called.
import { type CloudflareProvider, create } from "../cloudflare.js";
import { CLOUDFLARE } from "../descriptors/cloudflare.js";
import type { MachineHost } from "../host.js";
import type { HostedDial } from "../hosted/provider.js";
import { httpsBase } from "../hosted/rest.js";
import type { ProviderNote } from "../mount-archil.js";
import { dialOnlyFromServer } from "./dial-only.js";
import { CONFORMANCE_MAX_LIFETIME_MS, type Env, kindFrom, preparedImage } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS };

export const ENV = {
	/** relayUrl, required: the relay Worker's https address. */
	url: "COMPUTER_CLOUDFLARE_RELAY_URL",
	/** relayToken, required: the relay's RELAY_TOKEN. */
	token: "COMPUTER_CLOUDFLARE_RELAY_TOKEN",
	/** kind: linux (default) or desktop, which needs the public server's process (dialKit). */
	kind: "COMPUTER_CLOUDFLARE_KIND",
} as const;

/** The provider's options this module reads from env; throws in words without either, never echoing the token. */
export function settingsFromEnv(env: Env = process.env): { relayUrl: string; relayToken: string } {
	const relayUrl = env[ENV.url];
	const relayToken = env[ENV.token];
	if (!relayUrl || !relayToken) throw new Error(`the Cloudflare conformance module needs ${ENV.url} and ${ENV.token}`);
	return { relayUrl, relayToken };
}

export interface CloudflareModuleOptions {
	/** The environment to read; process.env by default. */
	env?: Record<string, string | undefined>;
	/** The server the containers dial: dial-conformance.mjs gives its own. Without it every create is refused in words. */
	dial?: HostedDial;
	/** The daemon the server serves (its sha256 is what a container checks); default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** The fetch the relay's calls go through; default the global one. */
	fetch?: typeof fetch;
	/** What the provider says that is no failure: the CLI gives it and puts it in the report. */
	onNote?: ProviderNote;
}

/** The provider the run makes computers with, dialing the server options.dial names. */
export function createProvider({ env = process.env, dial, daemonPath, fetch, onNote }: CloudflareModuleOptions = {}): CloudflareProvider {
	return create({
		...settingsFromEnv(env),
		...kindFrom(env, ENV.kind),
		...(dial ? { dial } : {}),
		...(daemonPath === undefined ? {} : { daemonPath }),
		...(fetch ? { fetch } : {}),
		...(onNote ? { onNote } : {}),
		maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS,
	});
}

/** The run's image: the box image the relay was deployed FROM, as its /v1/health names it. */
export async function conformanceImage(options: Pick<CloudflareModuleOptions, "env" | "fetch"> = {}, context: { signal?: AbortSignal } = {}): Promise<string> {
	return preparedImage(createProvider(options), context.signal);
}

export const dialKit = dialOnlyFromServer(CLOUDFLARE);

export function createHost({ env = process.env, fetch }: Pick<CloudflareModuleOptions, "env" | "fetch"> = {}): MachineHost {
	return create({ ...settingsFromEnv(env), ...(fetch ? { fetch } : {}) }).host;
}

/** Where the sweep lists, in words: the relay the settings name. */
export function sweepScope({ env = process.env }: Pick<CloudflareModuleOptions, "env"> = {}): string {
	return `the Cloudflare relay at ${httpsBase(settingsFromEnv(env).relayUrl, `the Cloudflare relay URL (${ENV.url})`)}`;
}
