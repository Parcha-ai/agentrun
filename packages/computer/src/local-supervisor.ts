// One local browser's supervisor: a detached Node process of its own per browser (local.ts starts it), so the browser
// outlives neither its deadline nor its release, whatever becomes of the process that made it. It reads the browser's
// directory (browser.json), starts the browser's egress proxy (docker/egress-proxy.ts, with no list: every public host
// and nothing else) on a Unix socket in that directory, with a relay on an ephemeral loopback port in front of it
// (Chrome takes a proxy over TCP alone; the relay passes each connection to the socket unread, the proxy decides), then
// starts Chrome behind that fence (chrome.ts chromeFence) with a fresh profile in the directory and a debugging port
// Chrome picks on 127.0.0.1. Once Chrome's DevTools socket answers it writes state.json and one line on stdout, which
// local.ts waits for; a Chrome that never does is reported on that line in words and nothing is left.
//
// It then ends the browser (Chrome's whole process group, the proxy, the relay, Chrome's singleton socket directory and
// the browser's directory) at the first of: the deadline in browser.json, SIGTERM (a release), or Chrome's own exit. So a
// run that crashes leaves no Chrome past its deadline, and none that can reach the network once its supervisor is gone:
// the relay goes with it. The relay and the proxy are the browser's only way out (chromeFence), and they live here, so a
// browser made by one process is driven from another with its fence intact.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream, openSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { alive, chromeFence, killTree, NO_SANDBOX, ownDebugger, answeringPath, singletonDir } from "./chrome.js";
import { startEgressProxy } from "./docker/egress-proxy.js";
import { isCommand } from "./entry.js";

/** The browser's record, written by local.ts before the supervisor starts: the label a list finds it by. */
export const BROWSER_FILE = "browser.json";
/** What the supervisor writes once Chrome answers: the pids and ports a connect and a release read. */
export const STATE_FILE = "state.json";
/** The supervisor's own pid, written as it starts. */
export const SUPERVISOR_FILE = "supervisor.pid";
/** Chrome's pid, written as soon as it is spawned: a release finds a Chrome whose supervisor died before it answered. */
export const CHROME_PID_FILE = "chrome.pid";
/** Chrome's profile, fresh per browser. */
export const PROFILE_DIR = "profile";
/** The egress proxy's socket: short, since a Unix socket's path holds 107 bytes at most. */
export const EGRESS_SOCKET_FILE = "e.sock";
export const CHROME_LOG = "chrome.log";
export const EGRESS_LOG = "egress.log";
/** How much of the proxy's decisions are kept: a long session's log stops there. */
const EGRESS_LOG_BYTES = 1024 * 1024;
/** Connections open at once, and in all: Chrome holds up to 32 sockets to one proxy, and a page opens one to each host it loads from (#1718's numbers). */
export const BROWSER_MAX_TUNNELS = 128;
export const BROWSER_MAX_CONNECTIONS = 100_000;
/** Where the relay to the proxy listens: this machine's loopback, which the proxy itself refuses. */
const RELAY_HOST = "127.0.0.1"; // key-gate: loopback-rule the local Chrome's relay to its egress proxy listens here
/** How long Chrome has to answer on its debugging port. */
export const READY_MS = 20_000;

/** What local.ts writes in browser.json. */
export interface BrowserRecord {
	provider: "local";
	id: string;
	labels: Record<string, string>;
	/** ISO times. */
	created: string;
	deadline: string;
	executablePath: string;
	/** Every argument but the fence, the profile, the debugging port and the page: CHROME_FLAGS, headless, the window. */
	args: string[];
}

/** What the supervisor writes in state.json. */
export interface BrowserState {
	supervisor: number;
	pid: number;
	port: number;
	/** The browser's DevTools path, /devtools/browser/<id>: with the port, the CDP URL. */
	path: string;
	relay: number;
}

/** The line the supervisor writes on stdout: ready, or why not. */
export type SupervisorLine = { ready: true } | { failed: string; sandbox?: boolean };

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The last lines Chrome wrote to its log, control characters dropped, each line at most 300 characters. */
function chromeTail(dir: string): string {
	let whole = "";
	try {
		whole = readFileSync(join(dir, CHROME_LOG), "utf8");
	} catch {
		return "";
	}
	// A tail that starts inside a line drops that partial line.
	return whole
		.slice(-4096)
		.split("\n")
		.slice(whole.length > 4096 ? 1 : 0)
		.map((line) => line.replace(/[\0-\x08\x0b-\x1f\x7f]/g, "").slice(0, 300))
		.filter((line) => line.trim() !== "")
		.slice(-10)
		.join("\n");
}

