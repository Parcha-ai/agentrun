// Agent37 for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider agent37`.
// It makes real instances, which bill per minute until deleted, so it runs only with AGENTRUN_COMPUTER_LIVE_AGENT37=1
// and a key for an account you can bill, under COMPUTER_AGENT37_API_KEY (never AGENT37_API_KEY, which may hold another
// team's key). Agent37 never ends an instance on its own: every computer of a run lives at most 30 minutes, by init's
// deadline and the janitor's label, and the run's sweep deletes what is left. An Archil computer (mountFor("archil"),
// ./archil.ts) needs a provider whose daemon user is the tool user: COMPUTER_AGENT37_USER=2510:2510, the default.
import { type Agent37Options, type Agent37Provider, create, workspaceOf } from "../agent37.js";
import { AGENT37_BASE_TEMPLATE } from "../descriptors/agent37.js";
import { type ArchilMountOptions, archilMountFor } from "./archil.js";
import { type Env, type HostedModuleOptions, hostedModule, kindFrom, lifetimeFromEnv, preparedImage, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

export const AGENT37_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_AGENT37",
	/** The template every computer of the run starts from; default agent37-base, or the box template for kind desktop. */
	template: "COMPUTER_AGENT37_TEMPLATE",
	/** kind: linux (default) or desktop. */
	kind: "COMPUTER_AGENT37_KIND",
	/** apiKey, required: the workspace's API key. */
	key: "COMPUTER_AGENT37_API_KEY",
	/** sshKey, required: the private SSH key registered on the workspace, its contents. */
	sshKey: "COMPUTER_AGENT37_SSH_KEY",
	/** type: vm (default) or default. */
	type: "COMPUTER_AGENT37_TYPE",
	/** region: us (default), eu or ap-south. */
	region: "COMPUTER_AGENT37_REGION",
	/** apiUrl: Agent37's REST API; default https://api.agent37.com. */
	apiUrl: "COMPUTER_AGENT37_API_URL",
	/** daemonPath: the daemon binary; default this package's dist/computerd-linux-amd64. */
	daemon: "COMPUTER_AGENT37_DAEMON",
	/** maxLifetimeMs: the cap, in ms, at most 86400000; a run takes it when it is under 30 minutes, else 30 minutes. */
	maxLifetimeMs: "COMPUTER_AGENT37_MAX_LIFETIME_MS",
	/** daemonUser: uid:gid the daemon runs as; default 2510:2510. */
	user: "COMPUTER_AGENT37_USER",
} as const;

export const ENV = AGENT37_ENV;

/** What this module reads from the environment: the keys, and each other option whose name is set. */
export type Agent37Settings = Omit<Agent37Options, "ssh2" | "fetch" | "WebSocket" | "timeouts" | "probeTargets" | "proxyDomain">;

/**
 * The provider's options this module reads from env, each only when its name is set; throws in words without a key,
 * or on a value it cannot read, never echoing a key.
 */
export function settingsFromEnv(env: Env = process.env): Agent37Settings {
	const apiKey = requiredSecret(env, AGENT37_ENV.key, "an Agent37 API key");
	const sshKey = env[AGENT37_ENV.sshKey];
	if (sshKey === undefined || sshKey === "") throw new Error(`set ${AGENT37_ENV.sshKey} to the private SSH key registered on the Agent37 workspace (its contents, never a path)`);
	const lifetime = lifetimeFromEnv(env, AGENT37_ENV.maxLifetimeMs, "86400000");
	const set = setOptions(env, { type: AGENT37_ENV.type, region: AGENT37_ENV.region, apiUrl: AGENT37_ENV.apiUrl, daemonPath: AGENT37_ENV.daemon, daemonUser: AGENT37_ENV.user });
	return { apiKey, sshKey, ...(set as Pick<Agent37Settings, "type" | "region" | "apiUrl" | "daemonPath" | "daemonUser">), ...kindFrom(env, AGENT37_ENV.kind), ...lifetime };
}

export const conformanceNotes: string[] = [
	"agent37: every computer is an instance (type vm by default), made with network deny-all, auto-sleep off and no public port, read back from Agent37 and probed from inside; the daemon is a child, started over SSH through the platform's sshd (port 22022; it and the platform's web terminal on 7681 are declared as the vendor's agent), and every command goes over that SSH as root. Agent37 never ends an instance on its own: lifetime janitor, capped at 30 minutes for the run. No stream() (a screen is streamed through agentrun), so screen.stream is skipped. Kind desktop (COMPUTER_AGENT37_KIND=desktop) starts from agentrun-box-<recipe hash>, our box image registered as a template of the key's workspace (prepareImage), with Xvfb on :0 started through the daemon as the tool user.",
];

export interface Agent37ModuleOptions extends HostedModuleOptions, Pick<Agent37Options, "ssh2" | "fetch" | "WebSocket" | "daemonPath" | "timeouts" | "onNote">, ArchilMountOptions {}

const agent37 = hostedModule<Agent37ModuleOptions, Agent37Settings, Agent37Provider>({
	live: { name: AGENT37_ENV.live, what: "the Agent37 conformance module makes real instances, which bill until deleted", whose: "a key for an account you can bill" },
	settingsFromEnv,
	create,
	host: ["ssh2", "fetch", "WebSocket", "timeouts", "onNote"],
	run: [],
	runDefined: ["daemonPath"],
	// One key is one workspace, and one listing covers all of it, every region and type (docs: instances/list).
	scope: ({ apiKey, apiUrl }) => workspaceOf(apiKey, apiUrl),
});

export const { createProvider, createDriftedProvider, createHost, sweepScope } = agent37;

/**
 * The template every computer of the run starts from: COMPUTER_AGENT37_TEMPLATE, else agent37-base, else for kind
 * desktop the box template, which the run's provider registers in the key's workspace first (prepareImage, live).
 */
export async function conformanceImage(options: Agent37ModuleOptions = {}, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
	const { env = process.env } = options;
	const named = env[AGENT37_ENV.template];
	if (named) return named;
	if (env[AGENT37_ENV.kind] !== "desktop") return AGENT37_BASE_TEMPLATE;
	return preparedImage(await createProvider(options), signal, "the Agent37 box template");
}

export const mountFor = archilMountFor(agent37.live);
