// Modal for the conformance CLI: `npm run conformance -w @parcha/agentrun-computer -- --provider dist/conformance/modal.js`.
// It builds a real Modal client, so it runs only with AGENTRUN_COMPUTER_LIVE_MODAL=1 and a key the lead has OKed, under
// COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET. Never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET: a host may hold a
// production token under those names, and the SDK reads them, else the active profile of ~/.modal.toml, on its own
// (modal-client@64880502:js/src/config.ts:139-145; client.ts:123). So the client is given the COMPUTER_MODAL_ pair
// explicitly: a tokenId and tokenSecret passed to ModalClient replace what the environment or the profile held, and
// clear any OAuth credentials (client.ts:124-148).
//
// The key goes only to the server this module chooses: COMPUTER_MODAL_SERVER_URL, else the SDK's own default
// (config.ts:143). ModalClient cannot take a server explicitly: it declares `endpoint` (client.ts:51) and never reads
// it, and the control-plane client is made from the profile's serverUrl (client.ts:131, 175, 281), which getProfile
// takes from MODAL_SERVER_URL before any profile's server_url (config.ts:140-143), the profile being MODAL_PROFILE's
// or the active one in MODAL_CONFIG_PATH or ~/.modal.toml (config.ts:76-82, 126-137). So an ambient MODAL_SERVER_URL is
// refused, and the module sets MODAL_SERVER_URL to its choice only while it constructs the client, so no profile can
// redirect it. The modal package is the host's: it is imported only when a provider is made.
//
// The daemon is uploaded into each sandbox (dist/computerd-linux-amd64, `npm run build:daemon`) unless
// COMPUTER_MODAL_DAEMON_IMAGE names an image to copy it from, so a run publishes nothing. The drifted provider uploads
// a daemon built with Go as version <version>-drift. Every computer of a run lives at most 30 minutes: Modal's timeout
// is its lifetime, and a longer one is refused in words.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModalProvider, type ModalSdk } from "../modal.js";
import type { ComputerProvider } from "../provider.js";

/** The environment this module reads, by name. */
export const MODAL_ENV = {
	live: "AGENTRUN_COMPUTER_LIVE_MODAL",
	tokenId: "COMPUTER_MODAL_TOKEN_ID",
	tokenSecret: "COMPUTER_MODAL_TOKEN_SECRET",
	app: "COMPUTER_MODAL_APP",
	/** Optional: an image holding the daemon, pinned by digest, to COPY --from instead of uploading it. */
	daemonImage: "COMPUTER_MODAL_DAEMON_IMAGE",
	/** The server the key goes to; the SDK's default when unset. */
	serverUrl: "COMPUTER_MODAL_SERVER_URL",
} as const;

/** The longest lifetime a computer of a run may ask for: Modal ends each sandbox at its timeout, the lifetime. */
export const CONFORMANCE_MAX_LIFETIME_MS = 30 * 60_000;

const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** The SDK's default server (modal-client@64880502:js/src/config.ts:143). */
const MODAL_DEFAULT_SERVER_URL = "https://api.modal.com:443";

/** The server the key goes to: COMPUTER_MODAL_SERVER_URL, else the SDK's default. */
export const modalServerUrl = (env: Record<string, string | undefined> = process.env): string => env[MODAL_ENV.serverUrl] || MODAL_DEFAULT_SERVER_URL;

/** What this module gives the SDK's ModalClient: the token, explicitly, so the SDK fills none of it in. */
export interface ModalClientParams {
	tokenId: string;
	tokenSecret: string;
}

export interface ModalModuleOptions {
	/** The environment to read; process.env by default. */
	env?: Record<string, string | undefined>;
	/** The SDK's ModalClient; imported from the host's modal package by default. */
	ModalClient?: new (params: ModalClientParams) => unknown;
	/** The daemon to upload; default this package's dist/computerd-linux-amd64. */
	daemonPath?: string;
	/** Builds this package's daemon for linux/amd64 stamped with version, and gives its path; default go build. */
	buildDaemon?: (version: string) => Promise<string>;
}

/** Not a literal, so no type checker or bundler resolves the SDK from this package. */
const MODAL_PACKAGE: string = "modal";

/** A value of the environment by name, or a refusal that names what is missing. */
function setting(env: Record<string, string | undefined>, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`the Modal conformance module needs ${name} in the environment`);
	return value;
}