/** Supervises the browser in `dir` until it ends; the process exits then. */
export async function supervise(dir: string, out: (line: SupervisorLine) => void): Promise<never> {
	// First, so a release while Chrome still starts finds this process to end.
	writeFileSync(join(dir, SUPERVISOR_FILE), String(process.pid), { mode: 0o600 });
	const record = JSON.parse(readFileSync(join(dir, BROWSER_FILE), "utf8")) as BrowserRecord;
	const profile = join(dir, PROFILE_DIR);
	let child: ChildProcess | undefined;
	let ending: Promise<never> | undefined;
	const open = new Set<Socket>();
	const log = createWriteStream(join(dir, EGRESS_LOG), { flags: "a", mode: 0o600 });
	let logged = 0;
	const proxy = await startEgressProxy({
		socketPath: join(dir, EGRESS_SOCKET_FILE),
		maxTunnels: BROWSER_MAX_TUNNELS,
		maxConnections: BROWSER_MAX_CONNECTIONS,
		log: (line) => {
			if (logged > EGRESS_LOG_BYTES) return;
			logged += line.length + 1;
			log.write(`${line}\n`);
		},
	});
	const relay = createServer((client) => {
		const upstream = connect(join(dir, EGRESS_SOCKET_FILE));
		for (const socket of [client, upstream]) {
			open.add(socket);
			socket.once("close", () => open.delete(socket));
			socket.on("error", () => {
				client.destroy();
				upstream.destroy();
			});
		}
		client.pipe(upstream).pipe(client);
	});

	/** Ends the browser: Chrome's group, then the relay and the proxy, then every file of the browser's. */
	const end = (code: number): Promise<never> =>
		(ending ??= (async () => {
			if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
				killTree(child.pid);
				const gone = child;
				await Promise.race([new Promise((done) => gone.once("exit", done)), sleep(5_000)]);
			}
			await new Promise<void>((done) => {
				relay.close(() => done());
				for (const socket of open) socket.destroy();
			});
			await proxy.close().catch(() => undefined);
			log.end();
			const socketDir = await singletonDir(profile);
			if (socketDir) await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
			// A browser's last writes can land in its profile after the kill: the removal is tried again.
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					await rm(dir, { recursive: true, force: true });
					break;
				} catch {
					await sleep(100 * (attempt + 1));
				}
			}
			process.exit(code);
		})());

	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void end(0));

	try {
		await new Promise<void>((done, failed) => relay.once("error", failed).listen(0, RELAY_HOST, () => done()));
	} catch (error) {
		out({ failed: `the local browser's relay to its egress proxy could not listen on loopback (${(error as Error).message})` });
		return end(1);
	}
	const relayPort = (relay.address() as AddressInfo).port;

	const stderr = openSync(join(dir, CHROME_LOG), "a", 0o600);
	try {
		const args = [...record.args, ...chromeFence(`http://${RELAY_HOST}:${relayPort}`), `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "about:blank"]; // key-gate: loopback-rule the local Chrome's DevTools socket listens on loopback alone
		child = spawn(record.executablePath, args, {
			stdio: ["ignore", "ignore", stderr],
			detached: true,
		});
		// Before anything waits: a supervisor killed while Chrome starts leaves its pid for the release.
		if (child.pid !== undefined) writeFileSync(join(dir, CHROME_PID_FILE), String(child.pid), { mode: 0o600 });
	} catch (error) {
		out({ failed: `Chrome could not be started (${(error as Error).message})` });
		return end(1);
	} finally {
		closeSync(stderr);
	}
	let exited: string | undefined;
	let ready = false;
	child.once("error", (error) => void (exited ??= `Chrome could not be started (${error.message})`));
	child.once("exit", (code, signal) => {
		exited ??= `Chrome exited before it opened its debugging port (${signal ?? code})`;
		// Once ready, Chrome's own exit ends the browser: there is nothing left to drive.
		if (ready) void end(0);
	});

	const deadline = Date.parse(record.deadline);
	for (const until = Date.now() + READY_MS; ; await sleep(100)) {
		if (exited !== undefined) {
			const tail = chromeTail(dir);
			const sandbox = /No usable sandbox|sandbox/i.test(tail) || child.signalCode === "SIGABRT";
			out({ failed: `${sandbox ? NO_SANDBOX : exited}${tail ? `; Chrome said:\n${tail}` : ""}`, ...(sandbox ? { sandbox: true } : {}) });
			return end(1);
		}
		const own = await ownDebugger(profile);
		if (own && (await answeringPath(own.port)) === own.path) {
			const state: BrowserState = { supervisor: process.pid, pid: child.pid as number, port: own.port, path: own.path, relay: relayPort };
			try {
				writeFileSync(join(dir, STATE_FILE), JSON.stringify(state), { mode: 0o600 });
			} catch (error) {
				out({ failed: `the local browser's state could not be written (${(error as Error).message})` });
				return end(1);
			}
			ready = true;
			break;
		}
		if (Date.now() > until) {
			out({ failed: `Chrome did not open its debugging port within ${READY_MS / 1000} s` });
			return end(1);
		}
	}
	// The deadline: from browser.json, so a browser whose maker is gone still ends then. setTimeout holds 24.8 days at most, past every lifetime here.
	setTimeout(() => void end(0), Math.max(0, deadline - Date.now()));
	// A Chrome that went between the ready check and here: its exit handler saw ready false.
	if (!alive(child.pid as number) || child.exitCode !== null || child.signalCode !== null) return end(0);
	out({ ready: true });
	return new Promise<never>(() => undefined);
}

// Run as a script (`node local-supervisor.js <dir>`), not when imported.
if (isCommand(import.meta)) {
	const dir = process.argv[2];
	const out = (line: SupervisorLine) => {
		try {
			process.stdout.write(`${JSON.stringify(line)}\n`);
		} catch {
			/* the maker stopped listening */
		}
	};
	if (dir === undefined) process.exit(2);
	// The maker reads one line and lets go of the pipe: a later write to it fails, and nothing here depends on it.
	process.stdout.on("error", () => undefined);
	supervise(resolve(dir), out).catch((error: unknown) => {
		out({ failed: `the local browser's supervisor failed (${error instanceof Error ? error.message : String(error)})` });
		void rm(resolve(dir), { recursive: true, force: true }).finally(() => process.exit(1));
	});
}
