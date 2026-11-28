// Vercel Sandbox for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider vercel`. It
// makes real sandboxes, which bill while they run, so it runs only with AGENTRUN_COMPUTER_LIVE_VERCEL=1 and your own
// token, under COMPUTER_VERCEL_TOKEN (never VERCEL_TOKEN, which may hold another team's), with the team and project
// under COMPUTER_VERCEL_TEAM_ID and COMPUTER_VERCEL_PROJECT_ID. Every computer of a run lives at most 30 minutes.
import { type VercelProvider, type VercelProviderOptions, boxVercelImage, create } from "../vercel.js";
import { type Env, type HostedModuleOptions, hostedModule, keyPrint, requiredSecret } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const VERCEL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_VERCEL",
	/** token, required: a Vercel access token of the team. */
	key: "COMPUTER_VERCEL_TOKEN",
	/** teamId, required. */
	team: "COMPUTER_VERCEL_TEAM_ID",
	/** projectId, required: the project whose registry holds the box image. */
	project: "COMPUTER_VERCEL_PROJECT_ID",
	/** The image every computer of the run starts from; default the box image (boxVercelImage). */
	image: "COMPUTER_VERCEL_IMAGE",
} as const;

export const ENV = VERCEL_ENV;

/** The provider's options this module reads from env; throws in words without one, never echoing the token. */
export function settingsFromEnv(env: Env = process.env): Pick<VercelProviderOptions, "token" | "teamId" | "projectId"> {
	return {
		token: requiredSecret(env, VERCEL_ENV.key, "a Vercel access token"),
		teamId: requiredSecret(env, VERCEL_ENV.team, "the Vercel team id"),
		projectId: requiredSecret(env, VERCEL_ENV.project, "the Vercel project id"),
	};
}

export const conformanceNotes: string[] = [
	"vercel: every computer is a Vercel Sandbox (a Firecracker microVM, amd64) made with persistent false and its session timeout at the computer's lifetime; the daemon is a child of a detached command, its stdio the command's log stream and a stdin write per call; labels are packed into its 5 tags; lifetime is Vercel's timer, capped at 30 minutes for the run. Network none, open and a list are init's (vendor deny-all on none). No mount and no desktop.",
];

export interface VercelModuleOptions extends HostedModuleOptions, Pick<VercelProviderOptions, "fetch" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<VercelModuleOptions, Pick<VercelProviderOptions, "token" | "teamId" | "projectId">, VercelProvider>({
	live: { name: VERCEL_ENV.live, what: "the Vercel conformance module makes real sandboxes, which bill while they run", whose: "your own token" },
	settingsFromEnv,
	create,
	host: ["fetch", "daemonPath", "timeouts"],
	run: ["onNote"],
	// The project of the team, the token named by its sha256 prefix alone.
	scope: ({ token, teamId, projectId }) => `the Vercel project ${projectId} of team ${teamId}, by the token ${keyPrint(token)}`,
});

/** The image every computer of the run starts from: COMPUTER_VERCEL_IMAGE, else the box image prepareImage() answers. */
export async function conformanceImage({ env = process.env }: Pick<VercelModuleOptions, "env"> = {}): Promise<string> {
	return env[VERCEL_ENV.image] || boxVercelImage();
}
