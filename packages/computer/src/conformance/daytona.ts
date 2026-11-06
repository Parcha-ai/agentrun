// Daytona for the conformance CLI: `--provider packages/computer/dist/conformance/daytona.js --image <snapshot>`. The
// provider's settings come from the environment, by these names alone; the key is read only when createProvider() runs.
import type { DaytonaProvider, DaytonaProviderOptions } from "../daytona.js";

/** The environment variables createProvider() reads, by name. */
export const DAYTONA_ENV = {
	/** Required: the Daytona API key. */
	key: "DAYTONA_API_KEY",
	/** Default https://app.daytona.io/api. */
	url: "DAYTONA_API_URL",
	/** Default this package's dist/computerd-linux-<arch>. */
	daemon: "AGENTRUN_DAYTONA_DAEMON",
	/** amd64 (default) or arm64: the sandboxes' architecture. */
	arch: "AGENTRUN_DAYTONA_ARCH",
	/** The Daytona target (region); default the organization's. */
	target: "AGENTRUN_DAYTONA_TARGET",
	/** container (default) or linux-vm: the class the snapshot makes. */
	sandboxClass: "AGENTRUN_DAYTONA_CLASS",
	/** uid:gid the daemon runs as; default 1000:1000. */
	user: "AGENTRUN_DAYTONA_USER",
} as const;

export interface DaytonaModuleOptions {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	fetch?: DaytonaProviderOptions["fetch"];
	webSocket?: DaytonaProviderOptions["webSocket"];
}

/** A stub until the provider is built. */
export function createProvider(_options: DaytonaModuleOptions = {}): DaytonaProvider {
	throw new Error("the Daytona module is not built yet");
}

export async function createDriftedProvider(_options: DaytonaModuleOptions = {}): Promise<DaytonaProvider> {
	throw new Error("the Daytona module is not built yet");
}