async function client(options: ModalModuleOptions): Promise<ModalSdk> {
	if ((options.env ?? process.env)[MODAL_ENV.live] !== "1") {
		throw new Error(`the Modal conformance module makes real sandboxes: set ${MODAL_ENV.live}=1, with a key the lead has OKed, to run it`);
	}
	return modalClient(options);
}

/**
 * A Modal client given the COMPUTER_MODAL_ token explicitly, its server pinned as above, and nothing else of the
 * environment. The sweep uses it as the module does, without the live switch: it only lists and terminates.
 */
export async function modalClient({ env = process.env, ModalClient }: Pick<ModalModuleOptions, "env" | "ModalClient">): Promise<ModalSdk> {
	const tokenId = env[MODAL_ENV.tokenId];
	const tokenSecret = env[MODAL_ENV.tokenSecret];
	if (!tokenId || !tokenSecret) {
		throw new Error(
			`the Modal conformance module needs ${MODAL_ENV.tokenId} and ${MODAL_ENV.tokenSecret} in the environment: ` +
				"it takes a key from those names only, never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET",
		);
	}
	if (env.MODAL_SERVER_URL) {
		throw new Error(
			`the Modal conformance module refuses to start while MODAL_SERVER_URL is set: the SDK would send the key there. ` +
				`Unset it, and name the server in ${MODAL_ENV.serverUrl} if it is not ${MODAL_DEFAULT_SERVER_URL}`,
		);
	}
	const serverUrl = modalServerUrl(env);
	const Client = ModalClient ?? ((await import(MODAL_PACKAGE)) as { ModalClient: new (params: ModalClientParams) => unknown }).ModalClient;
	// getProfile reads MODAL_SERVER_URL from process.env when the client is constructed (client.ts:123), and the
	// control-plane client is made then (client.ts:175); afterwards process.env is as it was.
	const before = process.env.MODAL_SERVER_URL;
	process.env.MODAL_SERVER_URL = serverUrl;
	try {
		return new Client({ tokenId, tokenSecret }) as ModalSdk;
	} finally {
		if (before === undefined) delete process.env.MODAL_SERVER_URL;
		else process.env.MODAL_SERVER_URL = before;
	}
}

/** Go's own settings and the target, and nothing else of this process's environment: never the key. */
function goEnv(): Record<string, string> {
	const kept = ["PATH", "HOME", "TMPDIR", "GOPATH", "GOCACHE", "GOMODCACHE", "GOFLAGS", "GOPROXY", "GOTOOLCHAIN"];
	const env: Record<string, string> = { CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64" };
	for (const name of kept) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

/** The daemon for linux/amd64 stamped with version, built with Go into a directory of its own, removed at exit. */
async function goBuild(version: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "computer-drift-"));
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	const out = join(dir, "computerd");
	await new Promise<void>((resolve, reject) => {
		execFile(
			"go",
			["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "./cmd/computerd"],
			{ cwd: fileURLToPath(new URL("../../daemon", import.meta.url)), env: goEnv() },
			(error, _stdout, stderr) => {
				if (!error) return resolve();
				const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "go was not found on PATH" : stderr.trim() || error.message;
				reject(new Error(`building a daemon of another version for the drift case: ${why}`));
			},
		);
	});
	chmodSync(out, 0o755);
	return out;
}

export async function createProvider(options: ModalModuleOptions = {}): Promise<ComputerProvider> {
	const env = options.env ?? process.env;
	const app = setting(env, MODAL_ENV.app);
	const daemonImage = env[MODAL_ENV.daemonImage] || undefined;
	const daemon = daemonImage === undefined ? (options.daemonPath === undefined ? {} : { daemonPath: options.daemonPath }) : { daemonImage };
	return new ModalProvider({ sdk: await client(options), app, ...daemon, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}

/** The same provider uploading a daemon that reports version <version>-drift, for the drift.version case. */
export async function createDriftedProvider(options: ModalModuleOptions = {}): Promise<ComputerProvider> {
	const env = options.env ?? process.env;
	const app = setting(env, MODAL_ENV.app);
	const sdk = await client(options);
	const daemonPath = await (options.buildDaemon ?? goBuild)(`${VERSION}-drift`);
	return new ModalProvider({ sdk, app, daemonPath, maxLifetimeMs: CONFORMANCE_MAX_LIFETIME_MS });
}
