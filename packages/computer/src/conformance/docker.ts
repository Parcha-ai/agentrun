// Docker for the conformance CLI (`--provider docker`): the provider as create() builds it from the settings this module
// reads (COMPUTER_DOCKER_DAEMON, COMPUTER_DOCKER_DAEMON_CACHE, COMPUTER_DOCKER_USER), and its drifted twin, the same
// provider with a daemon of another version, built with Go for Docker's architecture when the drift case first asks. The
// provider reads no environment: this module reads these names and passes them in as options. With desktop, both are
// desktops (kind desktop) on an image with an X server, such as test/fixtures/desktop/Dockerfile's. For the mount cases,
// mountFor("bind") makes a run folder on this host, owned by the computer's user.
import { chownSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, type DockerCreateOptions, dockerArch, type DockerProvider } from "../docker.js";
import type { MountKind } from "../mount.js";
import { buildDriftDaemon } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

/** The environment this module reads, by name. */
export const DOCKER_ENV = {
	/** The daemon binary for Docker's architecture; default this package's dist/computerd-linux-<arch>. */
	daemon: "COMPUTER_DOCKER_DAEMON",
	/** The directory of the provider's 0755 copy of the daemon; default ~/.cache/agentrun-computer. See DockerProviderOptions.daemonCache. */
	daemonCache: "COMPUTER_DOCKER_DAEMON_CACHE",
	/** Who a computer runs as when its spec does not say, uid or uid:gid in numbers; see DockerProviderOptions.user. */
	user: "COMPUTER_DOCKER_USER",
} as const;

/** The names this module reads, under the conformance modules' common name (ConformanceModule.ENV). */
export const ENV = DOCKER_ENV;

/** The provider's options this module reads from env, each only when its name is set. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): DockerCreateOptions {
	return {
		...(env[DOCKER_ENV.daemon] ? { daemonPath: env[DOCKER_ENV.daemon] } : {}),
		...(env[DOCKER_ENV.daemonCache] ? { daemonCache: env[DOCKER_ENV.daemonCache] } : {}),
		...(env[DOCKER_ENV.user] ? { user: env[DOCKER_ENV.user] } : {}),
	};
}

export interface DockerModuleOptions extends Pick<DockerCreateOptions, "docker" | "timeoutMs" | "desktop"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
}

/** The provider the CLI runs; throws in words when Docker cannot be asked its architecture, or its daemon is not built. */
export function createProvider({ env = process.env, ...options }: DockerModuleOptions = {}): Promise<DockerProvider> {
	return create({ ...settingsFromEnv(env), ...options });
}

/** The same provider with a daemon that reports another version, for the drift.version case. */
export async function createDriftedProvider({ env = process.env, ...options }: DockerModuleOptions = {}): Promise<DockerProvider> {
	const daemonPath = await buildDriftDaemon(await dockerArch(options));
	return create({ ...settingsFromEnv(env), ...options, daemonPath });
}

/**
 * A run folder for a bind, and none for any other kind: a new directory under the temp dir, by its canonical path, owned
 * by the computer's user (the provider's, as createProvider builds it) as the provider requires. This process owns it
 * already when it is that user; as root, it gives the folder to that user, as a caller does: the provider never changes
 * the folder. The runner closes it when its case ends.
 */
export async function mountFor(kind: MountKind, { env = process.env, ...options }: DockerModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "bind") return undefined;
	const { user } = await createProvider({ env, ...options });
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "computer-run-")));
	const [uid = -1, gid = -1] = user.split(":").map(Number);
	if (process.getuid?.() === 0) chownSync(dir, uid, gid);
	return {
		mount: { kind: "bind", path: dir },
		read: async (path) => {
			try {
				return await readFile(join(dir, path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		write: (path, data) => writeFile(join(dir, path), data, { mode: 0o644 }),
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
