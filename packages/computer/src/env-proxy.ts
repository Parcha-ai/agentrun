// The process's proxy for the two vendor clients Node's own proxy support never reaches: E2B's SDK, whose fetch is its
// own undici Agent (it takes a `proxy` URL instead), and Morph's SSH gateway, plain TCP to port 22, which rides an HTTP
// CONNECT tunnel. The library reads no environment (README, Settings): the proxy is the one the process installed into
// Node, by --use-env-proxy / NODE_USE_ENV_PROXY or http.setGlobalProxyFromEnv (serve calls it,
// packages/serve/src/env-proxy.ts), which Node keeps as https.globalAgent's proxyEnv and which global fetch, Node's
// WebSocket and https already use. Nothing installed: no proxy, the path as it was. Its variables are read as Node
// reads them: https_proxy or HTTPS_PROXY for a TLS target, http_proxy or HTTP_PROXY for a plain one, lowercase first;
// no_proxy or NO_PROXY lists the hosts that go direct (a host, host:port, .suffix, *.suffix, or * for all), and so
// does this machine's loopback, always.
import https from "node:https";
import { connect as tcp, type Socket } from "node:net";
import { connect as tls } from "node:tls";

/** The proxy variables as the process installed them into Node. */
export type ProxyEnv = Readonly<Record<string, string | undefined>>;

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/;
/** The most a proxy's answer to CONNECT may hold before its headers end; more is refused. */
const MAX_ANSWER_BYTES = 16 * 1024;

/**
 * The proxy variables Node's https global agent holds when the process installed a proxy; none when it didn't. Read
 * from the module object at each call: installing replaces https.globalAgent, and a named import keeps the old one.
 */
export function installedProxy(): ProxyEnv {
	return (https.globalAgent as unknown as { options?: { proxyEnv?: ProxyEnv } }).options?.proxyEnv ?? {};
}

/** The proxy URL the variables name for a TLS target, or a plain one. */
const proxyOf = (secure: boolean, env: ProxyEnv) => {
	const given = secure ? env.https_proxy || env.HTTPS_PROXY : env.http_proxy || env.HTTP_PROXY;
	return given && URL.canParse(given) ? new URL(given) : undefined;
};
/** NO_PROXY's entries, lowercase. */
const noProxy = (env: ProxyEnv) => (env.no_proxy || env.NO_PROXY || "").split(",").map((entry) => entry.trim().toLowerCase());
/** Whether a .suffix or *.suffix entry covers host (the suffix's own name included). */
const covers = (entry: string, host: string) => {
	const suffix = entry.startsWith("*.") ? entry.slice(1) : entry.startsWith(".") ? entry : undefined;
	return suffix !== undefined && (host.endsWith(suffix) || host === suffix.slice(1));
};

/** The proxy a call to target goes through, or undefined when it goes direct. */
export function proxyFor(target: URL, env: ProxyEnv = installedProxy()): URL | undefined {
	const secure = target.protocol === "https:" || target.protocol === "wss:";
	const host = target.hostname.toLowerCase();
	const hostPort = `${host}:${target.port || (secure ? "443" : "80")}`;
	if (LOOPBACK.test(host) || noProxy(env).some((entry) => entry === "*" || entry === host || entry === hostPort || covers(entry, host))) return undefined;
	return proxyOf(secure, env);
}

/**
 * The one proxy for a client that sends every call under domain (domain and each name below it) through the same one,
 * as E2B's SDK does: undefined only when NO_PROXY exempts them all ("*", or a .suffix entry covering domain). A list
 * that exempts some of them (api.<domain> alone) leaves the proxy on for all, since the hosts it doesn't exempt may
 * have no other way out.
 */
export function proxyForDomain(domain: string, env: ProxyEnv = installedProxy()): URL | undefined {
	const host = domain.toLowerCase();
	if (LOOPBACK.test(host) || noProxy(env).some((entry) => entry === "*" || covers(entry, host))) return undefined;
	return proxyOf(true, env);
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
				if (end < 0 && head.length > MAX_ANSWER_BYTES) return settle(new Error(`the proxy ${proxy.host} answered CONNECT ${host}:${port} with more than ${MAX_ANSWER_BYTES} bytes and no end of its headers`));
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
