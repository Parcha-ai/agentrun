// MachineHost.exec over SSH, for a vendor whose machines run an sshd: one connection per machine shared by its execs,
// each process under the wrapper that names its pid (./scripts.ts, PID_WRAPPER), through the stream the host gives to
// the machine's sshd (Agent37's WebSocket tunnel, or a TCP connection: tcpTunnel) and as the login the host gives
// (Agent37's root and key; boat's sudo user, its host key pinned). Every error it throws or
// rejects with is redacted of the login's secrets. The host's own ssh2 package does the protocol; this package names
// only the slice it uses (Ssh2Module) and imports nothing at load.
import { createPrivateKey, type KeyObject, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP, connect as tcp } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { proxyFor, tunnelThrough } from "../env-proxy.js";
import type { HostCall, MachineProcess } from "../host.js";
import { boundOf, redact } from "./process.js";
import { PID_WRAPPER, pidKill, pidStderr, shellLine } from "./scripts.js";
import { sshString } from "./ssh-key.js";

/** A readable side of an ssh2 channel, as this provider uses it: piped, or drained. */
export interface Ssh2Readable {
	pipe(destination: NodeJS.WritableStream): unknown;
	resume(): unknown;
}

/**
 * The slice of an ssh2 channel this provider uses (ssh2@1.17.0 lib/Channel.js): the channel is stdout. No signal
 * request: ssh2 sends one only while stdin is open (Channel.js:237-246), so a kill goes by the pid instead (pidKill).
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
	username: string;
	privateKey?: string;
	password?: string;
	readyTimeout: number;
	keepaliveInterval: number;
	keepaliveCountMax: number;
	/** Given the host key's blob as the server sent it; false ends the handshake (lib/protocol/kex.js, "Host denied"). */
	hostVerifier?: (key: Buffer) => boolean;
	algorithms?: { serverHostKey: string[] };
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

/**
 * ssh2's keepalive, which also keeps the edge from seeing an idle tunnel (the CLI's ServerAliveInterval is 60 s, cli.js:32).
 * ssh2 pings every KEEPALIVE_MS and ends the connection at the tick after KEEPALIVE_COUNT_MAX pings went unanswered
 * (ssh2@1.17.0 lib/client.js sendKA), so a dead tunnel is noticed at most KEEPALIVE_MS × (KEEPALIVE_COUNT_MAX + 1) =
 * 15 s after its last answer, and every channel on it (the daemon's bridge among them) ends. ssh2's default count of 3
 * with a 30 s interval took 97 s on a deleted instance. Both are set: the bound never rests on ssh2's default.
 */
const KEEPALIVE_MS = 5_000;
const KEEPALIVE_COUNT_MAX = 2;
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

/**
 * A TCP connection to host:port's sshd, through the proxy's CONNECT tunnel when the proxy the process installed into
 * Node applies to it (env-proxy.ts).
 */
export function tcpTunnel(hostName: string, port: number): SshTunnel {
	const name = isIP(hostName) === 6 ? `[${hostName}]` : hostName;
	const host = `${name}:${port}`;
	const proxy = proxyFor(new URL(`https://${host}`));
	const through = proxy && tunnelThrough(proxy, name, port);
	const socket = through ? through.socket : tcp(port, hostName);
	// ssh2 reads the socket's errors once it has it; this keeps one before then from being thrown.
	socket.on("error", () => {});
	const failed = (error: Error) => new SshTunnelError(`the SSH connection to ${host}${proxy ? ` through the proxy ${proxy.host}` : ""} failed to open: ${error.message}`);
	const opened = through
		? through.opened.catch((error: Error) => Promise.reject(failed(error)))
		: new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", (error) => reject(failed(error)));
			});
	opened.catch(() => {});
	return { duplex: socket, opened, host };
}

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

/** How a host logs in to a machine's sshd: as root (MachineHost.exec's user), by a key or a password. */
export interface SshLogin {
	username: string;
	/** A private key in the PEM armor ssh2 reads (see pemOf). */
	privateKey?: string;
	password?: string;
	/** What no error may carry, beside the key and the password, which never do: a key inside the username (Morph's). */
	secrets?: readonly string[];
	/**
	 * The sshd's host key as the vendor hands it (boat's sshkey answer): its type and its blob, the base64 of an
	 * OpenSSH line decoded. The handshake offers that type alone and goes on only with that blob. Absent: any host key.
	 */
	hostKey?: { type: string; blob: Uint8Array };
}

/** The signature names a host key of this type signs under: an RSA key under three (RFC 8332), any other under its own. */
const hostKeyAlgorithms = (type: string): string[] => (type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] : [type]);

/** What a command starts with when the login is a user with passwordless sudo, not root (SshExecOptions.sudo). */
const SUDO = ["sudo", "-n", "--"];

