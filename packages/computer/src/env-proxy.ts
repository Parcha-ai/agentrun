// The standard proxy variables for the two vendor clients Node's own proxy support never reaches: E2B's SDK, whose
// fetch is its own undici Agent (it takes a `proxy` URL instead), and Morph's SSH gateway, plain TCP to port 22, which
// rides an HTTP CONNECT tunnel. Every other vendor call (fetch, Node's global WebSocket, https) goes through the proxy
// once serve installs it for the process (packages/serve/src/env-proxy.ts). The variables are read as Node reads them:
// https_proxy or HTTPS_PROXY for a TLS target, http_proxy or HTTP_PROXY for a plain one, lowercase first; no_proxy or
// NO_PROXY lists the hosts that go direct (a host, host:port, .suffix, *.suffix, or * for all), and so does this
// machine's loopback, always. None set: no proxy, the path as it was.
import { connect as tcp, type Socket } from "node:net";
import { connect as tls } from "node:tls";

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/;

/** The proxy a call to target goes through, or undefined when it goes direct. */
export function proxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
	const secure = target.protocol === "https:" || target.protocol === "wss:";
	const given = secure ? env.https_proxy || env.HTTPS_PROXY : env.http_proxy || env.HTTP_PROXY;
	if (!given || !URL.canParse(given)) return undefined;
	const host = target.hostname.toLowerCase();
	if (LOOPBACK.test(host)) return undefined;
	const hostPort = `${host}:${target.port || (secure ? "443" : "80")}`;
	for (const raw of (env.no_proxy || env.NO_PROXY || "").split(",")) {
		const entry = raw.trim().toLowerCase();
		if (entry === "*" || entry === host || entry === hostPort) return undefined;
		const suffix = entry.startsWith("*.") ? entry.slice(1) : entry.startsWith(".") ? entry : undefined;
		if (suffix !== undefined && (host.endsWith(suffix) || host === suffix.slice(1))) return undefined;
	}
	return new URL(given);
}

/**
 * A socket to host:port through proxy's CONNECT tunnel: the socket at once (it is the proxy's), and opened, which
 * resolves once the proxy answered 200 and rejects with the proxy's words otherwise. Bytes after the proxy's answer stay
 * in the socket for its next reader. The proxy's own login, when its URL has one, goes as Proxy-Authorization.
 */
export function tunnelThrough(proxy: URL, host: string, port: number): { socket: Socket; opened: Promise<void> } {
	const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
	const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
	const socket = proxy.protocol === "https:" ? tls({ host: proxyHost, port: proxyPort, servername: proxyHost }) : tcp(proxyPort, proxyHost);
	const login = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n` : "";
	const opened = new Promise<void>((resolve, reject) => {
		let head = Buffer.alloc(0);
		const settle = (error?: Error) => {
			socket.off("readable", read).off("error", settle).off("end", ended);
			if (error === undefined) return resolve();
			socket.destroy();
			reject(error);
		};
		const ended = () => settle(new Error(`the proxy ${proxy.host} closed the connection before it answered CONNECT ${host}:${port}`));
		const read = () => {
			for (let chunk: Buffer | null; (chunk = socket.read() as Buffer | null) !== null; ) {
				head = Buffer.concat([head, chunk]);
				const end = head.indexOf("\r\n\r\n");
				if (end < 0) continue;
				const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"))?.[1];
				if (status !== "200") return settle(new Error(`the proxy ${proxy.host} answered ${status ?? "no HTTP status"} to CONNECT ${host}:${port}`));
				settle();
				if (end + 4 < head.length) socket.unshift(head.subarray(end + 4));
				return;
			}
		};
		socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${login}\r\n`));
		socket.on("readable", read).on("error", settle).on("end", ended);
	});
	return { socket, opened };
}
