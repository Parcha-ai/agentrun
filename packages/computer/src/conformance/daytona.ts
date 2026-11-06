// Daytona for the conformance CLI: `--provider packages/computer/dist/conformance/daytona.js --image <snapshot>`. The
// provider's settings come from the environment, by these names alone; the key is read only when createProvider() runs.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaytonaProvider, type DaytonaProviderOptions } from "../daytona.js";

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

function optionsOf({ env = process.env, fetch, webSocket }: DaytonaModuleOptions): DaytonaProviderOptions {
	const apiKey = env[DAYTONA_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${DAYTONA_ENV.key} to a Daytona API key: the Daytona provider reads it there and nowhere else`);
	const arch = env[DAYTONA_ENV.arch] || "amd64";
	if (arch !== "amd64" && arch !== "arm64") throw new Error(`${DAYTONA_ENV.arch} is amd64 or arm64, not ${arch}`);
	const sandboxClass = env[DAYTONA_ENV.sandboxClass] || "container";
	if (sandboxClass !== "container" && sandboxClass !== "linux-vm") throw new Error(`${DAYTONA_ENV.sandboxClass} is container or linux-vm, not ${sandboxClass}`);
	const daemonPath = env[DAYTONA_ENV.daemon] || fileURLToPath(new URL(`../computerd-linux-${arch}`, import.meta.url));
	return {
		apiKey,
		daemonPath,
		arch,
		sandboxClass,
		...(env[DAYTONA_ENV.url] ? { apiUrl: env[DAYTONA_ENV.url] } : {}),
		...(env[DAYTONA_ENV.target] ? { target: env[DAYTONA_ENV.target] } : {}),
		...(env[DAYTONA_ENV.user] ? { daemonUser: env[DAYTONA_ENV.user] } : {}),
		...(fetch ? { fetch } : {}),
		...(webSocket ? { webSocket } : {}),
	};
}

/** Go's own settings and the target, and nothing else of this process's environment: never the key. */
function goEnv(arch: string): Record<string, string> {
	const kept = ["PATH", "HOME", "TMPDIR", "GOPATH", "GOCACHE", "GOMODCACHE", "GOFLAGS", "GOPROXY", "GOTOOLCHAIN"];
	const env: Record<string, string> = { CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch };
	for (const name of kept) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

/** The provider the CLI runs; throws in words when a setting is missing or wrong. */
export function createProvider(options: DaytonaModuleOptions = {}): DaytonaProvider {
	return new DaytonaProvider(optionsOf(options));
}

/** The same provider with a daemon that reports another version, built with Go for the drift case. */
export async function createDriftedProvider(options: DaytonaModuleOptions = {}): Promise<DaytonaProvider> {
	const settings = optionsOf(options);
	const dir = mkdtempSync(join(tmpdir(), "computer-drift-"));
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	const out = join(dir, "computerd");
	const version = new DaytonaProvider(settings).version;
	await new Promise<void>((resolve, reject) => {
		execFile(
			"go",
			["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}-drift`, "-o", out, "./cmd/computerd"],
			{ cwd: fileURLToPath(new URL("../../daemon", import.meta.url)), env: goEnv(settings.arch ?? "amd64") },
			(error, _stdout, stderr) => {
				if (!error) return resolve();
				const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "go was not found on PATH" : stderr.trim() || error.message;
				reject(new Error(`building a daemon of another version for the drift case: ${why}`));
			},
		);
	});
	chmodSync(out, 0o755);
	return new DaytonaProvider({ ...settings, daemonPath: out });
}
