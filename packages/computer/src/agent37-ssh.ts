// Agent37's SSH exec: its instances are reached over SSH (as root, one connection per process, under a wrapper that
// names the process group), through the stream agent37.ts gives to each instance's sshd (its WebSocket tunnel), and
// this is its MachineHost.exec. The host's own ssh2 package does the protocol; this package names only the slice it
// uses (Ssh2Module) and imports nothing at load.
import { randomBytes } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";
import type { HostCall, MachineProcess } from "./host.js";
import { boundOf } from "./hosted/process.js";
import { shellLine } from "./hosted/scripts.js";
import { type Result, ok } from "./result.js";

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
	on(event: "close" | "end", listener: () => void): unknown;
	removeListener(event: "error", listener: (error: Error) => void): unknown;
}

/** The ssh2 package as this provider uses it: its Client class. The host's own, or anything with the same slice. */
export interface Ssh2Module {
	Client: new () => Ssh2Client;
}

/** ssh2's keepalive: the CLI's ServerAliveInterval is 60 s (cli.js:32); the edge never sees an idle tunnel. */
const KEEPALIVE_MS = 30_000;
/**
 * How long a kill waits for its own kill command, then for its channel to close before wait() answers -1 anyway; and
 * how long an ended SSH connection has to close before its tunnel is dropped.
 */
const KILL_GRACE_MS = 2_000;
/**
 * How many channels (execs and kills) one SSH connection carries at once; the next opens a second connection. OpenSSH's
 * sshd takes MaxSessions (default 10) sessions on one connection and refuses the next. A vendor does not always say which
 * sshd it runs, so OpenSSH's default is held to; an sshd that takes fewer refuses a channel, which is opened once more on
 * a fresh connection.
 */
const CHANNELS_PER_CONNECTION = 10;
/**
 * How long a connection with no channel stays open for the next exec. The adapter's steps (the upload, the install,
 * init's start, the bridge, connect after create) come one after another, each an exec, and the live view's watch
 * opens beside the bridge. An open connection keeps the process alive (ssh2's keepalive timer and the WebSocket's
 * socket are both referenced), so the wait is short: a process that is done with its computers exits at most this late.
 */
const IDLE_MS = 2_000;
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

/** A bound's own error (boundOf's): the call ran out of time or was aborted, so nothing is tried again. */
const isBound = (error: unknown) => {
	const name = (error as { name?: unknown } | null)?.name;
	return name === "TimeoutError" || name === "AbortError";
};

/**
 * One SSH connection to a machine, shared by its execs: each exec, and each kill, is a channel on it. It counts its
 * holders (an exec waiting for the handshake, an open exec channel, a kill's channel), and is done once it closes,
 * fails, ends or takes no more: a done link is never handed to another exec, and it ends once its last holder lets go.
 */
interface Link {
	readonly id: string;
	/** The handshake (TUNNEL_TRIES tries), then the client. */
	readonly ready: Promise<Ssh2Client>;
	/** Gives up the handshake once nobody waits for it. */
	readonly stop: AbortController;
	client?: Ssh2Client;
	holders: number;
	done: boolean;
	/** Its client has been ended. */
	ended: boolean;
	idle?: ReturnType<typeof setTimeout>;
}

export interface SshExecOptions {
	/** The host's own ssh2 package, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** A private key in the PEM armor ssh2 reads (see pemOf). */
	privateKey: string;
	tunnelOf: SshTunnelOf;
}

/** MachineHost.exec over SSH: argv as root, as channels on one connection per machine, shared by its execs. */
export class SshExec {
	readonly #ssh2: Ssh2Module;
	readonly #privateKey: string;
	readonly #tunnelOf: SshTunnelOf;
	/**
	 * The SSH connections to each machine, opening, open, or done and still held, until each ends: one, and a second
	 * past CHANNELS_PER_CONNECTION channels. A done one takes no new channel; closeAll ends them all.
	 */
	readonly #links = new Map<string, Link[]>();

	constructor({ ssh2, privateKey, tunnelOf }: SshExecOptions) {
		this.#ssh2 = ssh2;
		this.#privateKey = privateKey;
		this.#tunnelOf = tunnelOf;
	}

