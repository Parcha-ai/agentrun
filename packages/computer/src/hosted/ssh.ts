// SSH exec for a machine host: a vendor whose machines are reached over SSH (as root, one connection per process, under
// a wrapper that names the process group) gives a "Duplex to the machine's sshd" and gets MachineHost.exec from here.
// The host's own ssh2 package does the protocol; this package names only the slice it uses (Ssh2Module) and imports
// nothing at load. The vendor keeps what is its own: how the stream reaches the machine (a WebSocket tunnel for Agent37),
// and which errors it throws for a machine id it does not know.
import { randomBytes } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";
import type { HostCall, MachineProcess } from "../host.js";
import { type Result, ok } from "../result.js";
import { bounded } from "./process.js";
import { shellLine } from "./scripts.js";

/** A readable side of an ssh2 channel, as this provider uses it: piped, or drained. */
export interface Ssh2Readable {
	pipe(destination: NodeJS.WritableStream): unknown;
	resume(): unknown;
}

/**
 * The slice of an ssh2 channel this provider uses (ssh2@1.17.0 lib/Channel.js): the channel is stdout. No signal
 * request: ssh2 sends one only while stdin is open (Channel.js:237-246), so a kill goes by the process group instead.
 */
export interface Ssh2Channel extends Ssh2Readable {
	readonly stderr: Ssh2Readable;
	write(data: Uint8Array, callback?: (error?: Error | null) => void): boolean;
	/** Sends end of file on stdin and keeps the channel open (Channel.js:200-205). */
	eof(): void;
	close(): void;
	/** exit-status, or exit-signal with a null code (client.js:666-678). */
	on(event: "exit", listener: (code: number | null, signal?: string) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
}

/** The options of ssh2's Client.connect this provider gives (ssh2@1.17.0 lib/client.js). */
export interface Ssh2ConnectConfig {
	sock: Duplex;
	username: "root";
	privateKey: string;
	readyTimeout: number;
	keepaliveInterval: number;
}

/** The slice of an ssh2 Client this provider uses. */
export interface Ssh2Client {
	connect(config: Ssh2ConnectConfig): unknown;
	exec(command: string, callback: (error: Error | undefined, channel: Ssh2Channel) => void): unknown;
	end(): unknown;
	destroy(): unknown;
	once(event: "ready", listener: () => void): unknown;
	once(event: "error", listener: (error: Error) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	removeListener(event: "error", listener: (error: Error) => void): unknown;
}

/** The ssh2 package as this provider uses it: its Client class. The host's own, or anything with the same slice. */
export interface Ssh2Module {
	Client: new () => Ssh2Client;
}

/** ssh2's keepalive: the CLI's ServerAliveInterval is 60 s (cli.js:32); the edge never sees an idle tunnel. */
const KEEPALIVE_MS = 30_000;
/** How long a kill waits for its own kill command, then for the SSH connection to close before it drops the tunnel. */
const KILL_GRACE_MS = 2_000;
/**
 * Every command runs under this sh, which writes its pid to $0 first and removes the file when the command ends. The
 * instance's sshd starts each command as a session and group leader (seen live: sh's PID, PGID and SID are one), so
 * the pid names the group a kill ends; ssh2 sends no signal once stdin has ended, and a signal ends one process only.
 */
const WRAPPER = '{ echo $$ > "$0"; } 2>/dev/null; "$@"; c=$?; rm -f "$0"; exit $c';
/**
 * The kill: waits up to a second for the pid file, then kills the group when the pid leads one (the process alone
 * otherwise, so a kill never reaches past what it started) and removes the file.
 */
const KILL_SCRIPT = [
	"i=0",
	'while [ ! -s "$0" ] && [ $i -lt 10 ]; do sleep 0.1; i=$((i+1)); done',
	'p=$(cat "$0" 2>/dev/null); rm -f "$0"',
	'[ -n "$p" ] || exit 0',
	'g=$(cut -d" " -f5 "/proc/$p/stat" 2>/dev/null)',
	// No "--": dash's kill reads it as a pid (seen live: "Illegal number: -").
	'if [ "$g" = "$p" ]; then kill -KILL "-$p"; else kill -KILL "$p"; fi 2>/dev/null',
	"exit 0",
].join("\n");

/** A tunnel failed before its SSH handshake, or while it carried the stream: the one failure a retry may repeat. */
export class SshTunnelError extends Error {
	override name = "SshTunnelError";
}

/** One stream to a machine's sshd, as a vendor's hook gives it: its bytes as a Duplex, resolved once open, and the host named in words. */
export interface SshTunnel {
	duplex: Duplex;
	/** Resolves once the stream is open; rejects (an SshTunnelError, for a retry) when it fails to open. */
	opened: Promise<void>;
	/** The host's name, in the words of an error. */
	host: string;
}

/** How a vendor opens the stream to machine id's sshd: a fresh one per call, nothing started before it is used. */
export type SshTunnelOf = (id: string) => SshTunnel;

/** How many times a tunnel that fails before its SSH handshake is opened, and the first pause between (it doubles). */
const TUNNEL_TRIES = 4;
const TUNNEL_RETRY_MS = 500;

/** A promise that rejects with the abort's or the bound's error once ms pass or signal aborts. */
function deadline(ms: number, signal: AbortSignal | undefined, what: string): { promise: Promise<never>; clear: () => void } {
	const bound = bounded(ms, signal);
	let onAbort: () => void = () => {};
	const promise = new Promise<never>((_, reject) => {
		onAbort = () => {
			const timedOut = !signal?.aborted;
			const error = new Error(timedOut ? `${what} did not answer within ${ms / 1000} s` : `${what} was aborted`);
			error.name = timedOut ? "TimeoutError" : "AbortError";
			reject(error);
		};
		if (bound.aborted) onAbort();
		else bound.addEventListener("abort", onAbort, { once: true });
	});
	promise.catch(() => {});
	return { promise, clear: () => bound.removeEventListener("abort", onAbort) };
}

export interface SshExecOptions {
	/** The host's own ssh2 package, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** A private key in the PEM armor ssh2 reads (see pemOf). */
	privateKey: string;
	tunnelOf: SshTunnelOf;
}

/** MachineHost.exec over SSH: argv as root, one connection per process. */
export class SshExec {
	readonly #ssh2: Ssh2Module;
	readonly #privateKey: string;
	readonly #tunnelOf: SshTunnelOf;

