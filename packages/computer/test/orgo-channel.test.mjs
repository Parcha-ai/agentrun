// The Orgo channel the provider reaches inside a computer through (src/orgo-channel.ts): run is Orgo's bash call, upload
// its file upload into one computer, start a detached command (from bash, or in a named terminal session), and stdio
// computerd's bridge over the root terminal WebSocket, whose PTY is made raw and whose noise before a marker line is
// dropped. Against a fake fetch and a fake terminal (test/fake-orgo.mjs); the key and the VNC password stay out of every
// word, and nothing reaches the network.
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { API, fakeOrgoApi, fakeTerminal, KEY, VNC, WORKSPACE } from "./fake-orgo.mjs";

const { MAX_UPLOAD_BYTES, orgoRest, orgoTerminalChannel } = await import("../dist/orgo-channel.js");

function setup({ api: apiOptions = {}, onExec, frames } = {}) {
	const api = fakeOrgoApi(apiOptions);
	const computer = api.add({ name: "computer-0123456789ab" });
	const terminal = fakeTerminal({ onExec, ...(frames ? { frames } : {}) });
	const rest = orgoRest({ apiKey: KEY, apiUrl: API, fetch: api.fetch });
	const channel = orgoTerminalChannel({ rest, workspaceId: WORKSPACE, webSocket: terminal.factory });
	return { api, terminal, channel, id: computer.id };
}
const secretless = (value, what) => {
	const text = JSON.stringify(value ?? null);
	assert.ok(!text.includes(KEY) && !text.includes(VNC), `${what} holds a secret`);
};

test("orgoRest: the key goes in the Authorization header alone; an Orgo error is a code and words without it", async () => {
	const api = fakeOrgoApi();
	const rest = orgoRest({ apiKey: KEY, apiUrl: API, fetch: api.fetch });
	const read = await rest.request("GET", "/workspaces/nope", { timeoutMs: 1000 });
	assert.equal(read.ok, false);
	assert.equal(read.error.code, "not_found");
	assert.match(read.error.message, /Workspace not found/);
	assert.equal(api.requests[0].headers.authorization, `Bearer ${KEY}`);
	const wrong = orgoRest({ apiKey: "sk_wrong_key_0000000000", apiUrl: API, fetch: api.fetch });
	const denied = await wrong.request("GET", `/workspaces/${WORKSPACE}`, { timeoutMs: 1000 });
	assert.equal(denied.error.code, "denied");
	assert.ok(!denied.error.message.includes("sk_wrong_key"));
	const thrown = orgoRest({ apiKey: KEY, apiUrl: API, fetch: async () => Promise.reject(new Error(`connect ECONNREFUSED Bearer ${KEY}`)) });
	const failed = await thrown.request("GET", "/workspaces/x", { timeoutMs: 1000 });
	assert.equal(failed.ok, false);
	secretless(failed, "a failed fetch");
});

test("run: Orgo's bash call with the argv quoted for bash and a timeout in its 1-300 s; exit code and output back", async () => {
	let seen;
	const { channel, id, api } = setup({ api: { bash: (computer, command, timeout) => ((seen = { computer, command, timeout }), { exit_code: 3, output: "it's out" }) } });
	const ran = await channel.run(id, ["sh", "-c", 'echo "$1"', "sh", "it's $HOME"], { timeoutMs: 1_000_000 });
	assert.deepEqual(ran, { ok: true, value: { exitCode: 3, output: "it's out" } });
	assert.equal(seen.computer, id);
	assert.equal(seen.command, `'sh' '-c' 'echo "$1"' 'sh' 'it'\\''s $HOME'`);
	assert.equal(seen.timeout, 300);
	assert.equal(api.requests.at(-1).path, `/computers/${id}/bash`);
});

test("upload: one computer's file, by Orgo's upload with the workspace, the computer and the folder; past 10 MB refused before any call", async () => {
	const { channel, id, api } = setup();
	const put = await channel.upload(id, "/tmp/agentrun-computerd-0011223344556677", new Uint8Array([1, 2, 3]), { timeoutMs: 1000 });
	assert.deepEqual(put, { ok: true, value: undefined });
	const { form, path } = api.requests.at(-1);
	assert.equal(path, "/files/upload");
	assert.equal(form.get("workspaceId"), WORKSPACE);
	assert.equal(form.get("desktopId"), id);
	assert.equal(form.get("destPath"), "/tmp");
	assert.equal(form.get("file").name, "agentrun-computerd-0011223344556677");
	assert.equal(form.get("file").size, 3);
	const before = api.requests.length;
	const big = await channel.upload(id, "/tmp/x", new Uint8Array(MAX_UPLOAD_BYTES + 1), { timeoutMs: 1000 });
	assert.equal(big.ok, false);
	assert.match(big.error.message, /10 MB/);
	assert.equal(api.requests.length, before);
});