	/** Ends every connection to machine id, channels and all: the vendor calls it once the machine is deleted. */
	closeAll(id: string): void {
		for (const link of [...(this.#links.get(id) ?? [])]) this.#end(link);
	}

	/**
	 * An SSH session as root over the instance's tunnel, its handshake within ctx. A tunnel that fails to open, or closes
	 * before the SSH handshake, is opened again after a pause, TUNNEL_TRIES times in all within ctx: an instance fresh
	 * from its create can refuse the first (seen live once in eight creates, the daemon's upload refused). Nothing has
	 * run before a handshake, so a retry repeats nothing. A refused key or a handshake past its bound is not retried.
	 */
	async #ssh(id: string, ctx: HostCall): Promise<Ssh2Client> {
		const bound = boundOf(ctx.timeoutMs, ctx.signal, `the SSH connection to ${id}`);
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
	 * A connection to id with one more holder, its handshake within ctx: a link of the machine's that is not done and
	 * has room, or a new one. Execs that come together share one handshake, each waiting within its own bound; the
	 * handshake is given up once none waits. A link that closed as its handshake ended is let go, and another taken.
	 */
	async #lease(id: string, ctx: HostCall): Promise<{ link: Link; client: Ssh2Client }> {
		const bound = boundOf(ctx.timeoutMs, ctx.signal, `the SSH connection to ${id}`);
		const end = Date.now() + ctx.timeoutMs;
		try {
			for (;;) {
				const link = this.#links.get(id)?.find((one) => !one.done && one.holders < CHANNELS_PER_CONNECTION) ?? this.#open(id, end - Date.now());
				this.#hold(link);
				let got: { client: Ssh2Client } | { error: unknown };
				try {
					got = await Promise.race([link.ready.then((client) => ({ client }), (error: unknown) => ({ error })), bound.promise]);
				} catch (error) {
					this.#letGo(link);
					throw error;
				}
				if (!("error" in got) && !link.done) return { link, client: got.client };
				this.#letGo(link);
				if ("error" in got) {
					// A shared handshake is bound by the call that opened it: a call with time of its own left opens another.
					if ((got.error as { name?: unknown } | null)?.name === "TimeoutError" && end - Date.now() > TUNNEL_RETRY_MS) continue;
					throw got.error;
				}
			}
		} finally {
			bound.clear();
		}
	}

	/** A new link to id, its handshake started within timeoutMs, listed for the machine's next execs until it is done. */
	#open(id: string, timeoutMs: number): Link {
		const stop = new AbortController();
		const link: Link = {
			id,
			stop,
			holders: 0,
			done: false,
			ended: false,
			ready: this.#ssh(id, { timeoutMs, signal: stop.signal }).then(
				(client) => {
					link.client = client;
					const gone = () => this.#retire(link);
					client.on("close", gone);
					client.on("end", gone);
					client.on("error", gone);
					// Deleted as it opened.
					if (link.done) this.#end(link);
					return client;
				},
				(error: unknown) => {
					this.#retire(link);
					throw error;
				},
			),
		};
		link.ready.catch(() => {});
		this.#links.set(id, [...(this.#links.get(id) ?? []), link]);
		return link;
	}