	constructor({ ssh2, privateKey, tunnelOf }: SshExecOptions) {
		this.#ssh2 = ssh2;
		this.#privateKey = privateKey;
		this.#tunnelOf = tunnelOf;
	}

	/**
	 * An SSH session as root over the instance's tunnel, its handshake within ctx. A tunnel that fails to open, or closes
	 * before the SSH handshake, is opened again after a pause, TUNNEL_TRIES times in all within ctx: an instance fresh
	 * from its create can refuse the first (seen live once in eight creates, the daemon's upload refused). Nothing has
	 * run before a handshake, so a retry repeats nothing. A refused key or a handshake past its bound is not retried.
	 */
	async #ssh(id: string, ctx: HostCall): Promise<Ssh2Client> {
		const bound = deadline(ctx.timeoutMs, ctx.signal, `the SSH connection to ${id}`);
		// Ends the handshake in flight when this call gives up on it (its bound passed, or the caller aborted).
		const givenUp = new AbortController();
		try {
			for (let attempt = 1; ; attempt++) {
				try {
					return await Promise.race([this.#handshake(id, ctx.timeoutMs, givenUp.signal), bound.promise]);
				} catch (error) {
					const early = error instanceof SshTunnelError || (error as { level?: unknown }).level === "client-socket";
					if (!early || attempt >= TUNNEL_TRIES) throw error;
				}
				await Promise.race([new Promise((resolve) => setTimeout(resolve, TUNNEL_RETRY_MS * 2 ** (attempt - 1))), bound.promise]);
			}
		} catch (error) {
			givenUp.abort();
			throw error;
		} finally {
			bound.clear();
		}
	}

	/**
	 * One tunnel and one SSH handshake over it. On a failure, or once stop aborts before the handshake is done, the
	 * WebSocket (opening or open), the stream and the client are dropped.
	 */
	async #handshake(id: string, timeoutMs: number, stop: AbortSignal): Promise<Ssh2Client> {
		const { duplex, opened, host } = this.#tunnelOf(id);
		const client = new this.#ssh2.Client();
		const givenUp = () => new SshTunnelError(`the SSH tunnel to ${host} was given up on`);
		let quit: (error: Error) => void = () => {};
		const quitted = new Promise<never>((_resolve, reject) => {
			quit = reject;
		});
		quitted.catch(() => {});
		const drop = () => {
			client.destroy();
			duplex.destroy();
			quit(givenUp());
		};
		stop.addEventListener("abort", drop, { once: true });
		try {
			await Promise.race([opened, quitted]);
			await Promise.race([
				new Promise<void>((resolve, reject) => {
					client.once("ready", resolve);
					client.once("error", reject);
					client.connect({ sock: duplex, username: "root", privateKey: this.#privateKey, readyTimeout: timeoutMs, keepaliveInterval: KEEPALIVE_MS });
				}),
				quitted,
			]);
		} catch (error) {
			drop();
			throw error;
		} finally {
			stop.removeEventListener("abort", drop);
		}
		if (stop.aborted) {
			drop();
			throw givenUp();
		}
		// A later error ends the session; its channel's close reports it.
		client.on("error", () => {});
		return client;
	}

	/**
	 * One exec channel on client, opened within ms and signal, and its close: the exit-status, or -1 for an exit by
	 * signal or none. Its listeners go on inside ssh2's callback, as it opens: one read off the tunnel can hold the open,
	 * the exit and the close together (seen live), and they are emitted before an await after it would resume.
	 */
	async #channel(client: Ssh2Client, command: string, ms: number, signal: AbortSignal | undefined, what: string): Promise<{ channel: Ssh2Channel; closed: Promise<number> }> {
		const bound = deadline(ms, signal, what);
		try {
			return await Promise.race([
				new Promise<{ channel: Ssh2Channel; closed: Promise<number> }>((resolve, reject) => {
					client.exec(command, (error, channel) => {
						if (error) return reject(error);
						let code = -1;
						channel.on("exit", (status) => {
							code = typeof status === "number" ? status : -1;
						});
						channel.on("error", () => {});
						resolve({ channel, closed: new Promise<number>((done) => channel.on("close", () => done(code))) });
					});
				}),
				bound.promise,
			]);
		} finally {
			bound.clear();
		}
	}

	/**
	 * argv as root over SSH, one connection per process, under WRAPPER. stdout and stderr are the channel's, piped; with
	 * no stdin, end of file is sent at once, and end sends it later. wait answers once the channel closes, with the
	 * exit-status, or -1 for an exit by signal or none. kill ends the process group over a second channel of the same
	 * connection, then closes the channel and the connection, and drops the tunnel if the close does not come.
	 */
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		const client = await this.#ssh(id, ctx);
		const pidFile = `/tmp/.agentrun-exec-${randomBytes(8).toString("hex")}`;
		let opened: { channel: Ssh2Channel; closed: Promise<number> };
		try {
			opened = await this.#channel(client, shellLine(["sh", "-c", WRAPPER, pidFile, ...argv]), ctx.timeoutMs, ctx.signal, `the exec in ${id}`);
		} catch (error) {
			client.destroy();
			throw error;
		}
		const { channel } = opened;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		channel.pipe(stdout);
		channel.stderr.pipe(stderr);
		let ended = !stdin;
		if (!stdin) channel.eof();
		let closed = false;
		// ssh2 closes every channel when the connection goes (utils.js, ChannelManager.cleanup), so the close is enough.
		const exited = opened.closed.then((code) => {
			closed = true;
			client.end();
			return code;
		});
		return ok({
			stdout,
			stderr,
			write: (bytes) =>
				new Promise<void>((resolve, reject) => {
					if (ended || closed) return reject(new Error(ended ? "stdin was ended" : "the process has ended"));
					channel.write(bytes, (error) => (error ? reject(error) : resolve()));
				}),
			end: async () => {
				if (ended || closed) return;
				ended = true;
				channel.eof();
			},
			wait: () => exited,
			kill: async () => {
				if (closed) return;
				try {
					const killer = await this.#channel(client, shellLine(["sh", "-c", KILL_SCRIPT, pidFile]), KILL_GRACE_MS, undefined, `the kill in ${id}`);
					killer.channel.resume();
					killer.channel.stderr.resume();
					killer.channel.eof();
					const grace = deadline(KILL_GRACE_MS, undefined, `the kill in ${id}`);
					await Promise.race([killer.closed, grace.promise]).finally(grace.clear);
				} catch {
					// The connection is gone, or the kill did not answer in time: closing it below is what is left.
				}
				try {
					channel.close();
				} catch {
					// Closed already.
				}
				client.end();
				const dropped = setTimeout(() => client.destroy(), KILL_GRACE_MS);
				dropped.unref();
				void exited.then(() => clearTimeout(dropped));
			},
		});
	}}

/**
 * A private key in the PEM armor ssh2 reads (its parser wants the BEGIN and END lines on lines of their own), or
 * undefined when text is not one. A key pasted into Settings → Computers comes back on one line, since a password
 * field drops line breaks: its body is wrapped again at 70 characters, as ssh-keygen writes it.
 */
export function pemOf(text: string): string | undefined {
	const armor = /^-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----$/.exec(text.replace(/\r/g, "").trim());
	if (!armor) return undefined;
	const [, label, inside] = armor;
	const lines = inside.split("\n").map((line) => line.trim()).filter(Boolean);
	// PEM headers (Proc-Type, DEK-Info) keep their own lines; a key with them was never pasted onto one line.
	if (lines.some((line) => line.includes(":"))) return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
	const body = lines.join("").replace(/\s+/g, "");
	if (body === "" || !/^[A-Za-z0-9+/=]+$/.test(body)) return undefined;
	return `-----BEGIN ${label}-----\n${body.match(/.{1,70}/g)?.join("\n")}\n-----END ${label}-----\n`;
}
