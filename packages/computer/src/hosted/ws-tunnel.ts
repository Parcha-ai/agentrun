// An SSH stream over a WebSocket, for a vendor whose machines' sshd is reached through its edge alone: the socket's
// binary frames carry the stream's bytes both ways (Agent37's edge, Tensorlake's TCP tunnel). The vendor opens the socket
// with its own URL and headers; this turns it into the Duplex ssh2 reads, and its failures into SshTunnelErrors.
import { Duplex } from "node:stream";
import { SshTunnelError } from "./ssh-exec.js";

/** A WebSocket as a provider uses one: Node's global WebSocket (undici), which takes headers, or the same slice. */
export interface WebSocketLike {
	binaryType: string;
	readonly readyState: number;
	readonly bufferedAmount: number;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "close" | "error", listener: (event: { code?: number; reason?: string; message?: string }) => void): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type WebSocketClass = new (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

/** How much a tunnel may hold unsent before a write waits for it (the WebSocket's bufferedAmount). */
const TUNNEL_HIGH_WATER = 1024 * 1024;
const TUNNEL_POLL_MS = 10;

/**
 * A WebSocket's binary stream as a Duplex for ssh2: what the socket gives is read, a write is one binary frame, and a
 * write waits while the socket holds more than TUNNEL_HIGH_WATER unsent. Its end closes the socket. `refused` is the
 * vendor's words for a socket closed before it opened: who the edge opens it for.
 */
export function tunnelOf(ws: WebSocketLike, host: string, refused: string): { duplex: Duplex; opened: Promise<void> } {
	let open = false;
	const duplex = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, done) {
			if (ws.readyState !== 1) return done(new SshTunnelError(`the SSH tunnel to ${host} is closed`));
			try {
				ws.send(chunk);
			} catch (error) {
				return done(error as Error);
			}
			const wait = () => {
				if (ws.readyState !== 1) done(new SshTunnelError(`the SSH tunnel to ${host} closed while it sent`));
				else if (ws.bufferedAmount <= TUNNEL_HIGH_WATER) done();
				else setTimeout(wait, TUNNEL_POLL_MS);
			};
			wait();
		},
		final(done) {
			try {
				ws.close(1000);
			} catch {
				// Closed already.
			}
			done();
		},
		destroy(error, done) {
			try {
				ws.close(1000);
			} catch {
				// Closed already.
			}
			done(error);
		},
	});
	ws.addEventListener("message", ({ data }) => {
		if (data instanceof ArrayBuffer) duplex.push(Buffer.from(data));
		else if (ArrayBuffer.isView(data)) duplex.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
		else if (typeof data === "string") duplex.push(Buffer.from(data, "utf8"));
	});
	const opened = new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => {
			open = true;
			resolve();
		});
		ws.addEventListener("error", (event) => {
			const error = new SshTunnelError(`the SSH tunnel to ${host} failed${open ? "" : " to open"}${event.message ? `: ${event.message}` : ""}`);
			if (!open) reject(error);
			else duplex.destroy(error);
		});
		ws.addEventListener("close", ({ code, reason }) => {
			if (!open) reject(new SshTunnelError(`the SSH tunnel to ${host} was refused (closed with ${code ?? "no code"}${reason ? `: ${reason}` : ""}); ${refused}`));
			else duplex.push(null);
		});
	});
	opened.catch(() => {});
	return { duplex, opened };
}
