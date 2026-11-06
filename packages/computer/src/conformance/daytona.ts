// Daytona for the conformance CLI: `--provider packages/computer/dist/conformance/daytona.js [--image <snapshot>]`. The
// provider's settings come from the environment, by these names alone; the key is read only when createProvider() runs.
// Every sandbox of a run has a bounded life besides its TTL: Daytona stops one after 30 minutes with no outside activity
// and deletes it as soon as it stops, so a stop deletes (see conformanceNotes).
// Every name is COMPUTER_DAYTONA_*: a bare DAYTONA_API_KEY may hold another organization's key on a host that runs other
// Daytona work, so it is never read here, not even as a fallback.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAYTONA_DEFAULT_SNAPSHOT, DaytonaProvider, type DaytonaProviderOptions } from "../daytona.js";

/** The environment variables createProvider() reads, by name. */
export const DAYTONA_ENV = {
	/** Required: the Daytona API key. */
	key: "COMPUTER_DAYTONA_API_KEY",
	/** Default https://app.daytona.io/api. */
	url: "COMPUTER_DAYTONA_API_URL",
	/** Default this package's dist/computerd-linux-<arch>. */
	daemon: "COMPUTER_DAYTONA_DAEMON",
	/** amd64 (default) or arm64: the sandboxes' architecture. */
	arch: "COMPUTER_DAYTONA_ARCH",
	/** The Daytona target (region); default the organization's. */
	target: "COMPUTER_DAYTONA_TARGET",
	/** container (default) or linux-vm: the class the snapshot makes. */
	sandboxClass: "COMPUTER_DAYTONA_CLASS",
	/** uid:gid the daemon runs as; default 1000:1000. */
	user: "COMPUTER_DAYTONA_USER",
	/** The snapshot every computer of the run starts from; default "default", Daytona's default snapshot. */
	snapshot: "COMPUTER_DAYTONA_SNAPSHOT",
} as const;

/** Minutes without outside activity before Daytona stops a run's sandbox: at most 30, so none outlives a run for long. */
export const CONFORMANCE_AUTO_STOP_MINUTES = 30;
/** Minutes a run's sandbox may stay stopped: 0, Daytona deletes it as soon as it stops. */
export const CONFORMANCE_AUTO_DELETE_MINUTES = 0;

/**
 * For the run's report: what this configuration means for the suite. The provider has no capability that says it keeps
 * no stopped computer, so the note says it.
 */
export const conformanceNotes: string[] = [
	`daytona: every sandbox runs with autoStopMinutes ${CONFORMANCE_AUTO_STOP_MINUTES} and autoDeleteMinutes ${CONFORMANCE_AUTO_DELETE_MINUTES}, besides its TTL: Daytona deletes a sandbox as soon as it stops, so this configuration keeps no stopped computer. Core provider.stop is expected to fail (a stopped computer is gone, not listed as stopped); Full provider.janitor is skipped, the lifetime being vendor, and would fail for the same reason.`,
];

export interface DaytonaModuleOptions {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
	fetch?: DaytonaProviderOptions["fetch"];
	webSocket?: DaytonaProviderOptions["webSocket"];
}

function optionsOf({ env = process.env, fetch, webSocket }: DaytonaModuleOptions): DaytonaProviderOptions {
	const apiKey = env[DAYTONA_ENV.key];
	if (apiKey === undefined || apiKey === "") throw new Error(`set ${DAYTONA_ENV.key} to a Daytona API key: the Daytona provider reads it there and nowhere else, never from DAYTONA_API_KEY`);
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
		autoStopMinutes: CONFORMANCE_AUTO_STOP_MINUTES,
		autoDeleteMinutes: CONFORMANCE_AUTO_DELETE_MINUTES,
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

/** The image every computer of the run starts from: COMPUTER_DAYTONA_SNAPSHOT, or Daytona's default snapshot. */
export function conformanceImage({ env = process.env }: Pick<DaytonaModuleOptions, "env"> = {}): string {
	return env[DAYTONA_ENV.snapshot] || DAYTONA_DEFAULT_SNAPSHOT;
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
