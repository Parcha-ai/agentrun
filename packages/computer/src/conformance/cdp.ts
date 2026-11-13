// A CDP socket for the browser cases: one WebSocket to a browser's CDP URL, a command at a time by id, flat sessions by
// sessionId. The URL is a secret: no error here carries it, or any part of it.

/** An open CDP socket: send a command, to the browser or to an attached target's session, wait for an event, and close. */
export interface CdpSocket {
	send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
	/** The next event of this method (from this session, when given), with its params; ask before the command that causes it. */
	event<T = Record<string, unknown>>(method: string, sessionId?: string): Promise<T>;
	close(): void;
}

/** Opens a CDP socket to url; rejects in words that never carry the URL. */
export type CdpDialer = (url: string, options: { signal: AbortSignal }) => Promise<CdpSocket>;

/** The global WebSocket (Node 22), to a vendor's CDP URL. */
export const dialCdp: CdpDialer = (url, { signal }) =>
	new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error("the CDP socket was not opened: the case was aborted"));
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			return reject(new Error("the CDP URL is not one a WebSocket opens"));
		}
		const pending = new Map<number, { method: string; resolve: (value: never) => void; reject: (error: Error) => void }>();
		const waiting: Array<{ method: string; sessionId: string | undefined; resolve: (value: never) => void; reject: (error: Error) => void }> = [];
		let next = 0;
		let opened = false;
		const failAll = (why: string) => {
			for (const [id, call] of pending) {
				pending.delete(id);
				call.reject(new Error(`CDP ${call.method}: ${why}`));
			}
			for (const waiter of waiting.splice(0)) waiter.reject(new Error(`CDP ${waiter.method}: ${why}`));
		};
		const stop = () => ws.close();
		signal.addEventListener("abort", stop, { once: true });
		ws.addEventListener("open", () => {
			opened = true;
			resolve({
				send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
					return new Promise<T>((yes, no) => {
						if (ws.readyState !== WebSocket.OPEN) return no(new Error(`CDP ${method}: the socket is closed`));
						const id = ++next;
						pending.set(id, { method, resolve: yes as (value: never) => void, reject: no });
						ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
					});
				},
				event<T>(method: string, sessionId?: string) {
					return new Promise<T>((yes, no) => {
						if (ws.readyState !== WebSocket.OPEN) return no(new Error(`CDP ${method}: the socket is closed`));
						waiting.push({ method, sessionId, resolve: yes as (value: never) => void, reject: no });
					});
				},
				close() {
					signal.removeEventListener("abort", stop);
					ws.close();
				},
			});
		});
		ws.addEventListener("message", (event) => {
			let message: { id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown; params?: unknown; sessionId?: unknown };
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (typeof message.method === "string" && message.id === undefined) {
				const at = waiting.findIndex((w) => w.method === message.method && (w.sessionId === undefined || w.sessionId === message.sessionId));
				if (at >= 0) waiting.splice(at, 1)[0]?.resolve((message.params ?? {}) as never);
				return;
			}
			if (typeof message.id !== "number") return;
			const call = pending.get(message.id);
			if (call === undefined) return;
			pending.delete(message.id);
			if (message.error !== undefined) call.reject(new Error(`CDP ${call.method}: ${typeof message.error.message === "string" ? message.error.message : "an error"}`));
			else call.resolve(message.result as never);
		});
		ws.addEventListener("error", () => {
			if (!opened) reject(new Error("the CDP socket could not be opened"));
		});
		ws.addEventListener("close", () => {
			signal.removeEventListener("abort", stop);
			if (!opened) reject(new Error("the CDP socket closed before it opened"));
			failAll("the socket closed");
		});
	});