export interface SshExecOptions {
	/** The host's own ssh2 package, or anything with the same slice. */
	ssh2: Ssh2Module;
	/** The login to machine id. */
	loginOf: (id: string) => SshLogin;
	tunnelOf: SshTunnelOf;
	/**
	 * Until when (ms since the epoch) a login machine id's sshd refuses is tried again, every DENIED_RETRY_MS within the
	 * call's bound: a key the vendor is still handing its machines (Agent37's, minutes after its registration). Absent,
	 * or past: a refused login fails at once.
	 */
	deniedUntil?: (id: string) => number;
	/**
	 * The login is a user with passwordless sudo, not root (boat's `user`): every command, the kill's too, runs under
	 * `sudo -n --`, so it is root's, as MachineHost.exec's are. With no terminal, sudo hands the command the channel's
	 * pipes as they are.
	 */
	sudo?: boolean;
}

/** The pause between two logins an sshd refused, while deniedUntil says the key may still reach it. */
const DENIED_RETRY_MS = 2_000;

/** MachineHost.exec over SSH: argv as the host's login, as channels on one connection per machine, shared by its execs. */
export class SshExec {
	readonly #ssh2: Ssh2Module;
	readonly #loginOf: (id: string) => SshLogin;
	readonly #tunnelOf: SshTunnelOf;
	readonly #deniedUntil: ((id: string) => number) | undefined;
	readonly #root: readonly string[];
	/**
	 * The SSH connections to each machine, opening, open, or done and still held, until each ends: one, and a second
	 * past CHANNELS_PER_CONNECTION channels. A done one takes no new channel; closeAll ends them all.
	 */
	readonly #links = new Map<string, Link[]>();

	constructor({ ssh2, loginOf, tunnelOf, deniedUntil, sudo = false }: SshExecOptions) {
		this.#ssh2 = ssh2;
		this.#loginOf = loginOf;
		this.#tunnelOf = tunnelOf;
		this.#deniedUntil = deniedUntil;
		this.#root = sudo ? SUDO : [];
	}

