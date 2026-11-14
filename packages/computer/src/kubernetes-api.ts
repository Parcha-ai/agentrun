// The Kubernetes API as the Kubernetes host (./kubernetes.ts) reaches it: JSON calls over node:https, and a pod's exec
// over a WebSocket of Kubernetes' channel protocol (v5.channel.k8s.io, else v4). node:https rather than fetch, because a
// cluster's API usually has its own CA and may take a client certificate, which the global fetch cannot be given
// without a dependency. No Kubernetes client library: this package has no dependencies.
//
// Every failure is a Result in words that name the method, the path and the status, never a header or a token. A 429, a
// 5xx, a call that did not answer in time and one that could not reach the API are transient (ComputerError.transient);
// a 4xx never is, a ResourceQuota refusal included (it is code limit).
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Socket } from "node:net";
import { type ComputerError, type ComputerErrorCode, ok, type Result } from "./result.js";

/** The vendor named by every failure of code vendor. */
export const KUBERNETES = "kubernetes";

/** What reaches the API server's TLS: its CA (PEM), a client certificate and key (PEM), or none (the system's CAs). */
export interface KubeTls {
	ca?: string;
	cert?: string;
	key?: string;
}

/** A bearer token and, when known, when it ends (ms since the epoch). */
export interface BearerToken {
	token: string;
	expiresAt?: number;
}

/**
 * Where the bearer token of every call comes from: asked before each call; a source caches what it can (a file it reads
 * again, a Google token it mints again near its end). After a 401 the call asks again once with `fresh`.
 */
export type TokenSource = (fresh: boolean) => Promise<Result<BearerToken>>;

/** One API server, as every call reaches it. */
export interface KubeEndpoint {
	/** https://host[:port][/prefix]: the API server, or a proxy in front of it. */
	server: string;
	tls: KubeTls;
	/** None: the client certificate (tls.cert) is the credential, or a proxy in front authenticates. */
	token?: TokenSource;
}

/** One JSON call. */
export interface KubeCall {
	query?: Record<string, string | undefined>;
	/** A body, sent as JSON with contentType (default application/json). */
	json?: unknown;
	contentType?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Statuses that answer as values ({ status, body }) rather than failures; default 2xx alone. */
	accept?: (status: number) => boolean;
}

/** The API's answer to one call: its status and its body as JSON (undefined for none or not JSON). */
export interface KubeAnswer {
	status: number;
	body: unknown;
}

/** One exec stream, as the host's process wraps it. */
export interface KubeStream {
	/** The protocol the server chose: v5 can end stdin; v4 cannot. */
	protocol: string;
	/** Sends one message: a channel byte, then the bytes. Resolves once it is handed to the socket. */
	send(channel: number, bytes: Uint8Array): Promise<void>;
	/** Each message as it comes: its channel and bytes. */
	onMessage(listener: (channel: number, bytes: Uint8Array) => void): void;
	/** Once, when the stream ends: closed by either side, or failed (with words). */
	onEnd(listener: (error?: Error) => void): void;
	close(): void;
}

/** The transport the host calls through: this module's, or a test's stand-in. */
export interface KubeTransport {
	call(method: string, path: string, init: KubeCall): Promise<Result<KubeAnswer>>;
	stream(path: string, query: Array<[string, string]>, protocols: readonly string[], init: { timeoutMs: number; signal?: AbortSignal }): Promise<Result<KubeStream>>;
}

/** Kubernetes' exec subprotocols, best first: v5 adds the close message that ends stdin (Kubernetes 1.30 and later). */
export const EXEC_PROTOCOLS = ["v5.channel.k8s.io", "v4.channel.k8s.io"] as const;

const CONNECTION = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE|socket hang up/i;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const decoder = new TextDecoder();

/** A status as a code: 401/403 denied (a quota's 403 limit), 404/410 not_found, 409 exists, 429 limit, 400/422 invalid, else vendor. */
export function kubeCode(status: number, message: string): ComputerErrorCode {
	if (status === 403 && /exceeded quota/i.test(message)) return "limit";
	if (status === 401 || status === 403) return "denied";
	if (status === 404 || status === 410) return "not_found";
	if (status === 409) return "exists";
	if (status === 429) return "limit";
	if (status === 400 || status === 422) return "invalid";
	if (status === 408 || status === 504) return "timeout";
	return "vendor";
}