test("stdio: the root terminal made raw, everything before the marker dropped (the prompt, the echoed command), then JSON lines both ways; the VNC password only in the socket's URL", async () => {
	const { channel, id, terminal } = setup({
		onExec: (command, io) => {
			io.input = (data) => io.write(data.toUpperCase());
			io.write('{"hello":1}\n');
		},
	});
	const opened = await channel.stdio(id, ["/opt/agentrun/computerd", "stdio"], { timeoutMs: 1000 });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	const socket = terminal.sockets[0];
	const url = new URL(socket.url);
	assert.equal(`${url.protocol}//${url.host}${url.pathname}`, `wss://orgo.example/desktops/${id}/ws/terminal`);
	assert.equal(url.searchParams.get("token"), VNC);
	assert.equal(url.searchParams.get("session"), null, "an ephemeral shell: it ends when the bridge closes");
	const typed = JSON.parse(socket.sent[0]);
	assert.equal(typed.type, "input");
	assert.match(typed.data, /^stty raw -echo; printf '%s%s\\n' \S+ \S+; exec '\/opt\/agentrun\/computerd' 'stdio'\r$/);
	const { readable, writable } = opened.value;
	const chunks = [];
	readable.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
	writable.write('{"ping":2}\n');
	await new Promise((done) => setImmediate(done));
	await new Promise((done) => setImmediate(done));
	assert.equal(chunks.join(""), '{"hello":1}\n{"PING":2}\n', "nothing of the prompt or the echo, and the daemon's lines as they came");
	await opened.value.close();
	assert.equal(socket.closed, true);
	secretless(opened.value.said?.() ?? "", "the bridge's words");
});

test("stdio: output that comes as plain text frames or as binary frames carries the bytes as the JSON frames do", async () => {
	for (const frames of ["text", "binary"]) {
		const { channel, id } = setup({
			frames,
			onExec: (command, io) => {
				io.input = (data) => io.write(data);
				io.write('{"hello":1}\n');
			},
		});
		const opened = await channel.stdio(id, ["/opt/agentrun/computerd", "stdio"], { timeoutMs: 1000 });
		assert.equal(opened.ok, true, `${frames}: ${JSON.stringify(opened)}`);
		const chunks = [];
		opened.value.readable.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
		opened.value.writable.write('{"ping":2}\n');
		await new Promise((done) => setImmediate(done));
		await new Promise((done) => setImmediate(done));
		assert.equal(chunks.join(""), '{"hello":1}\n{"ping":2}\n', frames);
		await opened.value.close();
	}
});

test("stdio: a marker that never comes is a timeout that says what the terminal sent before it, by kind and its last bytes, never the password", async () => {
	const { channel, id } = setup({ frames: "deaf" });
	const opened = await channel.stdio(id, ["/opt/agentrun/computerd", "stdio"], { timeoutMs: 50 });
	assert.equal(opened.ok, false);
	assert.equal(opened.error.code, "timeout");
	assert.match(opened.error.message, /1 frame \(1 output\)/);
	assert.match(opened.error.message, /root@orgo:~\/Desktop# /);
	assert.match(opened.error.message, /\\u001b\[\?2004h/, "control characters escaped, never raw");
	secretless(opened, "the timeout");
});

test("stdio: the program's exit ends the stream; a socket closed before the marker is an error in words that hold no secret", async () => {
	const { channel, id } = setup({ onExec: (command, io) => io.exit(127) });
	const exited = await channel.stdio(id, ["/opt/agentrun/computerd", "stdio"], { timeoutMs: 1000 });
	assert.equal(exited.ok, true, "the marker came before the exec");
	const ended = once(exited.value.readable, "end");
	exited.value.readable.resume();
	await ended;
	const api = fakeOrgoApi();
	const computer = api.add({ name: "computer-0123456789ab" });
	const closing = () => ({ addEventListener: (type, fn) => type === "close" && queueMicrotask(() => fn({ code: 4001, reason: "unauthorized" })), send() {}, close() {} });
	const gone = orgoTerminalChannel({ rest: orgoRest({ apiKey: KEY, apiUrl: API, fetch: api.fetch }), workspaceId: WORKSPACE, webSocket: closing });
	const refused = await gone.stdio(computer.id, ["/opt/agentrun/computerd", "stdio"], { timeoutMs: 1000 });
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /4001/);
	secretless(refused, "a closed socket's error");
});

test("start: from bash, detached with setsid so it outlives the call; or typed into a named terminal session that survives the socket", async () => {
	let seen;
	const { channel, id, terminal } = setup({ api: { bash: (computer, command) => ((seen = command), { exit_code: 0, output: "" }) } });
	assert.deepEqual(await channel.start(id, ["/opt/agentrun/computerd", "init"], { how: "bash", timeoutMs: 1000 }), { ok: true, value: undefined });
	assert.match(seen, /^setsid -f '\/opt\/agentrun\/computerd' 'init' <\/dev\/null >>\/tmp\/agentrun-init\.log 2>&1$/);
	assert.deepEqual(await channel.start(id, ["/opt/agentrun/computerd", "init"], { how: "session", timeoutMs: 1000 }), { ok: true, value: undefined });
	const socket = terminal.sockets.at(-1);
	assert.equal(new URL(socket.url).searchParams.get("session"), "agentrun-init");
	assert.match(JSON.parse(socket.sent.at(-1)).data, /^exec '\/opt\/agentrun\/computerd' 'init' <\/dev\/null >>\/tmp\/agentrun-init\.log 2>&1\r$/);
	assert.equal(socket.closed, true, "the socket closes; the named session keeps the shell");
});