	/** Ends every connection to machine id, channels and all: the vendor calls it once the machine is deleted. */
	closeAll(id: string): void {
		for (const link of [...(this.#links.get(id) ?? [])]) this.#end(link);
	}

	/**
	 * An SSH session as the host's login over the machine's tunnel, its handshake within ctx. A tunnel that fails to
	 * open, or closes before the SSH handshake, is opened again after a pause, TUNNEL_TRIES times in all within ctx: an
	 * instance fresh from its create can refuse the first (seen live once in eight creates, the daemon's upload
	 * refused). Nothing has run before a handshake, so a retry repeats nothing. A refused key is tried again only while
	 * deniedUntil says it may still reach the machine; a handshake past its bound is not retried.
	 */
	async #ssh(id: string, ctx: HostCall): Promise<Ssh2Client> {
		const bound = boundOf(ctx.timeoutMs, ctx.signal, `the SSH connection to ${id}`);
		// Ends the handshake in flight when this call gives up on it (its bound passed, or the caller aborted).
		const givenUp = new AbortController();
		try {
			for (let attempt = 1; ; ) {
				let pause: number;
				try {
					return await Promise.race([this.#handshake(id, ctx.timeoutMs, givenUp.signal), bound.promise]);
				} catch (error) {
					const level = (error as { level?: unknown }).level;
					const left = level === "client-authentication" ? (this.#deniedUntil?.(id) ?? 0) - Date.now() : 0;
					const early = error instanceof SshTunnelError || level === "client-socket";
					if (left > 0) pause = Math.min(DENIED_RETRY_MS, left);
					else if (early && attempt < TUNNEL_TRIES) pause = TUNNEL_RETRY_MS * 2 ** (attempt++ - 1);
					else throw error;
				}
				await Promise.race([new Promise((resolve) => setTimeout(resolve, pause)), bound.promise]);
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
		const { username, privateKey, password, hostKey } = this.#loginOf(id);
		const pinned = hostKey && {
			hostVerifier: (key: Buffer) => key.length === hostKey.blob.length && timingSafeEqual(key, hostKey.blob),
			algorithms: { serverHostKey: hostKeyAlgorithms(hostKey.type) },
		};
		try {
			await Promise.race([opened, quitted]);
			await Promise.race([
				new Promise<void>((resolve, reject) => {
					client.once("ready", resolve);
					client.once("error", reject);
					client.connect({ sock: duplex, username, privateKey, password, readyTimeout: timeoutMs, keepaliveInterval: KEEPALIVE_MS, keepaliveCountMax: KEEPALIVE_COUNT_MAX, ...pinned });
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
	 * error with machine id's login secrets taken out of its message and stack, in place: its class, name and fields stay,
	 * which the adapter reads its code by. ssh2's words can carry the username, and a host's may hold a key.
	 */
	#redacted(id: string, error: unknown): Error {
		const { privateKey, password, secrets = [] } = this.#loginOf(id);
		const hidden = [privateKey, password, ...secrets];
		if (!(error instanceof Error)) return new Error(redact(String(error), hidden));
		error.message = redact(error.message, hidden);
		if (error.stack !== undefined) error.stack = redact(error.stack, hidden);
		return error;
	}

	/**
	 * argv as the host's login over SSH, under PID_WRAPPER (./scripts.ts), as one channel on the machine's shared
	 * connection (#start). stdout and stderr are the channel's, piped, the wrapper's line taken off stderr; end sends end
	 * of file. wait answers once the channel closes, with the exit-status, or -1 for an exit by signal or none. kill
	 * starts pidKill over a channel of its own (on a connection with room), which ends the process and every process
	 * under it, then closes the exec's channel, never a connection; if the close does not come, wait answers -1 and the
	 * connection takes no new channel.
	 */
	async exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess> {
		const opened = await this.#start(id, shellLine([...this.#root, ...PID_WRAPPER, ...argv]), ctx, `the exec in ${id}`).catch((error: unknown) => {
			throw this.#redacted(id, error);
		});
		const { link: held, channel } = opened;
		const stdout = new PassThrough();
		const raw = new PassThrough();
		channel.pipe(stdout);
		channel.stderr.pipe(raw);
		const { stderr, pid } = pidStderr(raw);
		let ended = false;
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
		return {
			stdout,
			stderr,
			write: (bytes) =>
				new Promise<void>((resolve, reject) => {
					if (ended || closed) return reject(new Error(ended ? "stdin was ended" : "the process has ended"));
					channel.write(bytes, (error) => (error ? reject(this.#redacted(id, error)) : resolve()));
				}),
			end: async () => {
				if (ended || closed) return;
				ended = true;
				channel.eof();
			},
			wait: () => exited,
			kill: async () => {
				if (closed) return;
				// The pid is the machine's, so the kill's channel goes on any connection with room, counted like an exec's. No
				// pid line within the grace (or the process ended meanwhile): closing the channel below is what is left.
				const target = await pid(KILL_GRACE_MS);
				if (target !== undefined && !closed) try {
					const killer = await this.#start(id, shellLine([...this.#root, ...pidKill(target)]), { timeoutMs: KILL_GRACE_MS }, `the kill in ${id}`);
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
		};
	}
}

/**
 * A private key in the PEM armor ssh2 reads (its parser wants the BEGIN and END lines on lines of their own), or
 * undefined when text is not one. A key pasted into Settings → Computers comes back on one line, since a password
 * field drops line breaks: its body is wrapped again at 70 characters, as ssh-keygen writes it. A PKCS#8 key
 * (the PEM label "PRIVATE KEY", Morph's GET /instance/{id}/ssh/key) is converted (fromPkcs8).
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
	const pem = armored(label, Buffer.from(body, "base64"));
	return label === "PRIVATE KEY" ? fromPkcs8(pem) : pem;
}

/** bytes as base64 between BEGIN and END lines of label, 70 characters a line. */
function armored(label: string, bytes: Buffer): string {
	return `-----BEGIN ${label}-----\n${bytes.toString("base64").match(/.{1,70}/g)?.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * A PKCS#8 key as the same key in a form ssh2 reads, or undefined for a body node:crypto can't read or a type SSH has
 * no use for here. ssh2 reads OpenSSH's own form, PKCS#1 RSA, SEC1 EC, DSA and PuTTY's, never PKCS#8 (ssh2@1.17.0
 * lib/protocol/keyParser.js parseKey: no parser matches, "Unsupported key format"). node:crypto writes RSA as PKCS#1 and
 * EC as SEC1; Ed25519 it writes only as PKCS#8, and ssh2 reads Ed25519 only in OpenSSH's form, so openSshEd25519 writes it.
 */
function fromPkcs8(pem: string): string | undefined {
	let key: KeyObject;
	try {
		key = createPrivateKey(pem);
	} catch {
		return undefined;
	}
	if (key.asymmetricKeyType === "rsa") return key.export({ type: "pkcs1", format: "pem" }) as string;
	if (key.asymmetricKeyType === "ec") return key.export({ type: "sec1", format: "pem" }) as string;
	if (key.asymmetricKeyType === "ed25519") return openSshEd25519(key);
	return undefined;
}

/**
 * An Ed25519 private key in OpenSSH's own format, unencrypted (openssh-portable PROTOCOL.key; sshkey.c writes it so):
 * "openssh-key-v1\0", cipher "none", KDF "none", empty KDF options, the key count 1, the public key blob (RFC 8709 §4:
 * "ssh-ed25519", the 32-byte public key), then the private section as one string: two equal random check words, the
 * key type, the public key, the 64-byte private key (the 32-byte seed, then the public key), an empty comment, and
 * the padding bytes 1, 2, 3, ... to a multiple of 8, the block size of cipher "none".
 */
function openSshEd25519(key: KeyObject): string {
	const { d, x } = key.export({ format: "jwk" });
	const seed = Buffer.from(d ?? "", "base64url");
	const publicKey = Buffer.from(x ?? "", "base64url");
	const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(publicKey)]);
	const check = randomBytes(4);
	const section = Buffer.concat([check, check, blob, sshString(Buffer.concat([seed, publicKey])), sshString("")]);
	const padding = Buffer.from(Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, index) => index + 1));
	const count = Buffer.alloc(4);
	count.writeUInt32BE(1);
	const body = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), sshString("none"), sshString("none"), sshString(""), count, sshString(blob), sshString(Buffer.concat([section, padding]))]);
	return armored("OPENSSH PRIVATE KEY", body);
}