/** The API server's own words for a failure (a Status' message), else the body's first 300 characters. */
function said(text: string): string {
	try {
		const status = JSON.parse(text) as { message?: unknown };
		if (typeof status?.message === "string" && status.message !== "") return status.message.slice(0, 500);
	} catch {
		// Not a Status: the text itself.
	}
	return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The error of an answer the call does not take: its status, words, code, and transient for a 429 or a 5xx. */
export function answerError(what: string, status: number, text: string): ComputerError {
	const words = said(text);
	const code = kubeCode(status, words);
	return { code, ...(code === "vendor" ? { vendor: KUBERNETES } : {}), message: `${what}: ${status}${words ? ` ${words}` : ""}`, ...(status === 429 || status >= 500 ? { transient: true as const } : {}) };
}

/** The error of a call that got no answer: a timeout, an abort, or the API not reached (transient, all but the abort). */
function causeError(what: string, cause: unknown, timedOut: boolean, aborted: boolean, timeoutMs: number): ComputerError {
	if (aborted) return { code: "aborted", message: `${what} was aborted` };
	if (timedOut) return { code: "timeout", message: `${what} did not answer within ${timeoutMs / 1000} s`, transient: true };
	const message = (cause as Error | undefined)?.message ?? String(cause);
	const code = (cause as { code?: unknown } | undefined)?.code;
	const unreachable = CONNECTION.test(`${typeof code === "string" ? code : ""} ${message}`);
	return { code: unreachable ? "unreachable" : "vendor", ...(unreachable ? {} : { vendor: KUBERNETES }), message: `${what}: ${unreachable ? "the Kubernetes API could not be reached: " : ""}${message}`, transient: true };
}

/** The node:https options of one request to the endpoint. */
function requestOptions(endpoint: KubeEndpoint, method: string, url: URL, headers: Record<string, string>): RequestOptions {
	return {
		method,
		protocol: url.protocol,
		hostname: url.hostname.replace(/^\[|\]$/g, ""),
		port: url.port === "" ? 443 : Number(url.port),
		path: `${url.pathname}${url.search}`,
		headers,
		...(endpoint.tls.ca ? { ca: endpoint.tls.ca } : {}),
		...(endpoint.tls.cert ? { cert: endpoint.tls.cert } : {}),
		...(endpoint.tls.key ? { key: endpoint.tls.key } : {}),
		// One connection per call: a pooled socket could outlive a rotated client certificate, and calls are few.
		agent: false,
	};
}

/** The URL of a path on the endpoint, its prefix kept. */
function urlOf(endpoint: KubeEndpoint, path: string, query: Array<[string, string]>): URL {
	const base = new URL(endpoint.server);
	const url = new URL(`${base.pathname.replace(/\/+$/, "")}${path}`, base);
	for (const [key, value] of query) url.searchParams.append(key, value);
	return url;
}

/** The Kubernetes API reached over node:https; every call is bounded by its timeout and signal, and retried once on a 401 with a fresh token. */
export function kubeTransport(endpoint: KubeEndpoint): KubeTransport {
	const server = new URL(endpoint.server);
	if (server.protocol !== "https:") throw new Error(`the Kubernetes API URL must be https, so a token never crosses in the clear: ${server.protocol}`);

	async function authorization(fresh: boolean): Promise<Result<Record<string, string>>> {
		if (endpoint.token === undefined) return ok({});
		const got = await endpoint.token(fresh);
		if (!got.ok) return got;
		return ok({ Authorization: `Bearer ${got.value.token}` });
	}

	async function callOnce(method: string, path: string, init: KubeCall, fresh: boolean): Promise<Result<KubeAnswer>> {
		const what = `${method} ${path}`;
		const query = Object.entries(init.query ?? {}).flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as [string, string]]));
		const url = urlOf(endpoint, path, query);
		const auth = await authorization(fresh);
		if (!auth.ok) return auth;
		const body = init.json === undefined ? undefined : Buffer.from(JSON.stringify(init.json));
		const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "agentrun-computer", ...auth.value, ...(body ? { "Content-Type": init.contentType ?? "application/json", "Content-Length": String(body.length) } : {}) };
		if (init.signal?.aborted) return { ok: false, error: { code: "aborted", message: `${what} was aborted` } };
		return new Promise((settle) => {
			let settled = false;
			let timedOut = false;
			const done = (result: Result<KubeAnswer>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				init.signal?.removeEventListener("abort", onAbort);
				settle(result);
			};
			const req = httpsRequest(requestOptions(endpoint, method, url, headers), (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("error", (cause) => done({ ok: false, error: causeError(what, cause, timedOut, init.signal?.aborted === true, init.timeoutMs) }));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					const status = res.statusCode ?? 0;
					let parsed: unknown;
					try {
						parsed = text === "" ? undefined : JSON.parse(text);
					} catch {
						parsed = undefined;
					}
					const accepted = init.accept ?? ((one: number) => one >= 200 && one < 300);
					if (accepted(status)) done(ok({ status, body: parsed }));
					else done({ ok: false, error: answerError(what, status, text) });
				});
			});
			const onAbort = () => {
				req.destroy(new Error("aborted"));
				done({ ok: false, error: { code: "aborted", message: `${what} was aborted` } });
			};
			const timer = setTimeout(() => {
				timedOut = true;
				req.destroy(new Error("timed out"));
				done({ ok: false, error: causeError(what, undefined, true, false, init.timeoutMs) });
			}, init.timeoutMs);
			init.signal?.addEventListener("abort", onAbort, { once: true });
			req.on("error", (cause) => done({ ok: false, error: causeError(what, cause, timedOut, init.signal?.aborted === true, init.timeoutMs) }));
			req.end(body);
		});
	}

	async function streamOnce(path: string, query: Array<[string, string]>, protocols: readonly string[], init: { timeoutMs: number; signal?: AbortSignal }, fresh: boolean): Promise<Result<KubeStream>> {
		const what = `exec ${path}`;
		const url = urlOf(endpoint, path, query);
		const auth = await authorization(fresh);
		if (!auth.ok) return auth;
		const key = randomBytes(16).toString("base64");
		const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, "Sec-WebSocket-Protocol": protocols.join(", "), "User-Agent": "agentrun-computer", ...auth.value };
		if (init.signal?.aborted) return { ok: false, error: { code: "aborted", message: `${what} was aborted` } };
		return new Promise((settle) => {
			let settled = false;
			let timedOut = false;
			const done = (result: Result<KubeStream>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				init.signal?.removeEventListener("abort", onAbort);
				settle(result);
			};
			// A WebSocket upgrade is a GET; node:https hands the upgraded socket to the "upgrade" listener.
			const req = httpsRequest(requestOptions(endpoint, "GET", url, headers));
			req.on("upgrade", (res: IncomingMessage, socket: Socket, head: Buffer) => {
				const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
				const protocol = String(res.headers["sec-websocket-protocol"] ?? "");
				if (res.headers["sec-websocket-accept"] !== accept) {
					socket.destroy();
					return done({ ok: false, error: { code: "vendor", vendor: KUBERNETES, message: `${what}: the WebSocket answer did not accept this request's key` } });
				}
				if (!protocols.includes(protocol)) {
					socket.destroy();
					return done({ ok: false, error: { code: "unsupported", message: `${what}: the API server chose the exec protocol ${JSON.stringify(protocol)}, not one of ${protocols.join(", ")}: the cluster's Kubernetes is too old for this provider (1.30 or later speaks v5.channel.k8s.io)` } });
				}
				done(ok(webSocket(socket, head, protocol)));
			});
			req.on("response", (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => done({ ok: false, error: answerError(what, res.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")) }));
			});
			const onAbort = () => {
				req.destroy(new Error("aborted"));
				done({ ok: false, error: { code: "aborted", message: `${what} was aborted` } });
			};
			const timer = setTimeout(() => {
				timedOut = true;
				req.destroy(new Error("timed out"));
				done({ ok: false, error: causeError(what, undefined, true, false, init.timeoutMs) });
			}, init.timeoutMs);
			init.signal?.addEventListener("abort", onAbort, { once: true });
			req.on("error", (cause) => done({ ok: false, error: causeError(what, cause, timedOut, init.signal?.aborted === true, init.timeoutMs) }));
			req.end();
		});
	}

	return {
		async call(method, path, init) {
			const first = await callOnce(method, path, init, false);
			if (first.ok || first.error.code !== "denied" || !/: 401\b/.test(first.error.message) || endpoint.token === undefined) return first;
			return callOnce(method, path, init, true);
		},
		async stream(path, query, protocols, init) {
			const first = await streamOnce(path, query, protocols, init, false);
			if (first.ok || first.error.code !== "denied" || !/: 401\b/.test(first.error.message) || endpoint.token === undefined) return first;
			return streamOnce(path, query, protocols, init, true);
		},
	};
}

/**
 * A client WebSocket (RFC 6455) over an upgraded socket, as Kubernetes' channel protocol uses it: binary messages whose
 * first byte is the channel. Frames it sends are masked; a ping is answered; a close is answered and ends the stream.
 */
export function webSocket(socket: Socket, head: Buffer, protocol: string): KubeStream {
	const messageListeners: Array<(channel: number, bytes: Uint8Array) => void> = [];
	const endListeners: Array<(error?: Error) => void> = [];
	let buffered: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
	let fragments: Buffer[] = [];
	let ended = false;
	let closeSent = false;
	socket.setNoDelay(true);

	const end = (error?: Error) => {
		if (ended) return;
		ended = true;
		for (const listener of endListeners) listener(error);
		socket.destroy();
	};

	const frame = (opcode: number, payload: Buffer): Buffer => {
		const mask = randomBytes(4);
		const length = payload.length;
		const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		if (length < 126) header[1] = 0x80 | length;
		else if (length < 65536) {
			header[1] = 0x80 | 126;
			header.writeUInt16BE(length, 2);
		} else {
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		const masked = Buffer.alloc(length);
		for (let at = 0; at < length; at++) masked[at] = (payload[at] as number) ^ (mask[at % 4] as number);
		return Buffer.concat([header, mask, masked]);
	};

	const write = (bytes: Buffer): Promise<void> =>
		new Promise((resolve, reject) => {
			if (ended || socket.destroyed) return reject(new Error("the exec stream has ended"));
			socket.write(bytes, (error) => (error ? reject(error) : resolve()));
		});

	const deliver = (message: Buffer) => {
		if (message.length === 0) return;
		const channel = message[0] as number;
		const bytes = new Uint8Array(message.subarray(1));
		for (const listener of messageListeners) listener(channel, bytes);
	};

	const parse = () => {
		for (;;) {
			if (buffered.length < 2) return;
			const first = buffered[0] as number;
			const second = buffered[1] as number;
			const fin = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let at = 2;
			if (length === 126) {
				if (buffered.length < 4) return;
				length = buffered.readUInt16BE(2);
				at = 4;
			} else if (length === 127) {
				if (buffered.length < 10) return;
				const big = buffered.readBigUInt64BE(2);
				if (big > BigInt(64 * 1024 * 1024)) return end(new Error("the exec stream sent a frame over 64 MiB"));
				length = Number(big);
				at = 10;
			}
			const maskAt = at;
			if (masked) at += 4;
			if (buffered.length < at + length) return;
			let payload = buffered.subarray(at, at + length);
			if (masked) {
				const key = buffered.subarray(maskAt, maskAt + 4);
				payload = Buffer.from(payload.map((byte, index) => byte ^ (key[index % 4] as number)));
			}
			buffered = buffered.subarray(at + length);
			if (opcode === 0x8) {
				// Close: answered once, then the stream ends.
				if (!closeSent) {
					closeSent = true;
					socket.write(frame(0x8, Buffer.alloc(0)));
				}
				return end();
			}
			if (opcode === 0x9) {
				socket.write(frame(0xa, Buffer.from(payload)));
				continue;
			}
			if (opcode === 0xa) continue;
			if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
				fragments.push(Buffer.from(payload));
				if (fin) {
					const message = Buffer.concat(fragments);
					fragments = [];
					deliver(message);
				}
			}
		}
	};

	socket.on("data", (chunk: Buffer) => {
		buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
		parse();
	});
	socket.on("end", () => end());
	socket.on("close", () => end());
	socket.on("error", (error) => end(error));
	// The head may already hold frames; parsed once the caller has had a turn to listen.
	if (buffered.length > 0) queueMicrotask(parse);

	return {
		protocol,
		send: (channel, bytes) => write(frame(0x2, Buffer.concat([Buffer.from([channel]), Buffer.from(bytes)]))),
		onMessage: (listener) => void messageListeners.push(listener),
		onEnd: (listener) => {
			if (ended) listener();
			else endListeners.push(listener);
		},
		close() {
			if (ended) return;
			if (!closeSent && !socket.destroyed) {
				closeSent = true;
				socket.write(frame(0x8, Buffer.from([0x03, 0xe8])));
			}
			// The server's answering close ends it; a server that never answers is let go of shortly.
			setTimeout(() => end(), 1_000).unref();
		},
	};
}

/** The exit code of an exec's status message (channel 3): 0 for Success, a NonZeroExitCode's code, else undefined and words. */
export function execStatus(bytes: Uint8Array): { code: number } | { failure: string } {
	let status: { status?: unknown; message?: unknown; reason?: unknown; details?: { causes?: Array<{ reason?: unknown; message?: unknown }> } };
	try {
		status = JSON.parse(decoder.decode(bytes)) as typeof status;
	} catch {
		return { failure: `the exec's status is not JSON: ${decoder.decode(bytes).slice(0, 200)}` };
	}
	if (status.status === "Success") return { code: 0 };
	const exit = status.details?.causes?.find((cause) => cause.reason === "ExitCode")?.message;
	if (typeof exit === "string" && /^\d+$/.test(exit)) return { code: Number(exit) };
	return { failure: typeof status.message === "string" ? status.message : `the exec failed (${String(status.reason ?? "no reason given")})` };
}
