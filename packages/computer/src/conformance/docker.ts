// Docker for the conformance CLI (`--provider docker`): the provider as fromEnv builds it, and its drifted twin, the same
// provider with a daemon of another version, built with Go for Docker's architecture when the drift case first asks.
import { dockerArch, type DockerFromEnvOptions, type DockerProvider, fromEnv } from "../docker.js";
import { buildDriftDaemon } from "./drift-daemon.js";

export interface DockerModuleOptions extends Pick<DockerFromEnvOptions, "docker" | "timeoutMs"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
}

/** The provider the CLI runs; throws in words when Docker cannot be asked its architecture, or its daemon is not built. */
export function createProvider({ env = process.env, ...options }: DockerModuleOptions = {}): Promise<DockerProvider> {
	return fromEnv(env, options);
}

/** The same provider with a daemon that reports another version, for the drift.version case. */
export async function createDriftedProvider({ env = process.env, ...options }: DockerModuleOptions = {}): Promise<DockerProvider> {
	const daemonPath = await buildDriftDaemon(await dockerArch(options));
	return fromEnv(env, { ...options, daemonPath });
}
