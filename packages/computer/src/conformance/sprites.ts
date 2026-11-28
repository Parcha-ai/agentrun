// Fly Sprites for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider sprites`. It makes
// real sprites, which bill while they run and live until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_SPRITES=1
// and your own token, under COMPUTER_SPRITES_TOKEN (never SPRITES_TOKEN, which may hold another org's). Every computer
// of a run has a deadline of at most 30 minutes, which the janitor keeps.
import { httpsBase } from "../hosted/rest.js";
import { SPRITES_IMAGE } from "../descriptors/sprites.js";
import { create, DEFAULT_API_URL, type SpritesProvider, type SpritesProviderOptions } from "../sprites.js";
import { type Env, type HostedModuleOptions, hostedModule, keyPrint, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const SPRITES_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_SPRITES",
	/** token, required: a Sprites API token. */
	key: "COMPUTER_SPRITES_TOKEN",
	/** apiUrl: the API's root; default https://api.sprites.dev. */
	apiUrl: "COMPUTER_SPRITES_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_SPRITES_DAEMON",
} as const;

export const ENV = SPRITES_ENV;

export type SpritesSettings = Pick<SpritesProviderOptions, "token" | "apiUrl" | "daemonPath">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the token, never echoing it. */
export function settingsFromEnv(env: Env = process.env): SpritesSettings {
	const token = requiredSecret(env, SPRITES_ENV.key, "a Sprites API token");
	return { token, ...setOptions(env, { apiUrl: SPRITES_ENV.apiUrl, daemonPath: SPRITES_ENV.daemon }) };
}

export const conformanceNotes: string[] = [
	"sprites: every computer is a Fly sprite (a Firecracker microVM, amd64 unverified) from Fly's own Ubuntu image; the daemon is a child of a command on the exec WebSocket, its stdio the socket's binary frames, its kill the session's kill call; labels are packed into the sprite's name=value strings; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run. Network none, open and a list are init's. No Archil mount and no desktop.",
];

export interface SpritesModuleOptions extends HostedModuleOptions, Pick<SpritesProviderOptions, "fetch" | "webSocket" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<SpritesModuleOptions, SpritesSettings, SpritesProvider>({
	live: { name: SPRITES_ENV.live, what: "the Sprites conformance module makes real sprites, which bill while they run", whose: "your own token" },
	settingsFromEnv,
	create,
	host: ["fetch", "webSocket", "daemonPath", "timeouts"],
	run: ["onNote"],
	// The token's org, the token named by its sha256 prefix alone.
	scope: ({ token, apiUrl }) => `the Sprites org of the token ${keyPrint(token)} at ${httpsBase(apiUrl ?? DEFAULT_API_URL, `the Sprites API URL (${SPRITES_ENV.apiUrl})`)}`,
});

/** The image every computer of the run starts from: Fly's own, the only one. */
export async function conformanceImage(_options: Pick<SpritesModuleOptions, "env"> = {}): Promise<string> {
	return SPRITES_IMAGE;
}
