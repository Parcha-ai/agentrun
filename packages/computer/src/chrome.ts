// Launching a Chrome on this machine, the pieces the local browser (local.ts, local-supervisor.ts) is made of. Moved
// here from pi-browser, which starts its own local Chrome (packages/pi-browser/src/coding-agent-local.ts findChrome, and
// src/providers/cdp.ts alive, leadsOwnGroup, killTree, ownDebugger and singletonDir), so pi-browser can import them back
// once it depends on this package; and the fence and sandbox check of PR #1718's local Chrome for serve
// (packages/serve/src/local-chrome.ts chromeFence and checkChrome), less what was there for Stagehand's extension.
//
// The library reads no environment: where pi-browser read CHROME_PATH and PATH from process.env, findChrome takes the
// environment it is given.
import { spawn } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fail, ok, type Result } from "./result.js";

/** The names a Chrome or Chromium goes by on a Linux PATH. */
const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** Where a Chrome is installed when no PATH names it: Linux's packages, macOS's and Windows' installers. */
const FIXED = [
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/opt/google/chrome/chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

/** The environment names a Chrome is found by: pi-browser's own, then the common one. */
export const CHROME_ENV = ["PI_BROWSER_CHROME", "CHROME_PATH"] as const;

/**
 * The Chrome or Chromium on this machine: the one PI_BROWSER_CHROME or CHROME_PATH names in `env`, else the first on
 * env.PATH, else the first of the usual install places; null when there is none. `env` is the caller's: the library
 * reads none.
 */
export function findChrome(env: Readonly<Record<string, string | undefined>> = {}, exists: (file: string) => boolean = existsSync): string | null {
	for (const name of CHROME_ENV) {
		const named = env[name];
		if (named && exists(named)) return named;
	}
	const onPath = (env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.flatMap((dir) => LINUX_NAMES.map((name) => join(dir, name)));
	return [...onPath, ...FIXED].find((file) => exists(file)) ?? null;
}

/** What to do when there is no Chrome, in words: what to install, and the settings that point at one. */
export const NO_CHROME =
	"no Chrome or Chromium was found on this machine: install Google Chrome or Chromium (on Debian or Ubuntu, `apt install chromium` or Google's google-chrome-stable package), or name the executable with the provider's executablePath option, or CHROME_PATH (or PI_BROWSER_CHROME) in the environment the host passes as its env option";

/**
 * The switches every local Chrome starts with, beside the fence, its profile and its debugging port: no first-run
 * screens, no sign-in or sync, no background traffic of Chrome's own (component updates, field trials, safe-browsing
 * pings), no keychain prompt, no sound.
 */
export const CHROME_FLAGS: readonly string[] = [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-background-networking",
	"--disable-component-update",
	"--disable-sync",
	"--disable-default-apps",
	"--disable-client-side-phishing-detection",
	"--disable-domain-reliability",
	"--metrics-recording-only",
	"--password-store=basic",
	"--use-mock-keychain",
	"--mute-audio",
	"--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication",
];

/**
 * The arguments that hold a local Chrome to its egress proxy at `proxy` (an http URL of a loopback port, the relay to
 * the proxy, which decides): every request through the proxy, loopback too (`<-loopback>` takes away the bypass Chrome
 * gives it by default), so this machine's own services, private networks, link-local and a cloud's metadata address are
 * each refused by the proxy after its lookup; no name or address resolved by Chrome itself but the proxy's, so a request
 * a page sends around the proxy reaches nothing; no QUIC, which goes around an HTTP proxy; and WebRTC on no UDP but the
 * proxy's, which carries none, so no ICE candidate is gathered and no STUN packet leaves. That last is
 * `--webrtc-ip-handling-policy`: Chrome 155 and 156 ignore the `--force-` spelling (#1718 measured a STUN server on
 * loopback sent its binding requests under it). From #1718's chromeFence, less the bypass it kept for the DevTools guard
 * Stagehand's extension dialled: nothing in this browser reaches its own DevTools socket.
 */
export function chromeFence(proxy: string): string[] {
	const { hostname, port } = new URL(proxy);
	return [
		`--proxy-server=${proxy}`,
		"--proxy-bypass-list=<-loopback>",
		`--host-resolver-rules=MAP ${hostname}:${port} ${hostname}:${port}, MAP * ~NOTFOUND`,
		"--disable-quic",
		"--webrtc-ip-handling-policy=disable_non_proxied_udp",
	];
}

/** Signal 0 only asks; EPERM means the process exists under another user. */
export const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** Whether `pid` leads its own process group (a detached child does); null where there is no /proc to ask. */
export function leadsOwnGroup(pid: number): boolean | null {
	if (process.platform !== "linux") return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// pid (comm) state ppid pgrp ...: the name may hold spaces and brackets, so the fields are counted from its last ")".
		return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pid;
	} catch {
		return false;
	}
}

/**
 * Kills `pid` and its group. A pid reaches here from a file a restart reads back: `kill(-1)` signals every process the
 * user can, `kill(0)` this process's own group, so neither a pid below 2 nor our own is ever signalled, and a negative
 * pid (a whole group) only for a process that leads one.
 */
export function killTree(pid: number, io: { kill?: (pid: number, signal: NodeJS.Signals) => void; leadsGroup?: (pid: number) => boolean | null } = {}, signal: NodeJS.Signals = "SIGKILL"): void {
	if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
	const kill = io.kill ?? ((target, how) => process.kill(target, how));
	if ((io.leadsGroup ?? leadsOwnGroup)(pid) !== false) {
		try {
			return kill(-pid, signal);
		} catch {
			/* no such group: the process alone */
		}
	}
	try {
		kill(pid, signal);
	} catch {
		/* already gone */
	}
}

/**
 * Whether `pid` is a process whose command line holds `marker` (a Chrome's `--user-data-dir=<profile>`, a supervisor's
 * directory), so a pid read back from a file never names a recycled process. Where there is no /proc to ask (macOS),
 * whether it is alive.
 */
export function runsWith(pid: number, marker: string): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	if (process.platform !== "linux") return alive(pid);
	try {
		// Chrome rewrites its own process title: its arguments then read as one string, joined by spaces.
		const words = ` ${readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")} `;
		return words.includes(` ${marker} `);
	} catch {
		return false;
	}
}

