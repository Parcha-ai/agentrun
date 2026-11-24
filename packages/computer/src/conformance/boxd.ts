// boxd for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider boxd [--image <snapshot>]`.
// It makes real machines, so it runs only with AGENTRUN_COMPUTER_LIVE_BOXD=1 and your own key, under
// COMPUTER_BOXD_API_KEY (never BOXD_API_KEY, which may hold another account's key). Every computer of a run has a
// deadline of at most 30 minutes, and the runner sweeps the run's computers by its label when it ends.
import { type BoxdOptions, type BoxdProvider, create } from "../boxd.js";
import { BOXD_DEFAULT_IMAGE } from "../descriptors/boxd.js";
import { type Env, type HostedModuleOptions, hostedModule, keyPrint, kindFrom, preparedImage, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

export const BOXD_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_BOXD",
	/** The image every computer of the run starts from: "default" (boxd's own), or a snapshot's name; unset, a desktop's is the desktop snapshot. */
	image: "COMPUTER_BOXD_IMAGE",
	/** apiKey, required: the boxd API key. */
	key: "COMPUTER_BOXD_API_KEY",
	/** org: the org machines are made in; default the key's own. */
	org: "COMPUTER_BOXD_ORG",
	/** region: fra, nyc, ...; default the API's home region. */
	region: "COMPUTER_BOXD_REGION",
	/** daemonPath: the daemon binary. */
	daemon: "COMPUTER_BOXD_DAEMON",
	/** kind: linux (default) or desktop. */
	kind: "COMPUTER_BOXD_KIND",
	/** daemonUser: uid:gid the daemon runs as. */
	user: "COMPUTER_BOXD_USER",
} as const;

export const ENV = BOXD_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type BoxdSettings = Pick<BoxdOptions, "apiKey" | "org" | "region" | "daemonPath" | "kind" | "daemonUser">;

/** The provider's options this module reads from env, each only when its name is set; throws in words without the key, never echoing it. */
export function settingsFromEnv(env: Env = process.env): BoxdSettings {
	const apiKey = requiredSecret(env, BOXD_ENV.key, "a boxd API key");
	return { apiKey, ...setOptions(env, { org: BOXD_ENV.org, region: BOXD_ENV.region, daemonPath: BOXD_ENV.daemon, daemonUser: BOXD_ENV.user }), ...kindFrom(env, BOXD_ENV.kind) };
}

export const conformanceNotes: string[] = [
	"boxd: every computer is an isolated boxd machine with the egress allowlist none, no standby and no hibernation; the daemon is a child of boxd's own agent, started as a detached root command; lifetime is the janitor's, by the deadline label, capped at 30 minutes for the run; no stream() (a screen is streamed through agentrun), so screen.stream is skipped. Kind desktop (COMPUTER_BOXD_KIND=desktop) starts from agentrun-desktop-<recipe hash>, boxd's own image with Xfce's text editor added, a snapshot the run's provider finds or builds in the key's org first (prepareImage), with Xvfb on :0 started through the daemon as the tool user.",
];

export interface BoxdModuleOptions extends HostedModuleOptions, Pick<BoxdOptions, "Boxd" | "daemonPath" | "timeouts" | "onNote"> {}

export const { createProvider, createDriftedProvider, createHost, sweepScope } = hostedModule<BoxdModuleOptions, BoxdSettings, BoxdProvider>({
	live: { name: BOXD_ENV.live, what: "the boxd conformance module makes real machines", whose: "your own key" },
	settingsFromEnv,
	create,
	host: ["Boxd"],
	run: ["timeouts", "onNote"],
	runDefined: ["daemonPath"],
	// A before file listed with another key, org or region would make every computer there read as new, so the sweep refuses it.
	scope: ({ apiKey, org, region }) => `the boxd org ${org ?? "of the key"} in the region ${region ?? "home"}, with the key ${keyPrint(apiKey)}`,
});

/**
 * The image every computer of the run starts from: COMPUTER_BOXD_IMAGE, else boxd's own, else for kind desktop the
 * desktop snapshot, which the run's provider finds or builds in the key's org first (prepareImage, live).
 */
export async function conformanceImage(options: BoxdModuleOptions = {}, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
	const { env = process.env } = options;
	const named = env[BOXD_ENV.image];
	if (named) return named;
	if (env[BOXD_ENV.kind] !== "desktop") return BOXD_DEFAULT_IMAGE;
	return preparedImage(await createProvider(options), signal);
}