	#hold(link: Link): void {
		link.holders++;
		clearTimeout(link.idle);
		link.idle = undefined;
	}

	/**
	 * One holder lets go of link. Once none holds it, a done link ends, a handshake no one waits for is given up, and an
	 * open connection waits IDLE_MS for the next exec, then ends.
	 */
	#letGo(link: Link): void {
		link.holders--;
		if (link.holders > 0) return;
		if (link.done || link.client === undefined) return this.#retire(link);
		link.idle = setTimeout(() => this.#retire(link), IDLE_MS);
		link.idle.unref();
	}

	/** link takes no new channel; it ends at once if none holds it, else when the last lets go (or closeAll ends it). */
	#retire(link: Link): void {
		link.done = true;
		clearTimeout(link.idle);
		if (link.holders <= 0) this.#end(link);
	}

	/**
	 * Ends link, whoever holds it, and drops it from the machine's list: its handshake given up, its client ended (ssh2
	 * closes every channel on it), and the tunnel dropped if the connection has not closed within KILL_GRACE_MS. Neither
	 * timer keeps the process alive.
	 */
	#end(link: Link): void {
		link.done = true;
		clearTimeout(link.idle);
		const left = (this.#links.get(link.id) ?? []).filter((one) => one !== link);
		if (left.length > 0) this.#links.set(link.id, left);
		else this.#links.delete(link.id);
		link.stop.abort();
		const { client } = link;
		if (client === undefined || link.ended) return;
		link.ended = true;
		client.end();
		const dropped = setTimeout(() => client.destroy(), KILL_GRACE_MS);
		dropped.unref();
		client.on("close", () => clearTimeout(dropped));
	}

	/**
	 * One exec channel on client, opened within ms and signal, and its close: the exit-status, or -1 for an exit by
	 * signal or none. Its listeners go on inside ssh2's callback, as it opens: one read off the tunnel can hold the open,
	 * the exit and the close together (seen live), and they are emitted before an await after it would resume. A channel
	 * that opens after its bound passed is closed: the connection is shared, so nothing else would close it.
	 */
	async #channel(client: Ssh2Client, command: string, ms: number, signal: AbortSignal | undefined, what: string): Promise<{ channel: Ssh2Channel; closed: Promise<number> }> {
		const bound = boundOf(ms, signal, what);
		let late = false;
		try {
			return await Promise.race([
				new Promise<{ channel: Ssh2Channel; closed: Promise<number> }>((resolve, reject) => {
					client.exec(command, (error, channel) => {
						if (error) return reject(error);
						if (late) {
							channel.on("error", () => {});
							return channel.close();
						}
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
		} catch (error) {
			late = true;
			throw error;
		} finally {
			bound.clear();
		}
	}

	/**
	 * command as one channel on a connection to id with room (#lease), within ctx; the channel holds its connection until
	 * the caller lets go. A channel that fails to open (the connection died under it, or its sshd took no more sessions)
	 * retires that connection and is opened once more on a fresh one.
	 */
	async #start(id: string, command: string, ctx: HostCall, what: string): Promise<{ link: Link; channel: Ssh2Channel; closed: Promise<number> }> {
		for (let attempt = 1; ; attempt++) {
			const { link, client } = await this.#lease(id, ctx);
			try {
				return { link, ...(await this.#channel(client, command, ctx.timeoutMs, ctx.signal, what)) };
			} catch (error) {
				// A channel open that timed out leaves a connection that may be stuck: the next channel takes another.
				if ((error as { name?: unknown } | null)?.name !== "AbortError") this.#retire(link);
				this.#letGo(link);
				if (isBound(error) || attempt >= 2) throw error;
			}
		}
	}

	/**
	 * argv as root over SSH, under WRAPPER, as one channel on the machine's shared connection (#start). stdout and
	 * stderr are the channel's, piped; with no stdin, end of file is sent at once, and end sends it later. wait answers
	 * once the channel closes, with the exit-status, or -1 for an exit by signal or none. kill ends the process group
	 * over a channel of its own (on a connection with room), then closes the exec's channel, never a connection; if the
	 * close does not come, wait answers -1 and the connection takes no new channel.
	 */
	async exec(id: string, argv: readonly string[], { stdin }: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>> {
		const pidFile = `/tmp/.agentrun-exec-${randomBytes(8).toString("hex")}`;
		const opened = await this.#start(id, shellLine(["sh", "-c", WRAPPER, pidFile, ...argv]), ctx, `the exec in ${id}`);
		const { link: held, channel } = opened;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		channel.pipe(stdout);
		channel.stderr.pipe(stderr);
		let ended = !stdin;
		if (!stdin) channel.eof();
		let closed = false;
		// ssh2 closes every channel when the connection goes (utils.js, ChannelManager.cleanup), so the close is enough.
		let done: (code: number) => void = () => {};
		const exited = new Promise<number>((resolve) => {
			done = (code) => {
				if (closed) return;
				closed = true;
				this.#letGo(held);
				resolve(code);
			};
		});
		void opened.closed.then(done);
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
				// The pid file is the machine's, so the kill's channel goes on any connection with room, counted like an exec's.
				try {
					const killer = await this.#start(id, shellLine(["sh", "-c", KILL_SCRIPT, pidFile]), { timeoutMs: KILL_GRACE_MS }, `the kill in ${id}`);
					killer.channel.resume();
					killer.channel.stderr.resume();
					killer.channel.eof();
					const grace = boundOf(KILL_GRACE_MS, undefined, `the kill in ${id}`);
					try {
						await Promise.race([killer.closed, grace.promise]);
					} catch {
						try {
							killer.channel.close();
						} catch {
							// Closed already.
						}
					} finally {
						grace.clear();
						this.#letGo(killer.link);
					}
				} catch {
					// No connection took the kill in time: closing the channel below is what is left.
				}
				try {
					channel.close();
				} catch {
					// Closed already.
				}
				// A close that never comes is a connection that is stuck: it takes no more execs, and wait answers.
				const dropped = setTimeout(() => {
					if (closed) return;
					this.#retire(held);
					done(-1);
				}, KILL_GRACE_MS);
				dropped.unref();
				void exited.then(() => clearTimeout(dropped));
			},
		});
	}
}

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