/** The port and browser path a Chrome on `profile` wrote to its DevToolsActivePort: only that Chrome writes it there. */
export async function ownDebugger(profile: string): Promise<{ port: number; path: string } | null> {
	const [port, browser] = (await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n");
	return /^\d+$/.test(port ?? "") && browser?.startsWith("/devtools/browser/") ? { port: Number(port), path: browser.trim() } : null;
}

/** The browser path the DevTools socket on `port` answers /json/version with, or null; bounded, so a socket that takes the connection and never answers holds no one. */
export async function answeringPath(port: number, timeoutMs = 2_000): Promise<string | null> {
	try {
		const reply = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) }); // key-gate: loopback-rule the local Chrome's own DevTools socket
		const url = ((await reply.json()) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
		return typeof url === "string" ? new URL(url).pathname : null;
	} catch {
		return null;
	}
}

/** Chrome's singleton socket directory under the temp directory outlives every Chrome exit; the profile's link names it. */
export async function singletonDir(profile: string): Promise<string | null> {
	const socket = await readlink(join(profile, "SingletonSocket")).catch(() => null);
	const dir = socket && basename(socket) === "SingletonSocket" ? dirname(socket) : null;
	return dir && /^\.?(org\.chromium\.Chromium|com\.google\.Chrome)\.[A-Za-z0-9]{6}$/.test(basename(dir)) ? dir : null;
}

/** What a start whose Chrome could not start its sandbox is told: never to turn it off, which nothing here can. */
export const NO_SANDBOX =
	"this machine's Chrome could not start its sandbox, and the local browser never runs Chrome without it, so no browser was started: on Ubuntu 23.10 and later give this Chrome an AppArmor profile that allows it user namespaces, or use a Chrome whose setuid sandbox helper is installed (Google's package installs one)";

/** What a start as root is told: Chrome refuses root with its sandbox on, and the sandbox is never turned off here. */
export const AS_ROOT = "the local browser does not start Chrome as root: Chrome refuses root with its sandbox on, and the sandbox is never turned off here. Run AgentRun as a user that is not root";

/** How long the sandbox check may take: one headless Chrome that loads a blank page and exits. */
export const CHECK_MS = 30_000;

/**
 * Whether the Chrome at `path` starts here with its sandbox on: an executable file, a user that is not root, and one
 * headless start on a blank page (`--dump-dom about:blank`) in a profile of its own that goes with it, with a proxy no
 * name or address reaches, so nothing leaves the machine. ok with the resolved path; refused in words that never offer
 * to turn the sandbox off. From #1718's checkChrome. `uid`: the user this process runs as (a test's seam).
 */
export async function checkChrome(path: string, { uid = process.getuid?.(), timeoutMs = CHECK_MS }: { uid?: number; timeoutMs?: number } = {}): Promise<Result<string>> {
	const at = resolve(path);
	const runs = (await stat(at).then((info) => info.isFile(), () => false)) && (await access(at, constants.X_OK).then(() => true, () => false));
	if (!runs) return fail("not_found", `${at} is not an executable file: name a Chrome or Chromium binary with the executablePath option, or leave it out to look in the usual places`);
	if (uid === 0) return fail("refused", AS_ROOT);
	// A short directory: Chrome's singleton socket must stay within a Unix socket's 107 bytes.
	const dir = await mkdtemp(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "agentrun-chrome-check-"));
	const profile = join(dir, "profile");
	try {
		const said = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((done) => {
			const child = spawn(at, ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--proxy-server=http://agentrun-check.invalid:9", "--host-resolver-rules=MAP * ~NOTFOUND", "--dump-dom", "about:blank"], {
				stdio: ["ignore", "ignore", "pipe"],
				timeout: timeoutMs,
				killSignal: "SIGKILL",
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => void (stderr = (stderr + chunk).slice(-8_192)));
			child.once("error", (error) => done({ code: null, signal: null, stderr: error.message }));
			child.once("exit", (code, signal) => done({ code, signal, stderr }));
		});
		if (said.code === 0) return ok(at);
		// Chrome's own words name the sandbox and go on to offer --no-sandbox: only the first are passed on.
		if (/No usable sandbox|sandbox/i.test(said.stderr)) return fail("refused", `${at} did not start with its sandbox on (No usable sandbox): ${NO_SANDBOX}`);
		const why = said.signal ? `it ended on ${said.signal}` : `it exited ${said.code ?? "without starting"}`;
		return fail("refused", `${at} did not start here (${why}), so no local browser can start on it`);
	} finally {
		const socket = await singletonDir(profile);
		if (socket) await rm(socket, { recursive: true, force: true }).catch(() => undefined);
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
