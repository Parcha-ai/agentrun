// Northflank for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider northflank`. It
// makes real services, which bill while they run, so it runs only with AGENTRUN_COMPUTER_LIVE_NORTHFLANK=1 and your own
// token, under COMPUTER_NORTHFLANK_TOKEN (never NORTHFLANK_API_TOKEN or NF_API_TOKEN, which may hold another team's),
// with your project under COMPUTER_NORTHFLANK_PROJECT_ID (never NORTHFLANK_PROJECT_ID, which Northflank sets inside its
// own services). Every computer of a run has a deadline of at most 30 minutes, which the janitor keeps.
import { boxImageRef } from "../box-image.js";
import { httpsBase } from "../hosted/rest.js";
import { create, DEFAULT_API_URL, type NorthflankProvider, type NorthflankProviderOptions } from "../northflank.js";
import { type Env, type HostedModuleOptions, hostedModule, keyPrint, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const NORTHFLANK_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_NORTHFLANK",
	/** token, required: a Northflank API token that may manage services and run commands in the project. */
	key: "COMPUTER_NORTHFLANK_TOKEN",
	/** projectId, required: your project the run's services live in. */
	project: "COMPUTER_NORTHFLANK_PROJECT_ID",
	/** teamId: the team, for an organisation token alone. */
	team: "COMPUTER_NORTHFLANK_TEAM_ID",
	/** apiUrl: the API's root; default https://api.northflank.com. */
	apiUrl: "COMPUTER_NORTHFLANK_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_NORTHFLANK_DAEMON",
	/** The image every computer of the run starts from; default the box image's public tag. */
	image: "COMPUTER_NORTHFLANK_IMAGE",
} as const;

export const ENV = NORTHFLANK_ENV;

export type NorthflankSettings = Pick<NorthflankProviderOptions, "token" | "projectId" | "teamId" | "apiUrl" | "daemonPath">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the token or the project, never echoing the token. */
export function settingsFromEnv(env: Env = process.env): NorthflankSettings {
	return {
		token: requiredSecret(env, NORTHFLANK_ENV.key, "a Northflank API token"),
		projectId: requiredSecret(env, NORTHFLANK_ENV.project, "the id of your Northflank project"),
		...setOptions(env, { teamId: NORTHFLANK_ENV.team, apiUrl: NORTHFLANK_ENV.apiUrl, daemonPath: NORTHFLANK_ENV.daemon }),
	};
}

export const conformanceNotes: string[] = [
	"northflank: every computer is a Northflank service (a Kata microVM on Northflank Cloud, amd64 unverified) in your project, from the box image, its command sleep infinity; the daemon is a child of a command on the command-exec WebSocket under the pid wrapper, its stdio the socket's latin1 text messages; labels are packed into the workload's annotations; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run, with the service's expiry at the backstop. Network none, open and a list are init's. No Archil mount and no desktop.",
];

export interface NorthflankModuleOptions extends HostedModuleOptions, Pick<NorthflankProviderOptions, "fetch" | "webSocket" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<NorthflankModuleOptions, NorthflankSettings, NorthflankProvider>({
	live: { name: NORTHFLANK_ENV.live, what: "the Northflank conformance module makes real services, which bill while they run", whose: "your own token and project" },
	settingsFromEnv,
	create,
	host: ["fetch", "webSocket", "daemonPath", "timeouts"],
	run: ["onNote"],
	// The project (and team), the token named by its sha256 prefix alone.
	scope: ({ token, projectId, teamId, apiUrl }) => `the Northflank project ${projectId}${teamId === undefined ? "" : ` of team ${teamId}`} at ${httpsBase(apiUrl ?? DEFAULT_API_URL, `the Northflank API URL (${NORTHFLANK_ENV.apiUrl})`)}, by the token ${keyPrint(token)}`,
});

/** The image every computer of the run starts from: COMPUTER_NORTHFLANK_IMAGE, else the box image's public tag. */
export async function conformanceImage({ env = process.env }: Pick<NorthflankModuleOptions, "env"> = {}): Promise<string> {
	return env[NORTHFLANK_ENV.image] || boxImageRef();
}
