// installEnvProxy (env-proxy.ts), the one place the server and the runner take the standard proxy variables: a local
// CONNECT proxy counts the tunnels each vendor client asks for, one provider per client kind, each in a process of its
// own (the install is the process's): Kernel's REST (fetch), Orgo's terminal (Node's global WebSocket) and Modal's SDK
// (gRPC). With HTTPS_PROXY set each goes through it; with NO_PROXY naming the hosts, or no proxy, none does. Loopback and
// the server's own public address never do. E2B's SDK and Morph's gateway, which this install doesn't reach, are
// packages/computer/test/env-proxy.test.mjs's.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const INSTALL = new URL("../dist/env-proxy.js", import.meta.url).href;
const ORGO_CHANNEL = new URL("../../computer/dist/orgo-channel.js", import.meta.url).href;
const VENDORS = ["api.kernel.test:443", "orgo.test:443", "api.modal.test:443"];

/** A server on loopback, its open connections ended when the test is (a box's port watcher may hold one). */
async function listening(t, server) {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	return `http://127.0.0.1:${server.address().port}`;
}

/** A CONNECT proxy on loopback that answers every tunnel 502, noting its target. A plain request is no tunnel: 502 too. */
async function countingProxy(t) {
	const tunnels = [];
	const server = createServer((req, res) => res.writeHead(502).end());
	server.on("connect", (req, socket) => {
		tunnels.push(req.url);
		socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
	});
	return { url: await listening(t, server), tunnels };
}

/** A plain server on loopback that notes the paths asked for. */
async function loopbackServer(t) {
	const got = [];
	const server = createServer((req, res) => {
		got.push(req.url);
		res.end("ok");
	});
	return { url: await listening(t, server), got };
}

// The child: the install, then each vendor call, each bounded (they fail: the proxy answers 502, or the name never
// resolves), then a fetch to the server's own public address and one to loopback. It prints grpc_proxy as it is after.
const CHILD = `
import { installEnvProxy } from ${JSON.stringify(INSTALL)};
installEnvProxy();
const { kernelRest } = await import("@parcha/agentrun-computer/kernel");
const { modalClient } = await import("@parcha/agentrun-computer/modal");
const { orgoRest, orgoTerminalChannel } = await import(${JSON.stringify(ORGO_CHANNEL)});
const bounded = (call) => Promise.race([Promise.resolve().then(call).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4000))]);
await bounded(() => kernelRest({ apiKey: "fake-test-key", apiUrl: "https://api.kernel.test" })("GET", "/browsers"));
const rest = orgoRest({ apiKey: "fake-test-key", apiUrl: "https://orgo.test/api", fetch: async () => Response.json({ vnc_password: "not-a-secret" }) });
await bounded(() => orgoTerminalChannel({ rest, workspace: async () => ({ ok: true, value: "w" }) }).stdio("c1", ["true"], { timeoutMs: 3000 }));
await bounded(async () => (await modalClient({ tokenId: "fake-test-key", tokenSecret: "not-a-secret", serverUrl: "https://api.modal.test:443" })).apps.fromName("agentrun-proxy-test"));
await bounded(() => fetch(new URL("/own", process.env.AGENTRUN_PUBLIC_URL)));
await bounded(() => fetch(process.env.LOOPBACK_URL + "/loopback"));
console.log(JSON.stringify({ grpc_proxy: process.env.grpc_proxy ?? null, no_grpc_proxy: process.env.no_grpc_proxy ?? null }));
process.exit(0);
`;

/** The child run with env (and nothing of this process's proxy variables): what it printed. */
function child(env) {
	const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?_proxy|no_proxy|grpc_proxy|no_grpc_proxy|modal_server_url)$/i.test(name)));
	return new Promise((resolve, reject) => {
		execFile(process.execPath, ["--input-type=module", "-e", CHILD], { cwd: new URL("..", import.meta.url), env: { ...base, AGENTRUN_PUBLIC_URL: "https://serve.own.test", ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
			if (error) return reject(new Error(`${error.message}\n${stderr}`));
			resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
		});
	});
}

const targets = (tunnels) => [...new Set(tunnels)].sort();

test("with HTTPS_PROXY set, a fetch provider, a WebSocket one and a gRPC SDK each send their vendor call through its tunnel; loopback and the server's own address go direct", async (t) => {
	const proxy = await countingProxy(t);
	const loopback = await loopbackServer(t);
	const printed = await child({ HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, LOOPBACK_URL: loopback.url });
	assert.deepEqual(targets(proxy.tunnels), [...VENDORS].sort(), "no tunnel to serve.own.test");
	assert.ok(loopback.got.includes("/loopback"), "loopback went direct");
	assert.equal(printed.grpc_proxy, proxy.url, "gRPC's own variable names the same proxy");
	assert.deepEqual(printed.no_grpc_proxy.split(","), ["localhost", "127.0.0.1", "::1", "[::1]", "serve.own.test"]);
});

test("lowercase https_proxy is read too, and NO_PROXY's hosts go direct for every client kind, gRPC's included", async (t) => {
	const proxy = await countingProxy(t);
	const loopback = await loopbackServer(t);
	const printed = await child({ https_proxy: proxy.url, NO_PROXY: "api.kernel.test, .orgo.test,*.modal.test", LOOPBACK_URL: loopback.url });
	assert.deepEqual(proxy.tunnels, []);
	assert.deepEqual(printed.no_grpc_proxy.split(","), ["api.kernel.test", ".orgo.test", ".modal.test", "localhost", "127.0.0.1", "::1", "[::1]", "serve.own.test"]);
	const all = await countingProxy(t);
	assert.deepEqual(await child({ HTTPS_PROXY: all.url, NO_PROXY: "*", LOOPBACK_URL: loopback.url }), { grpc_proxy: null, no_grpc_proxy: null }, "* is everything direct, which gRPC's list cannot say");
	assert.deepEqual(all.tunnels, []);
});

test("no proxy set: nothing goes through one and the environment is left as it was", async (t) => {
	const proxy = await countingProxy(t);
	const loopback = await loopbackServer(t);
	assert.deepEqual(await child({ LOOPBACK_URL: loopback.url, NO_PROXY: "anything" }), { grpc_proxy: null, no_grpc_proxy: null });
	assert.deepEqual(proxy.tunnels, []);
	assert.ok(loopback.got.includes("/loopback"));
});
