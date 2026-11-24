// E2B for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider e2b [--image <template>]`.
// It makes real sandboxes, so it runs only with AGENTRUN_COMPUTER_LIVE_E2B=1 and a key for an account you can bill, under
// COMPUTER_E2B_API_KEY (never E2B_API_KEY, which may hold another team's key); the provider gives the SDK the key, domain
// and API URL explicitly, and refuses an ambient E2B_SANDBOX_URL (see create in ../e2b.ts). Every computer of a run
// lives at most 30 minutes, E2B Hobby's plan for conformance: E2B's timeout is the lifetime, and a longer one is refused.
// An Archil computer needs a provider whose daemon user is the tool user: COMPUTER_E2B_USER=2510:2510.
import { boxE2bTemplate } from "../box-image.js";
import { E2B } from "../descriptors/e2b.js";
import { create, type E2BOptions, type E2BProvider } from "../e2b.js";
import { type ArchilMountOptions, archilMountFor } from "./archil.js";
import { dialOnlyFromServer } from "./dial-only.js";
import { type Env, type HostedModuleOptions, hostedModule, kindFrom, lifetimeFromEnv, requiredSecret, setOptions } from "./module-kit.js";

export { CONFORMANCE_MAX_LIFETIME_MS } from "./module-kit.js";

/** The Archil disk's settings for the mount cases, by name (COMPUTER_ARCHIL_*: all five, or none). */
export { ARCHIL_ENV } from "./archil.js";

export const E2B_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_E2B",
	/** The template every computer of the run starts from. */
	template: "COMPUTER_E2B_TEMPLATE",
	/** apiKey, required: the E2B API key. */
	key: "COMPUTER_E2B_API_KEY",
	/** domain: E2B's domain. */
	domain: "COMPUTER_E2B_DOMAIN",
	/** daemonPath: the daemon binary. */
	daemon: "COMPUTER_E2B_DAEMON",
	/** kind: desktop (default) or linux. */
	kind: "COMPUTER_E2B_KIND",
	/** maxLifetimeMs: the cap, in ms, 3600000 (Hobby, default) up to 86400000 (Pro); a run takes it when it is under 30 minutes, else 30 minutes. */
	maxLifetimeMs: "COMPUTER_E2B_MAX_LIFETIME_MS",
	/** daemonUser: uid:gid the daemon runs as. */
	user: "COMPUTER_E2B_USER",
	/** connect: exec (default) or dial, which needs the public server's process (dialKit). */
	connect: "COMPUTER_E2B_CONNECT",
} as const;

export const ENV = E2B_ENV;

/** What this module reads from the environment: the key, and each other option whose name is set. */
export type E2BSettings = Omit<E2BOptions, "Sandbox" | "desktop" | "timeouts" | "probeTargets">;

/**
 * The provider's options this module reads from env, each only when its name is set; throws in words without the key,
 * on a value it cannot read, or while E2B_SANDBOX_URL is set there (the SDK would send every sandbox call to it), never
 * echoing a key.
 */
export function settingsFromEnv(env: Env = process.env): E2BSettings {
	const apiKey = requiredSecret(env, E2B_ENV.key, "an E2B API key");
	if (env.E2B_SANDBOX_URL) throw new Error("the E2B provider refuses to start while E2B_SANDBOX_URL is set: the SDK would send every call into a sandbox there. Unset it");
	const lifetime = lifetimeFromEnv(env, E2B_ENV.maxLifetimeMs, "3600000 (Hobby) or 86400000 (Pro)");
	const set = setOptions(env, { connect: E2B_ENV.connect, domain: E2B_ENV.domain, daemonPath: E2B_ENV.daemon, daemonUser: E2B_ENV.user });
	return { apiKey, ...(set as Pick<E2BSettings, "connect" | "domain" | "daemonPath" | "daemonUser">), ...kindFrom(env, E2B_ENV.kind), ...lifetime };
}

export const conformanceNotes: string[] = [
	"e2b: E2B Hobby plan: every sandbox's timeout is its lifetime, capped at 30 minutes for the run (Hobby caps a sandbox at 1 h, Pro at 24 h). The daemon is a child of E2B's envd, started as a background command; network none is no internet access and no public traffic, read back from E2B and probed from inside; no stream() (a screen is streamed through agentrun, never a vendor URL), so screen.stream is skipped.",
];

export interface E2BModuleOptions extends HostedModuleOptions, Pick<E2BOptions, "Sandbox" | "daemonPath" | "timeouts" | "onNote" | "dial">, ArchilMountOptions {}

const e2b = hostedModule<E2BModuleOptions, E2BSettings, E2BProvider>({
	live: { name: E2B_ENV.live, what: "the E2B conformance module makes real sandboxes", whose: "a key for an account you can bill" },
	settingsFromEnv,
	create,
	host: ["Sandbox"],
	run: ["timeouts", "onNote", "dial"],
	runDefined: ["daemonPath"],
});

export const { createProvider, createDriftedProvider, createHost } = e2b;

/**
 * The conformance run's own default templates, E2B's stock ones: E2B Desktop's, and its plain one for kind linux. A server
 * starts from the box template (the provider's prepareImage); a run on it names it with --image.
 */
const DESKTOP_TEMPLATE = "desktop";
const BASE_TEMPLATE = "base";

/**
 * The template every computer of the run starts from: COMPUTER_E2B_TEMPLATE; else on dial the box template, since only the
 * box image holds agentrun-dial; else E2B Desktop's (the plain one for kind linux).
 */
export function conformanceImage({ env = process.env }: Pick<E2BModuleOptions, "env"> = {}): string {
	const named = env[E2B_ENV.template];
	if (named) return named;
	if (env[E2B_ENV.connect] === "dial") return boxE2bTemplate();
	return env[E2B_ENV.kind] === "linux" ? BASE_TEMPLATE : DESKTOP_TEMPLATE;
}

export const dialKit = dialOnlyFromServer(E2B, `${E2B_ENV.connect}=dial`);

export const mountFor = archilMountFor(e2b.live);
