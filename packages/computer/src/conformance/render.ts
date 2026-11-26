// Render Sandboxes for the conformance run. Its machines dial the server that minted their tokens (facts.connect
// "dial"), so a Core run has to happen inside that server's own process, behind its public address: serve's
// packages/serve/scripts/dial-conformance.mjs --provider render does it: it gives createProvider() its dial (the public
// URL, the minted tokens and the attach hub) and the run a DialKit over the same server. From a laptop's CLI there is no
// such server: dialKit() refuses in words, and the provider refuses every create before Render is called. The key is
// read from COMPUTER_RENDER_API_KEY alone (never RENDER_API_KEY, which may hold a production key).
import { RENDER } from "../descriptors/render.js";
import type { MachineHost } from "../host.js";
import type { HostedDial } from "../hosted/provider.js";
import type { ProviderNote } from "../mount-archil.js";
import { create, type RenderProvider } from "../render.js";
import { dialOnlyFromServer } from "./dial-only.js";
import { CONFORMANCE_MAX_LIFETIME_MS, type Env, preparedImage } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS };

export const RENDER_ENV = {
	/** apiKey, required: a Render API key that may make sandboxes in the workspace. */
	key: "COMPUTER_RENDER_API_KEY",
	/** ownerId, required: the workspace the run's sandboxes are made in (tea-… or usr-…). */
	workspace: "COMPUTER_RENDER_WORKSPACE_ID",
	/** The build the run's computers start from; default the box build prepareImage() finds or imports. */
	image: "COMPUTER_RENDER_IMAGE",
} as const;

export const ENV = RENDER_ENV;

/** The provider's options this module reads from env; throws in words without the key or the workspace, never echoing one. */
export function settingsFromEnv(env: Env = process.env): { apiKey: string; ownerId: string } {
	const apiKey = env[RENDER_ENV.key];
	const ownerId = env[RENDER_ENV.workspace];
	if (!apiKey || !ownerId) throw new Error(`the Render conformance module needs ${RENDER_ENV.key} and ${RENDER_ENV.workspace}: it takes a key from that name only, never RENDER_API_KEY`);
	return { apiKey, ownerId };
}

export interface RenderModuleOptions {
	/** The environment to read; process.env by default. */
	env?: Record<string, string | undefined>;
	/** The server the machines dial: dial-conformance.mjs gives its own. Without it every create is refused in words. */
	dial?: HostedDial;
	/** The daemon the server serves (its sha256 is what a machine checks); default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** The fetch Render's calls go through; default the global one. */
	fetch?: typeof fetch;
	/** What the provider says that is no failure: the CLI gives it and puts it in the report. */
	onNote?: ProviderNote;
}

/** The provider the run makes computers with, dialing the server options.dial names. */
export function createProvider({ env = process.env, dial, daemonPath, fetch, onNote }: RenderModuleOptions = {}): RenderProvider {
	return create({
		...settingsFromEnv(env),
		...(dial ? { dial } : {}),
		...(daemonPath === undefined ? {} : { daemonPath }),
		...(fetch ? { fetch } : {}),
		...(onNote ? { onNote } : {}),
		maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS,
	});
}

/** The run's image: COMPUTER_RENDER_IMAGE's build, else the box build the workspace has or imports (prepareImage). */
export async function conformanceImage(options: RenderModuleOptions = {}, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
	const named = (options.env ?? process.env)[RENDER_ENV.image];
	if (named) return named;
	return preparedImage(createProvider(options), signal);
}

/** The server the run's machines dial, for provider.dial-token, as the CLI asks for it: refused in words (dial-only.ts). */
export const dialKit = dialOnlyFromServer(RENDER);

export function createHost({ env = process.env, fetch }: Pick<RenderModuleOptions, "env" | "fetch"> = {}): MachineHost {
	return create({ ...settingsFromEnv(env), ...(fetch ? { fetch } : {}) }).host;
}

/** Where the sweep lists, in words: the workspace the settings name. */
export function sweepScope({ env = process.env }: Pick<RenderModuleOptions, "env"> = {}): string {
	return `the Render workspace ${settingsFromEnv(env).ownerId}`;
}
