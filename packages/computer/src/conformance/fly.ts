// Fly Machines for the conformance run. Its machines dial the server that minted their tokens (facts.connect "dial"), so
// a Core run has to happen inside that server's own process, behind its public address: serve's
// packages/serve/scripts/dial-conformance.mjs --provider fly does it: it gives createProvider() its dial (the public
// URL, the minted tokens and the attach hub) and the run a DialKit over the same server. From a laptop's CLI there is no
// such server: dialKit() refuses in words, and the provider refuses every create before Fly is called.
//
// The provider reads no environment: this module reads its own COMPUTER_FLY_* names (never FLY_API_TOKEN, which may
// hold a production token) and passes each to create() as its option. The live sweep (sweep.ts, --provider fly) reads
// the same names through createHost, which makes nothing.
import type { HostedDial } from "../hosted/provider.js";
import { boxImageRef } from "../box-image.js";
import { create, type FlyProvider } from "../fly.js";
import type { MachineHost } from "../host.js";
import type { ProviderNote } from "../mount-archil.js";
import type { DialKit } from "./types.js";

/** The environment this module reads, by name, each for the option its comment names. */
export const FLY_ENV = {
	/** apiToken, required: a Fly API token that may make machines in the app. */
	token: "COMPUTER_FLY_API_TOKEN",
	/** app, required: the Fly app the run's machines live in. */
	app: "COMPUTER_FLY_APP",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = FLY_ENV;

/** The longest lifetime a computer of a run may ask for: init's deadline and the janitor end each machine by then. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

/** The provider's options this module reads from env; throws in words without the token or the app, never echoing one. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): { apiToken: string; app: string } {
	const apiToken = env[FLY_ENV.token];
	const app = env[FLY_ENV.app];
	if (!apiToken || !app) throw new Error(`the Fly conformance module needs ${FLY_ENV.token} and ${FLY_ENV.app}: it takes a token from that name only, never FLY_API_TOKEN`);
	return { apiToken, app };
}

export interface FlyModuleOptions {
	/** The environment to read; process.env by default. */
	env?: Record<string, string | undefined>;
	/** The server the machines dial: dial-conformance.mjs gives its own. Without it every create is refused in words. */
	dial?: HostedDial;
	/** The daemon the server serves (its sha256 is what a machine checks); default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** The fetch Fly's calls go through; default the global one. */
	fetch?: typeof fetch;
	/** What the provider says that is no failure: the CLI gives it and puts it in the report. */
	onNote?: ProviderNote;
}

/** The provider the run makes computers with, dialing the server options.dial names. */
export function createProvider({ env = process.env, dial, daemonPath, fetch, onNote }: FlyModuleOptions = {}): FlyProvider {
	return create({
		...settingsFromEnv(env),
		...(dial ? { dial } : {}),
		...(daemonPath === undefined ? {} : { daemonPath }),
		...(fetch ? { fetch } : {}),
		...(onNote ? { onNote } : {}),
		maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS,
	});
}

/** The run's image: the box image the release publishes, whose CMD runs agentrun-dial (box-image.ts). */
export function conformanceImage(): string {
	return boxImageRef();
}

/**
 * The server the run's machines dial, for provider.dial-token, as the CLI asks for it: refused in words. A Fly machine
 * dials the server that minted its token, so the run can't happen from a CLI whose server the internet doesn't reach;
 * dial-conformance.mjs stands that server up and gives the run its DialKit itself.
 */
export function dialKit(): DialKit {
	throw new Error("a Fly machine dials the server that minted its token, and this run has no public server: run Fly's Core with packages/serve/scripts/dial-conformance.mjs --provider fly inside a server the internet reaches at AGENTRUN_PUBLIC_URL");
}

/** The Fly host the live sweep lists and deletes through, from the same settings; it makes nothing. */
export function createHost({ env = process.env, fetch }: Pick<FlyModuleOptions, "env" | "fetch"> = {}): MachineHost {
	return create({ ...settingsFromEnv(env), ...(fetch ? { fetch } : {}) }).host;
}

/** Where the sweep lists, in words: the app the settings name. */
export function sweepScope({ env = process.env }: Pick<FlyModuleOptions, "env"> = {}): string {
	return `the Fly app ${settingsFromEnv(env).app}`;
}
