// The proxy variables for the two vendor clients Node's own proxy support never reaches (env-proxy.ts): E2B's SDK, which
// fetches through its own undici Agent, and Morph's SSH gateway, plain TCP. A local CONNECT proxy counts the tunnels
// each asks for: with HTTPS_PROXY set, the vendor call goes through it; with NO_PROXY naming the host, to loopback, or
// with no proxy set, none does. Every other provider's calls (fetch, Node's WebSocket, gRPC) are serve's installer's,
// tested in packages/serve/test/env-proxy.test.mjs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import test from "node:test";
import { fakeMorph } from "./fake-morph.mjs";

const { proxyFor, proxyForDomain, tunnelThrough } = await import("../dist/env-proxy.js");
const { connectionOptions } = await import("../dist/e2b.js");
const { MorphProvider } = await import("../dist/morph.js");

const CTX = { timeoutMs: 10_000 };
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];

/**
 * A CONNECT proxy on loopback: every tunnel asked for, with its Proxy-Authorization; a target in forward is piped to
 * that loopback port, any other answered 502. A plain request is no tunnel (a box's port watcher sends one): 502.
 */
async function connectProxy(t, forward = {}) {
	const tunnels = [];
	const server = createServer((req, res) => res.writeHead(502).end());
	server.on("connect", (req, socket, head) => {
		tunnels.push({ target: req.url, auth: req.headers["proxy-authorization"] });
		const port = forward[req.url];
		if (port === undefined) return socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		const upstream = connect(port, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			upstream.pipe(socket).pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		// A box's port watcher may hold a connection open.
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	return { url: `http://127.0.0.1:${server.address().port}`, tunnels };
}

/** process.env's proxy variables as given (the rest of them unset) while fn runs. */
async function withProxyEnv(values, fn) {
	const before = Object.fromEntries(PROXY_VARS.map((name) => [name, process.env[name]]));
	for (const name of PROXY_VARS) delete process.env[name];
	Object.assign(process.env, values);
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("proxyFor reads the variables as Node does: https_proxy then HTTPS_PROXY for TLS, http ones for plain, NO_PROXY's hosts and loopback direct", () => {
	const proxy = "http://proxy.example:3128";
	const via = (url, env) => proxyFor(new URL(url), env)?.href;
	assert.equal(via("https://api.e2b.app", {}), undefined, "nothing set: direct");
	assert.equal(via("https://api.e2b.app", { HTTPS_PROXY: proxy }), `${proxy}/`);
	assert.equal(via("wss://api.e2b.app", { HTTPS_PROXY: proxy }), `${proxy}/`, "wss is TLS");
	assert.equal(via("http://api.e2b.app", { HTTPS_PROXY: proxy }), undefined, "a plain target takes HTTP_PROXY alone");
	assert.equal(via("http://api.e2b.app", { HTTP_PROXY: proxy }), `${proxy}/`);
	assert.equal(via("https://api.e2b.app", { https_proxy: "http://lower:1", HTTPS_PROXY: proxy }), "http://lower:1/", "lowercase first");
	assert.equal(via("https://api.e2b.app", { HTTPS_PROXY: "not a url" }), undefined);
	for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]"]) assert.equal(via(`https://${host}:8443`, { HTTPS_PROXY: proxy }), undefined, `${host} is loopback`);
	for (const noProxy of ["api.e2b.app", "API.E2B.app", ".e2b.app", "*.e2b.app", "other,api.e2b.app", " other , .e2b.app ", "*", "api.e2b.app:443"]) {
		assert.equal(via("https://api.e2b.app", { HTTPS_PROXY: proxy, NO_PROXY: noProxy }), undefined, noProxy);
	}
	for (const noProxy of ["e2b.app", "pi.e2b.app", "api.e2b.app:8443", "other"]) {
		assert.equal(via("https://api.e2b.app", { HTTPS_PROXY: proxy, NO_PROXY: noProxy }), `${proxy}/`, noProxy);
	}
	assert.equal(via("https://api.e2b.app", { HTTPS_PROXY: proxy, no_proxy: "other", NO_PROXY: "api.e2b.app" }), `${proxy}/`, "no_proxy first, as Node reads it");
});

test("proxyForDomain, for a client with one proxy for every host under a domain: direct only when NO_PROXY exempts them all", () => {
	const proxy = "http://proxy.example:3128";
	const via = (domain, env) => proxyForDomain(domain, env)?.href;
	assert.equal(via("e2b.app", {}), undefined);
	for (const noProxy of [".e2b.app", "*.e2b.app", ".app", "other, .E2B.app", "*"]) assert.equal(via("e2b.app", { HTTPS_PROXY: proxy, NO_PROXY: noProxy }), undefined, noProxy);
	// api.e2b.app alone leaves each sandbox's host to the proxy, so the one proxy stays on for all.
	for (const noProxy of ["api.e2b.app", "e2b.app", "49983-sbx.e2b.app", "other"]) assert.equal(via("e2b.app", { HTTPS_PROXY: proxy, NO_PROXY: noProxy }), `${proxy}/`, noProxy);
	assert.equal(via("localhost", { HTTPS_PROXY: proxy }), undefined, "loopback");
});

test("a proxy whose answer to CONNECT runs past 16 KiB with no end of its headers is refused", async (t) => {
	const sockets = new Set();
	const server = createNetServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("data", () => socket.write(`HTTP/1.1 200 OK\r\nX-Pad: ${"a".repeat(20_000)}`));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		return new Promise((resolve) => server.close(resolve));
	});
	const { socket, opened } = tunnelThrough(new URL(`http://127.0.0.1:${server.address().port}`), "ssh.morph.test", 22);
	await assert.rejects(opened, /more than 16384 bytes and no end of its headers/);
	assert.ok(socket.destroyed);
});

test("E2B's real SDK sends its API call through HTTPS_PROXY's CONNECT tunnel; with NO_PROXY naming the domain, or no proxy, none", async (t) => {
	const sdk = await import("e2b").catch(() => undefined);
	if (sdk === undefined) return t.skip("the e2b package is not installed here");
	const proxy = await connectProxy(t);
	const options = (env) => connectionOptions({ apiKey: "fake-test-key", domain: "e2b.test" }, env);
	const getInfo = (env) => sdk.Sandbox.getInfo("sbx-0123456789", { ...options(env), requestTimeoutMs: 3_000 }).catch((error) => error);
	assert.ok((await getInfo({ HTTPS_PROXY: proxy.url })) instanceof Error, "the proxy answers 502");
	assert.ok(proxy.tunnels.length > 0, "a tunnel was asked for");
	assert.deepEqual([...new Set(proxy.tunnels.map(({ target }) => target))], ["api.e2b.test:443"]);
	proxy.tunnels.length = 0;
	assert.equal(options({ HTTPS_PROXY: proxy.url, NO_PROXY: "api.e2b.test" }).proxy, `${proxy.url}/`, "the API alone exempt: the sandboxes' hosts still need the proxy");
	for (const env of [{ HTTPS_PROXY: proxy.url, NO_PROXY: ".e2b.test" }, {}]) {
		assert.equal(options(env).proxy, undefined);
		await getInfo(env);
		assert.deepEqual(proxy.tunnels, [], JSON.stringify(env));
	}
});

test("Morph's SSH gateway goes through HTTPS_PROXY's CONNECT tunnel, with the proxy's login; loopback, NO_PROXY's hosts and no proxy go direct", async (t) => {
	const fake = await fakeMorph();
	t.after(() => fake.sshd.close());
	const snapshot = fake.rest.snapshot({}).id;
	const gateway = `ssh.morph.test:${fake.sshd.port}`;
	const proxy = await connectProxy(t, { [gateway]: fake.sshd.port });
	const exec = async (options) => {
		const { host } = new MorphProvider({ ...fake.options, ...options });
		const machine = await host.create({ name: "computer-0123456789ab", image: snapshot, labels: { "agentrun.computer": "1", "agentrun.computer.name": "computer-0123456789ab" }, lifetimeMs: 600_500, egress: false }, CTX);
		const proc = await host.exec(machine.id, ["true"], CTX);
		await proc.end();
		return proc.wait();
	};
	const login = new URL(proxy.url);
	login.username = "lane";
	login.password = "p@ss";
	await withProxyEnv({ HTTPS_PROXY: login.href }, async () => {
		assert.equal(await exec({ sshHost: "ssh.morph.test" }), 0, "the exec ran through the tunnel");
	});
	assert.deepEqual([...new Set(proxy.tunnels.map(({ target }) => target))], [gateway]);
	assert.equal(proxy.tunnels[0].auth, `Basic ${Buffer.from("lane:p@ss").toString("base64")}`);
	proxy.tunnels.length = 0;
	for (const env of [{ HTTPS_PROXY: proxy.url }, {}]) {
		await withProxyEnv(env, async () => assert.equal(await exec({}), 0, "the gateway on 127.0.0.1, direct"));
	}
	await withProxyEnv({ HTTPS_PROXY: proxy.url, NO_PROXY: ".morph.test" }, async () => {
		await assert.rejects(exec({ sshHost: "ssh.morph.test" }), /ssh\.morph\.test/, "direct to a name that never resolves");
	});
	assert.deepEqual(proxy.tunnels, []);
});

test("a proxy that refuses the tunnel fails Morph's exec in words that name the proxy and never its login", async (t) => {
	const fake = await fakeMorph();
	t.after(() => fake.sshd.close());
	const snapshot = fake.rest.snapshot({}).id;
	const proxy = await connectProxy(t);
	const login = new URL(proxy.url);
	login.username = "lane";
	login.password = "not-a-secret";
	await withProxyEnv({ HTTPS_PROXY: login.href }, async () => {
		const { host } = new MorphProvider({ ...fake.options, sshHost: "ssh.morph.test" });
		const machine = await host.create({ name: "computer-0123456789ab", image: snapshot, labels: { "agentrun.computer": "1", "agentrun.computer.name": "computer-0123456789ab" }, lifetimeMs: 600_500, egress: false }, CTX);
		const error = await host.exec(machine.id, ["true"], CTX).then(() => assert.fail("it ran"), (thrown) => thrown);
		assert.match(error.message, /through the proxy 127\.0\.0\.1:\d+/);
		assert.match(error.message, /answered 502 to CONNECT ssh\.morph\.test:\d+/);
		assert.doesNotMatch(error.message, /not-a-secret|lane/);
	});
});
