// startDisplay and the window manager: a computerd whose hello carries windowManager (init --window-manager) starts it
// itself, and create starts none, waiting on hello until it runs or failing in its words; a computerd whose hello carries
// none gets the manager from create, through process.start, as before.
import assert from "node:assert/strict";
import { test } from "node:test";

const { startDisplay, desktopOf, WINDOW_MANAGER } = await import("../dist/desktop.js");

/**
 * A fake client: hello answers the display after the X server's start, with fact(n) as windowManager on the n-th hello
 * that sees the display (undefined: none); every call is kept.
 */
function fakeClient(fact) {
	const calls = [];
	let started = 0;
	let seen = 0;
	return {
		calls,
		close() {},
		async call(method, params) {
			calls.push({ method, params });
			if (method === "process.start") {
				started++;
				return { ok: true, value: { id: `p${started}`, pid: 100 + started } };
			}
			if (method === "hello") {
				const up = started > 0;
				const windowManager = up ? fact(++seen) : fact(0);
				return { ok: true, value: { protocol: "0.2", version: "test", os: "linux", kind: up ? "desktop" : "linux", arch: "amd64", groups: up ? ["exec", "screen"] : ["exec"], ...(windowManager ? { windowManager } : {}) } };
			}
			if (method === "process.wait") return { ok: true, value: { running: true, exitCode: null, signal: null } };
			if (method === "process.read") return { ok: true, value: { data: "", offset: 0, next: 0, exited: false } };
			return { ok: false, error: { code: "unsupported", message: `${method} is not a method` } };
		},
	};
}

const desktop = desktopOf({});
const starts = (client) => client.calls.filter(({ method }) => method === "process.start").map(({ params }) => params.argv[0]);

test("startDisplay: with hello's windowManager, create starts no window manager, and waits on hello until computerd says it runs", async () => {
	const client = fakeClient((n) => (n < 3 ? { state: "starting" } : { state: "running" }));
	const result = await startDisplay(client, desktop, { version: "test", vendor: "fake", windowManager: true });
	assert.deepEqual(result, { ok: true, value: undefined });
	assert.deepEqual(starts(client), ["Xvfb"], "the X server alone: computerd starts the window manager");
	assert.equal(client.calls.filter(({ method }) => method === "hello").length, 3, "hello until the fact says running: the display's, then two more");
});

test("startDisplay: hello's windowManager ended fails create in computerd's words", async () => {
	const why = "the window manager computerd started (dbus-run-session -- xfwm4 --compositor=off --sm-client-disable) ended with exit code 1 within 1 s of starting on :0: Xfconf could not be initialized";
	const client = fakeClient((n) => (n < 2 ? { state: "starting" } : { state: "ended", why }));
	const result = await startDisplay(client, desktop, { version: "test", vendor: "fake", windowManager: true });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "vendor");
	assert.equal(result.error.message, why);
	assert.deepEqual(starts(client), ["Xvfb"]);
});

test("startDisplay: hello's windowManager is waited on even where the host's facts name none: computerd was asked", async () => {
	const client = fakeClient((n) => (n < 2 ? { state: "starting" } : { state: "running" }));
	const result = await startDisplay(client, desktop, { version: "test", vendor: "fake" });
	assert.deepEqual(result, { ok: true, value: undefined });
	assert.equal(client.calls.filter(({ method }) => method === "hello").length, 2);
	assert.deepEqual(starts(client), ["Xvfb"]);
});

test("startDisplay: with no windowManager in hello, create starts the window manager itself, as before, where the host's facts say so", async () => {
	const client = fakeClient(() => undefined);
	const result = await startDisplay(client, desktop, { version: "test", vendor: "fake", windowManager: true });
	assert.deepEqual(result, { ok: true, value: undefined });
	const [server, manager] = client.calls.filter(({ method }) => method === "process.start").map(({ params }) => params);
	assert.equal(server.argv[0], "Xvfb");
	assert.deepEqual(manager, { argv: [...WINDOW_MANAGER], env: { DISPLAY: ":0", NO_AT_BRIDGE: "1" } });
	const bare = fakeClient(() => undefined);
	assert.deepEqual(await startDisplay(bare, desktop, { version: "test", vendor: "fake" }), { ok: true, value: undefined });
	assert.deepEqual(starts(bare), ["Xvfb"], "and none where they do not");
});
