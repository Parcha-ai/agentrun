// RenderProvider's host on a fake Render: a fetch that answers Render's REST API (api.render.com/v1, the shapes of
// @renderinc/sdk's schema) and each sandbox's data plane (<id>.<region>.sandbox.onrender.com/runs/sync), where a sandbox
// keeps the files its runs write and starts what its launch line starts. What Render's own host decides is held here:
// create's body (the boot env but the attach URL, allow-all, no idle suspension, a plan, the box build), the wait for
// running and the one runs/sync launch of agentrun-dial, the labels file, get and list with their states, terminate,
// dialLog, dialExit and redial, the box build prepareImage makes, and the error codes in Render's words. The adapter's
// dial lifecycle is tested once over the fake dial host (hosted-dial.test.mjs), and Render's once through it here to its
// daemon's hello (bootDial); Render's own is proven live, from packages/serve/scripts/dial-conformance.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AttachHub, MemoryMachineTokens, releaseOlder, runHash } from "../dist/index.js";
import { boxImageRef, boxRecipeHash } from "../dist/box-image.js";
import { codeOfError } from "../dist/hosted/process.js";
import { dialLaunch } from "../dist/hosted/scripts.js";
import * as registry from "../dist/providers.js";
import { bootDial, dialServer } from "./fake-dial-host.mjs";

const { RenderProvider, create } = await import("../dist/render.js");
const renderModule = await import("../dist/conformance/render.js");

const KEY = "fake-test-key-render-not-a-secret";
const OWNER = "tea-abcdefghij0123456789";
const SBX = "sbx-abcdefghij0123456789";
const NAME = "computer-0123456789ab";
const BUILD = `agentrun-box-${boxRecipeHash()}`;
const GROUP = "sbg-default0123456789";
const CTX = { timeoutMs: 10_000 };
const LABELS = { "agentrun.computer": "1", "agentrun.computer.name": NAME, "agentrun.run": "run-1" };
const ATTACH = "wss://agentrun.example.com/v2/computers/attach";
const BOOT = { AGENTRUN_ATTACH_URL: ATTACH, AGENTRUN_ATTACH_TOKEN: `art_${"0".repeat(64)}`, AGENTRUN_DAEMON_URL: "https://agentrun.example.com/v2/computers/daemon" };
const { AGENTRUN_ATTACH_URL: _url, ...SANDBOX_ENV } = BOOT;
const LABELS_FILE = "/var/lib/agentrun-computer/labels.json";
const DIAL_LOG = "/run/agentrun-dial/log";
const DIAL_EXIT = "/run/agentrun-dial/exit";
const DIAL_SCRIPT = "/run/agentrun-dial/launch";
const REQUEST = { name: NAME, image: BUILD, labels: LABELS, lifetimeMs: 600_000, backstopAt: "2026-11-26T10:05:00.000Z", egress: true, boot: { env: BOOT } };

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A shell line's effects as a Render sandbox's runs/sync would have them, as far as this host's lines go: each
 * `printf %s '<base64>' | base64 -d > <path>` writes that file, `mv -f <a> <b>` moves one, `[ -f <path> ] || exit 3`
 * exits 3 when the file is not there, `cat <path>` and `tail -c <n> <path>` print one, and a `setsid nohup` line starts
 * the launch script (start(script) says what it does).
 */
function runLine(sandbox, command, start) {
	for (const [, b64, path] of command.matchAll(/printf %s '([A-Za-z0-9+/=]*)' \| base64 -d > (\S+)/g)) sandbox.files.set(path, Buffer.from(b64, "base64").toString("utf8"));
	for (const [, from, to] of command.matchAll(/mv -f (\S+) (\S+)/g)) {
		sandbox.files.set(to, sandbox.files.get(from));
		sandbox.files.delete(from);
	}
	for (const [, path] of command.matchAll(/\[ -f (\S+) \] \|\| exit 3/g)) if (!sandbox.files.has(path)) return { stdout: "", stderr: "", exit_code: 3 };
	if (command.includes("setsid nohup")) {
		sandbox.files.delete(DIAL_EXIT);
		sandbox.files.set(DIAL_LOG, "");
		sandbox.starts.push(sandbox.files.get(DIAL_SCRIPT));
		start(sandbox, sandbox.files.get(DIAL_SCRIPT));
	}
	const read = /(?:^|; |&& )(?:cat|tail -c \d+) (\S+)$/.exec(command);
	return { stdout: read ? (sandbox.files.get(read[1]) ?? "") : "", stderr: "", exit_code: 0 };
}

/** A fetch answer that never comes: it fails once the call's own signal aborts (its bound, or its caller), as a wedged guest's run does. */
const hang = (signal) => new Promise((_, reject) => (signal?.aborted ? reject(signal.reason) : signal?.addEventListener("abort", () => reject(signal.reason), { once: true })));

let workspaces = 0;
/** A workspace id of its own: what a process keeps of a workspace's sandboxes is the workspace's, so each fake has its own. */
const freshOwner = () => `tea-fake${String(++workspaces).padStart(12, "0")}`;

/**
 * A fake Render: its sandboxes by id, each walking `statuses` one GET at a time (its last held), every call kept, in a
 * workspace of its own (`owner`), though it answers any. A sandbox's data plane takes the run token its token call
 * minted. `answer(method, path, body, { url, signal })` may answer a call first. `idOf(n)` names the nth sandbox made;
 * `lag` GETs still read a terminated sandbox running, as a vendor whose terminate answers before the sandbox ends, and
 * its runs fail meanwhile (409); `runMs` holds each run that long, and `inFlight.most` is the most runs answered at once.
 */
function fakeRender({ statuses = ["running"], answer = () => undefined, start = () => undefined, builds = [], idOf = (n) => (n === 0 ? SBX : `sbx-${String(n).padStart(20, "0")}`), lag = 0, runMs = 0 } = {}) {
	const calls = [];
	const sandboxes = new Map();
	const made = [...builds];
	const inFlight = { now: 0, most: 0 };
	const fetch = async (url, init = {}) => {
		const u = new URL(url);
		const body = init.body === undefined ? undefined : JSON.parse(init.body);
		calls.push({ method: init.method, url: u, headers: init.headers, body });
		if (u.hostname.endsWith(".sandbox.onrender.com")) {
			const sandbox = sandboxes.get(u.hostname.split(".")[0]);
			if (sandbox === undefined || init.headers?.Authorization !== `Bearer tok-${sandbox.record.id}` || u.pathname !== "/runs/sync") return json(401, { message: "not this run's token" });
			inFlight.most = Math.max(inFlight.most, ++inFlight.now);
			try {
				if (runMs > 0) await new Promise((resolve) => setTimeout(resolve, runMs));
				if (sandbox.ending !== undefined) return json(409, { code: "sandbox_not_running", message: "sandbox is terminating" });
				return (await answer(init.method, u.pathname, body, { url: u, signal: init.signal })) ?? json(200, runLine(sandbox, body.command, start));
			} finally {
				inFlight.now -= 1;
			}
		}
		if (init.headers?.Authorization !== `Bearer ${KEY}`) return json(401, { message: "unauthorized" });
		const path = u.pathname.replace(/^\/v1/, "");
		const said = answer(init.method, path, body, { url: u, signal: init.signal });
		if (said !== undefined) return said;
		if (init.method === "POST" && path === "/sandboxes") {
			const id = idOf(sandboxes.size);
			const record = { id, name: body.name, status: statuses[0], plan: body.plan, region: "oregon", networkPolicy: body.networkPolicy, timeoutSeconds: body.timeoutSeconds, idleTimeoutSeconds: body.idleTimeoutSeconds, createdAt: "2026-11-25T10:00:00Z", terminatedAt: null };
			sandboxes.set(id, { record, env: body.env, files: new Map(), starts: [], reads: 0 });
			return json(201, record);
		}
		if (init.method === "GET" && path === "/sandboxes") {
			const name = u.searchParams.get("name");
			const all = [...sandboxes.values()].map(({ record }) => record).filter((record) => record.status !== "terminated" && (name === null || record.name === name));
			const after = u.searchParams.get("cursor");
			const from = after === null ? 0 : all.findIndex(({ id }) => id === after) + 1;
			return json(200, all.slice(from, from + Number(u.searchParams.get("limit") ?? 20)).map((sandbox) => ({ sandbox, cursor: sandbox.id })));
		}
		const token = /^\/sandboxes\/([^/]+)\/runs\/sync\/token$/.exec(path);
		if (init.method === "POST" && token) {
			const sandbox = sandboxes.get(token[1]);
			if (sandbox === undefined) return json(404, { message: "sandbox not found" });
			if (sandbox.record.status !== "running") return json(409, { code: "sandbox_not_running", message: "sandbox is not running" });
			return json(201, { executionId: "exe-1", token: `tok-${sandbox.record.id}`, uri: `https://${sandbox.record.id}.oregon.sandbox.onrender.com/runs/sync`, method: "POST", expiresAt: "2026-11-25T10:05:00Z" });
		}
		const one = /^\/sandboxes\/([^/]+)(\/terminate)?$/.exec(path);
		if (one) {
			const sandbox = sandboxes.get(decodeURIComponent(one[1]));
			if (one[2] && init.method === "POST") {
				if (sandbox && lag > 0) sandbox.ending ??= lag;
				else if (sandbox) sandbox.record.status = "terminated";
				return new Response(null, { status: 204 });
			}
			if (sandbox === undefined) return json(404, { message: "sandbox not found" });
			if (sandbox.ending !== undefined) {
				if (sandbox.ending-- <= 0) sandbox.record.status = "terminated";
			} else if (sandbox.record.status !== "terminated") sandbox.record.status = statuses[Math.min(++sandbox.reads, statuses.length - 1)];
			return json(200, sandbox.record);
		}
		if (init.method === "GET" && path === "/sandbox-groups") return json(200, [{ sandboxGroup: { id: "sbg-other0123456789", isDefault: false }, cursor: "a" }, { sandboxGroup: { id: GROUP, isDefault: true }, cursor: "b" }]);
		if (path === `/sandbox-groups/${GROUP}/builds` && init.method === "GET") {
			// S, list-sandbox-builds: newest first; status an array, sent as one key per status (C's openapi-fetch).
			const statuses = u.searchParams.getAll("status");
			return json(200, made.filter((one) => (u.searchParams.get("name") ?? one.name) === one.name && (statuses.length === 0 || statuses.includes(one.status))).reverse().map((build) => ({ build, cursor: build.id })));
		}
		if (path === `/sandbox-groups/${GROUP}/builds` && init.method === "POST") {
			const build = { id: `sbb-${String(made.length).padStart(20, "0")}`, sandboxGroupId: GROUP, name: body.name, status: "pending", walk: ["running", "succeeded"] };
			made.push(build);
			return json(201, build);
		}
		const build = new RegExp(`^/sandbox-groups/${GROUP}/builds/([^/]+)$`).exec(path);
		if (build && init.method === "GET") {
			const found = made.find(({ id }) => id === build[1]);
			if (found?.walk?.length) found.status = found.walk.shift();
			return found ? json(200, found) : json(404, { message: "build not found" });
		}
		return json(404, { message: `no route ${init.method} ${path}` });
	};
	return { owner: freshOwner(), calls, sandboxes, builds: made, fetch, inFlight, runs: () => calls.filter(({ url }) => url.pathname === "/runs/sync") };
}

/** The same fake Render seen by a server that restarted, or by another process: it knows nothing this process kept of the workspace. */
const restarted = (render) => ({ ...render, owner: freshOwner() });

/** create's request for computer-<n> of `run` at `epoch`, as the adapter makes one for a claim. */
const runRequest = (n, run, epoch) => {
	const name = `computer-${String(n).padStart(12, "0")}`;
	return { ...REQUEST, name, labels: { "agentrun.computer": "1", "agentrun.computer.name": name, "agentrun.run": run, "agentrun.epoch": String(epoch) } };
};

const provider = (render, options = {}) => new RenderProvider({ apiKey: KEY, ownerId: render.owner ?? OWNER, fetch: render.fetch, timeouts: { pollMs: 1 }, ...options });

test("create posts the workspace, the name, a plan, the lifetime as whole seconds (at least 60), no idle suspension, allow-all, the boot env but the attach URL, and the box build", async () => {
	const render = fakeRender();
	const { host } = provider(render);
	assert.deepEqual(await host.create(REQUEST, CTX), { id: SBX });
	const [post] = render.calls;
	assert.equal(post.headers.Authorization, `Bearer ${KEY}`);
	assert.equal(post.url.href, "https://api.render.com/v1/sandboxes");
	assert.deepEqual(post.body, { ownerId: render.owner, name: `${NAME}-r${runHash("run-1")}`, plan: "2c-4g", timeoutSeconds: 600, idleTimeoutSeconds: 0, networkPolicy: { type: "allow-all" }, env: SANDBOX_ENV, buildName: BUILD });
	await host.create({ ...REQUEST, lifetimeMs: 1_500, image: "sbb-abcdefghij0123456789" }, CTX);
	const second = render.calls.filter(({ method, url }) => method === "POST" && url.pathname === "/v1/sandboxes")[1].body;
	assert.equal(second.timeoutSeconds, 60, "Render's least timeout");
	assert.equal(second.buildId, "sbb-abcdefghij0123456789", "a build's id is sent as one");
	assert.equal(Object.hasOwn(second, "buildName"), false);
	await host.create(runRequest(7, "run-1", 12), CTX);
	const named = render.calls.filter(({ method, url }) => method === "POST" && url.pathname === "/v1/sandboxes").map(({ body }) => body.name);
	assert.equal(named[2], `computer-000000000007-r${runHash("run-1")}-e12`, "the name carries the run's hash and the epoch beside the adapter's name");
	assert.ok(named[2].length <= 64, "within Render's 64 characters");
	await host.create({ ...REQUEST, labels: { "agentrun.computer": "1", "agentrun.computer.name": NAME } }, CTX);
	assert.equal(render.calls.filter(({ method, url }) => method === "POST" && url.pathname === "/v1/sandboxes")[3].body.name, NAME, "a computer of no run is named as the adapter named it");
});

test("create waits for the sandbox to run, then starts agentrun-dial in one runs/sync call: the labels file, the launch script with the attach URL and never the token, started under setsid so the call returns", async () => {
	const render = fakeRender({ statuses: ["creating", "creating", "running"] });
	await provider(render).host.create(REQUEST, CTX);
	assert.deepEqual(
		render.calls.map(({ method, url }) => `${method} ${url.pathname}`),
		["POST /v1/sandboxes", `GET /v1/sandboxes/${SBX}`, `GET /v1/sandboxes/${SBX}`, `POST /v1/sandboxes/${SBX}/runs/sync/token`, "POST /runs/sync"],
	);
	const token = render.calls[3];
	assert.equal(token.url.searchParams.get("ownerId"), render.owner);
	const [run] = render.runs();
	assert.equal(run.headers.Authorization, `Bearer tok-${SBX}`, "the data plane takes the run's token, never the API key");
	assert.equal(run.url.host, `${SBX}.oregon.sandbox.onrender.com`);
	const { command } = run.body;
	assert.match(command, /^umask 077 && /);
	assert.equal(command.includes(BOOT.AGENTRUN_ATTACH_TOKEN), false, "the token stays in the sandbox's env");
	assert.match(command, /setsid nohup sh -c .* > \/run\/agentrun-dial\/log 2>&1 < \/dev\/null &/);
	const sandbox = render.sandboxes.get(SBX);
	assert.deepEqual(JSON.parse(sandbox.files.get(LABELS_FILE)), LABELS);
	assert.equal(sandbox.files.get(DIAL_SCRIPT), dialLaunch({ attach: ATTACH }));
	assert.deepEqual(sandbox.starts, [dialLaunch({ attach: ATTACH })], "agentrun-dial started once");
	assert.deepEqual(sandbox.env, SANDBOX_ENV);
});

test("a sandbox that errors or ends before it runs fails create in Render's words, and agentrun-dial is never started; one still creating at the bound is a timeout", async () => {
	for (const [status, said] of [["errored", /Render reads the sandbox sbx-abcdefghij0123456789 errored, so agentrun-dial was not started/], ["terminated", /terminated, so agentrun-dial was not started/]]) {
		const render = fakeRender({ statuses: ["creating", status] });
		const error = await provider(render).host.create(REQUEST, CTX).catch((caught) => caught);
		assert.equal(error.code, "vendor", status);
		assert.match(error.message, said);
		assert.deepEqual(render.runs(), []);
	}
	const slow = fakeRender({ statuses: ["creating"] });
	const error = await provider(slow).host.create(REQUEST, { timeoutMs: 50 }).catch((caught) => caught);
	assert.equal(error.code, "timeout");
	assert.match(error.message, /did not read running within 0\.05 s \(it reads creating\), so agentrun-dial was not started/);
	assert.deepEqual(slow.runs(), []);
});

test("a launch that exits other than 0 fails create in its words; a launch that got no answer is never sent again", async () => {
	const failing = fakeRender({ answer: (method, path) => (path === "/runs/sync" ? json(200, { stdout: "", stderr: "base64: invalid input", exit_code: 1 }) : undefined) });
	const error = await provider(failing).host.create(REQUEST, CTX).catch((caught) => caught);
	assert.equal(error.code, "vendor");
	assert.match(error.message, /^starting agentrun-dial in sbx-abcdefghij0123456789 exited 1: base64: invalid input$/);
	let runs = 0;
	const silent = fakeRender({ answer: (method, path) => (path === "/runs/sync" ? (runs++, Promise.reject(new TypeError("fetch failed"))) : undefined) });
	await assert.rejects(provider(silent).host.create(REQUEST, CTX));
	assert.equal(runs, 1, "a launch that got no answer may have started agentrun-dial: never sent again");
});

test("create takes the smallest plan that holds the size, 2 CPUs and 4 GiB by default; a request with no boot env makes nothing", async () => {
	const render = fakeRender();
	const { host } = provider(render);
	const sizes = [[{ cpus: 1 }, "1c-2g"], [{ cpus: 1, memoryMb: 2048 }, "1c-2g"], [{ memoryMb: 3000 }, "2c-4g"], [{ cpus: 4 }, "4c-8g"], [{ cpus: 2, memoryMb: 8192 }, "4c-8g"], [{ cpus: 8, memoryMb: 16_384 }, "8c-16g"]];
	for (const [size] of sizes) await host.create({ ...REQUEST, ...size }, CTX);
	const plans = render.calls.filter(({ method, url }) => method === "POST" && url.pathname === "/v1/sandboxes").map(({ body }) => body.plan);
	assert.deepEqual(plans, sizes.map(([, plan]) => plan));
	const before = render.calls.length;
	await assert.rejects(host.create({ ...REQUEST, boot: undefined }, CTX), (error) => error.code === "invalid" && /no boot env/.test(error.message));
	assert.equal(render.calls.length, before);
});

test("get reads Render's statuses as the adapter's, the plan as its resources and its end from createdAt and timeoutSeconds; a terminated sandbox is none, a missing one not_found", async () => {
	const states = { creating: "starting", resuming: "starting", running: "running", suspending: "stopped", suspended: "stopped", errored: "gone" };
	for (const [status, want] of Object.entries(states)) {
		const render = fakeRender({ statuses: [status] });
		const { host } = provider(render);
		await host.create({ ...REQUEST, boot: { env: BOOT } }, { timeoutMs: 20 }).catch(() => undefined);
		const machine = await host.get(SBX, CTX);
		assert.equal(machine.state, want, status);
		assert.deepEqual(machine.resources, { cpus: 2, memoryMb: 4096 });
		assert.equal(machine.createdAt.toISOString(), "2026-11-25T10:00:00.000Z");
		assert.equal(machine.endsAt.toISOString(), "2026-11-25T10:10:00.000Z");
		assert.equal(machine.why === undefined, status !== "errored", status);
	}
	const render = fakeRender();
	const { host } = provider(render);
	await host.create(REQUEST, CTX);
	render.sandboxes.get(SBX).record.status = "terminated";
	assert.equal(await host.get(SBX, CTX), undefined);
	const odd = fakeRender({ statuses: ["running", "levitating"] });
	await provider(odd).host.create(REQUEST, CTX);
	const read = await provider(odd).host.get(SBX, CTX);
	assert.deepEqual([read.state, read.why], ["gone", 'Render reads the sandbox\'s status "levitating", which this provider does not know']);
	await assert.rejects(host.get("sbx-nothere0123456789", CTX), (error) => error.code === "not_found");
	await assert.rejects(host.get("../sandboxes", CTX), (error) => error.code === "not_found");
	assert.equal(render.calls.at(-1).url.pathname, "/v1/sandboxes/..%2Fsandboxes", "an id is one path segment, encoded");
	const before = render.calls.length;
	for (const id of ["", ".", ".."]) await assert.rejects(host.get(id, CTX), (error) => error.code === "not_found", JSON.stringify(id));
	assert.equal(render.calls.length, before, "an id that can't be one path segment reaches no path");
});

test("a sandbox id of a form Render never answered before is read and terminated by it, never left running", async () => {
	const odd = "sbx-2026-abcdefghij";
	const render = fakeRender({ idOf: () => odd });
	const { host } = provider(render);
	assert.deepEqual(await host.create(REQUEST, CTX), { id: odd });
	assert.deepEqual((await host.get(odd, CTX)).labels, LABELS);
	await host.delete(odd, CTX);
	assert.equal(render.sandboxes.get(odd).record.status, "terminated");
	assert.equal(await host.get(odd, CTX), undefined);
});

test("labels: the process that made a sandbox keeps them, for every provider of the workspace; another reads the labels file once through runs/sync; one with no file yet carries its name's labels, and a sandbox not named as a computer none", async () => {
	const render = fakeRender();
	const maker = provider(render).host;
	await maker.create(REQUEST, CTX);
	const runs = render.runs().length;
	assert.deepEqual((await maker.get(SBX, CTX)).labels, LABELS);
	assert.deepEqual((await provider(render).host.get(SBX, CTX)).labels, LABELS, "another provider of the workspace, as serve makes per claim");
	assert.equal(render.runs().length, runs, "the process that made it reads no file");
	const other = provider(restarted(render)).host;
	assert.deepEqual((await other.get(SBX, CTX)).labels, LABELS);
	assert.deepEqual((await other.get(SBX, CTX)).labels, LABELS);
	assert.equal(render.runs().length, runs + 1, "read once, then kept: a sandbox's labels never change");
	render.sandboxes.get(SBX).files.delete(LABELS_FILE);
	assert.deepEqual((await provider(restarted(render)).host.get(SBX, CTX)).labels, { "agentrun.computer": "1", "agentrun.computer.name": NAME });
	await maker.create({ ...REQUEST, name: "my-own-sandbox" }, CTX);
	const runsNow = render.runs().length;
	assert.deepEqual((await provider(restarted(render)).host.get("sbx-00000000000000000001", CTX)).labels, {});
	assert.equal(render.runs().length, runsNow, "a sandbox not named as a computer is not read");
	render.sandboxes.get(SBX).files.set(LABELS_FILE, "not json");
	const reader = provider(restarted(render)).host;
	assert.deepEqual((await reader.get(SBX, CTX)).labels, { "agentrun.computer": "1", "agentrun.computer.name": NAME }, "a file that is no labels map: the name's");
	render.sandboxes.get(SBX).files.set(LABELS_FILE, JSON.stringify(LABELS));
	assert.deepEqual((await reader.get(SBX, CTX)).labels, LABELS, "a read that failed is not kept: the next one reads the file");
});

test("a labels read that fails or never answers gives get the name's labels within its own bound, kept for nothing", async () => {
	const own = { "agentrun.computer": "1", "agentrun.computer.name": NAME };
	for (const [what, fails] of [
		["exits 1", () => json(200, { stdout: "", stderr: "cat: I/O error", exit_code: 1 })],
		["answers 409", () => json(409, { code: "sandbox_not_running", message: "sandbox is not running" })],
		["never answers", (signal) => hang(signal)],
	]) {
		let failing = true;
		const render = fakeRender({ answer: (method, path, body, { signal }) => (failing && path === "/runs/sync" && body.command.includes(LABELS_FILE) ? fails(signal) : undefined) });
		plant(render, SBX, NAME, { labels: LABELS });
		const { host } = provider(render);
		const started = Date.now();
		assert.deepEqual((await host.get(SBX, { timeoutMs: 300 })).labels, own, what);
		assert.ok(Date.now() - started < 2_000, `${what}: answered within get's own bound, not past every retry`);
		failing = false;
		assert.deepEqual((await host.get(SBX, CTX)).labels, LABELS, `${what}: the next get reads the file`);
	}
	const caller = new AbortController();
	const render = fakeRender({ answer: (method, path, body, { signal }) => (path === "/runs/sync" ? (caller.abort(), hang(signal)) : undefined) });
	plant(render, SBX, NAME, { labels: LABELS });
	await assert.rejects(provider(render).host.get(SBX, { ...CTX, signal: caller.signal }), (error) => error.code === "aborted", "the caller's own abort is no failed read: it aborts");
});

test("release with no labels known and a labels read that fails still terminates the sandbox", async () => {
	for (const [what, fails] of [["exits 1", () => json(200, { stdout: "", stderr: "fork: out of memory", exit_code: 1 })], ["never answers", (signal) => hang(signal)]]) {
		const render = fakeRender({ answer: (method, path, body, { signal }) => (path === "/runs/sync" ? fails(signal) : undefined) });
		plant(render, SBX, NAME, { labels: LABELS });
		// A server that restarted: this provider made nothing, so it knows no labels.
		const restarted = provider(render, { dial: dialServer(), daemonPath: fileURLToPath(import.meta.url), timeouts: { pollMs: 1, listedStableMs: 0, requestMs: 300 } });
		const released = await restarted.release({ id: SBX, name: NAME }, "delete");
		assert.equal(released.ok, true, released.ok ? what : `${what}: ${released.error.code}: ${released.error.message}`);
		assert.equal(render.sandboxes.get(SBX).record.status, "terminated", `${what}: terminated, not left to bill to its timeout`);
	}
});

test("a sandbox Render still reads running after its terminate is read without its guest: release settles, and its labels go once Render reads it gone", async () => {
	for (const warm of [true, false]) {
		const render = fakeRender({ lag: 2 });
		const maker = provider(render, { dial: dialServer(), daemonPath: fileURLToPath(import.meta.url), timeouts: { pollMs: 1, listedStableMs: 0 } });
		await maker.host.create(REQUEST, CTX);
		const { host } = warm ? maker : provider(restarted(render));
		await host.delete(SBX, CTX);
		const runs = render.runs().length;
		const lagging = await host.get(SBX, CTX);
		assert.equal(lagging.state, "running", "Render still reads it running");
		assert.equal(lagging.labels["agentrun.computer.name"], NAME);
		assert.equal(render.runs().length, runs, `${warm ? "warm" : "cold"}: a terminated sandbox's guest is never read`);
	}
	const render = fakeRender({ lag: 1 });
	const made = provider(render, { dial: dialServer(), daemonPath: fileURLToPath(import.meta.url), timeouts: { pollMs: 1, listedStableMs: 0 } });
	await made.host.create(REQUEST, CTX);
	const released = await made.release({ id: SBX, name: NAME }, "delete");
	assert.equal(released.ok, true, released.ok ? "" : `${released.error.code}: ${released.error.message}`);
	// The fake brings it back, as no vendor does, to see what the host still keeps: once read gone, nothing.
	const sandbox = render.sandboxes.get(SBX);
	assert.equal(sandbox.record.status, "terminated");
	Object.assign(sandbox, { ending: undefined });
	sandbox.record.status = "running";
	sandbox.files.set(LABELS_FILE, JSON.stringify({ ...LABELS, "agentrun.run": "run-2" }));
	assert.equal((await made.host.get(SBX, CTX)).labels["agentrun.run"], "run-2", "the labels were let go once Render read it terminated");
});

test("a sandbox Render ended by itself, which a listing no longer shows, leaves no labels behind", async () => {
	const render = fakeRender();
	const { host } = provider(render);
	await host.create(REQUEST, CTX);
	await host.create({ ...REQUEST, name: "computer-0123456789ac", labels: { ...LABELS, "agentrun.computer.name": "computer-0123456789ac" } }, CTX);
	const ended = render.sandboxes.get(SBX);
	render.sandboxes.delete(SBX);
	assert.deepEqual((await host.list({ "agentrun.computer": "1" }, CTX)).map(({ id }) => id), ["sbx-00000000000000000001"]);
	render.sandboxes.set(SBX, ended);
	ended.files.set(LABELS_FILE, JSON.stringify({ ...LABELS, "agentrun.run": "run-2" }));
	const runs = render.runs().length;
	assert.equal((await host.get(SBX, CTX)).labels["agentrun.run"], "run-2", "read again: the listing that missed it let its labels go");
	assert.equal(render.runs().length, runs + 1);
	assert.deepEqual((await host.get("sbx-00000000000000000001", CTX)).labels["agentrun.run"], "run-1");
	assert.equal(render.runs().length, runs + 1, "one the listing showed is kept");
});

/** A sandbox put straight into the fake, named `name`, its labels file holding `labels` where given. */
function plant(render, id, name, { status = "running", labels } = {}) {
	const record = { id, name, status, plan: "2c-4g", region: "oregon", networkPolicy: { type: "allow-all" }, timeoutSeconds: 600, idleTimeoutSeconds: 0, createdAt: "2026-11-25T10:00:00Z" };
	render.sandboxes.set(id, { record, env: {}, files: new Map(labels ? [[LABELS_FILE, JSON.stringify(labels)]] : []), starts: [], reads: 0 });
}

test("list reads every page by cursor and matches the name asked itself, leaves out terminated sandboxes and those not named as computers, and reads a labels file only where a label asked is not its name's, of a sandbox whose name may be the run's", async () => {
	const render = fakeRender();
	const ids = Array.from({ length: 101 }, (_, i) => `sbx-${String(i).padStart(20, "0")}`);
	ids.forEach((id, i) => plant(render, id, `computer-${i.toString(16).padStart(12, "0")}`));
	plant(render, "sbx-mine0123456789", "my-own-sandbox");
	plant(render, "sbx-ended0123456789", "computer-ffffffffffff", { status: "terminated" });
	plant(render, "sbx-runs0123456789", `computer-0000000000aa-r${runHash("run-1")}-e2`);
	plant(render, "sbx-odd00123456789", `computer-0000000000ab-rnotahash`);
	const { host } = provider(render);
	const all = await host.list({ "agentrun.computer": "1" }, CTX);
	assert.deepEqual(all.map(({ id }) => id), [...ids, "sbx-runs0123456789"]);
	assert.deepEqual(all[5].labels, { "agentrun.computer": "1", "agentrun.computer.name": "computer-000000000005" });
	assert.deepEqual(all.at(-1).labels, { "agentrun.computer": "1", "agentrun.computer.name": "computer-0000000000aa" }, "the adapter's name, without the run's hash and the epoch");
	assert.deepEqual(render.runs(), [], "the adapter's label is the name's: no file read");
	assert.deepEqual(render.calls.map(({ method, url }) => [method, url.pathname, url.searchParams.get("ownerId"), url.searchParams.get("limit"), url.searchParams.get("cursor")]), [["GET", "/v1/sandboxes", render.owner, "100", null], ["GET", "/v1/sandboxes", render.owner, "100", ids[99]]]);
	const byName = await host.list({ "agentrun.computer": "1", "agentrun.computer.name": "computer-000000000011" }, CTX);
	assert.deepEqual(byName.map(({ id }) => id), [ids[17]]);
	assert.deepEqual((await host.list({ "agentrun.computer": "1", "agentrun.computer.name": "computer-0000000000aa" }, CTX)).map(({ id }) => id), ["sbx-runs0123456789"], "a name asked is the adapter's, whatever run and epoch the sandbox's carries");
	assert.equal(render.calls.slice(2).some(({ url }) => url.searchParams.has("name")), false, "Render's name filter is exact, and a sandbox's name carries more than the adapter's: every page is read");

	const few = fakeRender();
	const named = (n, run) => `computer-00000000000${n}-r${runHash(run)}-e1`;
	plant(few, "sbx-one0123456789", named(1, "run-1"), { labels: { "agentrun.computer": "1", "agentrun.computer.name": "computer-000000000001", "agentrun.run": "run-1" } });
	plant(few, "sbx-two0123456789", named(2, "run-2"), { labels: { "agentrun.computer": "1", "agentrun.computer.name": "computer-000000000002", "agentrun.run": "run-2" } });
	plant(few, "sbx-new0123456789", named(3, "run-1"), { status: "creating" });
	const other = provider(few).host;
	const byRun = await other.list({ "agentrun.computer": "1", "agentrun.run": "run-1" }, CTX);
	assert.deepEqual(byRun.map(({ id }) => id), ["sbx-one0123456789"], "the adapter keeps those that carry every label; this one's file says run-1");
	assert.equal(byRun[0].labels["agentrun.run"], "run-1");
	assert.equal(few.runs().length, 1, "only run-1's running computer is read: run-2's name has another hash, and one still creating carries its name's");
	await other.list({ "agentrun.computer": "1", "agentrun.run": "run-2" }, CTX);
	assert.equal(few.runs().length, 2, "run-2's, once");
	await other.list({ "agentrun.computer": "1", "agentrun.run": "run-1", "agentrun.epoch": "2" }, CTX);
	await other.list({ "agentrun.computer": "1", "agentrun.run": "run-1" }, CTX);
	assert.equal(few.runs().length, 2, "another epoch's name is never read, and one read is kept");
});

test("a sandbox whose name has no run's hash is no run's computer: a listing by run never reads it, so its guest can't fail one", async () => {
	const render = fakeRender({ answer: (method, path) => (path === "/runs/sync" ? json(200, { stdout: "", stderr: "cat: I/O error", exit_code: 1 }) : undefined) });
	plant(render, "sbx-bare0123456789", "computer-0000000000bb");
	assert.deepEqual(await provider(render).host.list({ "agentrun.computer": "1", "agentrun.run": "run-1" }, CTX), []);
	assert.deepEqual(render.runs(), []);
});

/** sbx-run000000000003 for 3: the ids wedgedRender plants. */
const runId = (n) => `sbx-run${String(n).padStart(12, "0")}`;

/** A fake Render with `count` running computers of run-1, the nth at `epochs[n]` (1 where none is given), whose runs in `wedged` (id to "exits" or "hangs") exit 1 or never answer. */
function wedgedRender(count, { wedged = new Map(), epochs = [], runMs = 0 } = {}) {
	const ids = Array.from({ length: count }, (_, i) => runId(i));
	const render = fakeRender({
		runMs,
		answer: (method, path, body, { url, signal }) => {
			const how = wedged.get(url.hostname.split(".")[0]);
			if (path !== "/runs/sync" || how === undefined) return undefined;
			return how === "exits" ? json(200, { stdout: "", stderr: "cat: Permission denied", exit_code: 1 }) : hang(signal);
		},
	});
	ids.forEach((id, i) => {
		const name = `computer-${i.toString(16).padStart(12, "0")}`;
		const epoch = String(epochs[i] ?? 1);
		plant(render, id, `${name}-r${runHash("run-1")}-e${epoch}`, { labels: { "agentrun.computer": "1", "agentrun.computer.name": name, "agentrun.run": "run-1", "agentrun.epoch": epoch } });
	});
	return { render, ids };
}

test("a listing reads labels files a few at a time, all within its bound, and one it can't read fails it closed, naming each: it can't tell whether that sandbox carries the labels asked", async () => {
	const { render, ids } = wedgedRender(12, { runMs: 5 });
	const all = await provider(render).host.list({ "agentrun.computer": "1", "agentrun.run": "run-1" }, { timeoutMs: 500 });
	assert.deepEqual(all.map(({ id }) => id), ids);
	assert.equal(render.runs().length, ids.length, "each running computer's file read once");
	assert.ok(render.inFlight.most <= 4, `at most 4 reads at once, not ${render.inFlight.most}`);
	assert.ok(render.inFlight.most > 1, "reads go on side by side");

	const wedged = wedgedRender(12, { runMs: 5, wedged: new Map([[runId(3), "exits"], [runId(8), "hangs"]]) });
	const { host } = provider(wedged.render);
	const started = Date.now();
	const error = await host.list({ "agentrun.computer": "1", "agentrun.run": "run-1" }, { timeoutMs: 500 }).catch((caught) => caught);
	assert.ok(Date.now() - started < 3_000, "held to the listing's own bound");
	assert.equal(error.code, "vendor");
	assert.equal(error.message, "could not read the labels of sbx-run000000000003: reading the labels file of sbx-run000000000003 exited 1: cat: Permission denied; sbx-run000000000008: no answer within 0.5 s; the listing can't tell whether they carry agentrun.run=run-1");
	assert.equal(wedged.render.runs().length, ids.length, "every read waited for before the listing fails");
	assert.ok(wedged.render.inFlight.most <= 4, `at most 4 reads at once, not ${wedged.render.inFlight.most}`);

	const one = wedgedRender(2, { wedged: new Map([[runId(1), "exits"]]) });
	const alone = await provider(one.render).host.list({ "agentrun.computer": "1", "agentrun.run": "run-1" }, CTX).catch((caught) => caught);
	assert.equal(alone.message, "could not read the labels of sbx-run000000000001: reading the labels file of sbx-run000000000001 exited 1: cat: Permission denied; the listing can't tell whether it carries agentrun.run=run-1");

	const own = { "agentrun.computer": "1", "agentrun.computer.name": "computer-000000000003" };
	const byName = await host.list(own, CTX);
	assert.deepEqual(byName.map(({ id, labels }) => [id, labels]), [[runId(3), own]], "a listing by the name alone reads no file and never fails so");
	assert.deepEqual((await host.get(runId(3), CTX)).labels, own, "get keeps the name's labels");
});

test("a listing with an unreadable sandbox this host terminated, which Render still reads running, succeeds: its guest is never read", async () => {
	const { render, ids } = wedgedRender(3, { wedged: new Map([[runId(1), "exits"]]) });
	const { host } = provider(render);
	render.sandboxes.get(ids[1]).ending = 5;
	await host.delete(ids[1], CTX);
	const runs = render.runs().length;
	const listed = await host.list({ "agentrun.computer": "1", "agentrun.run": "run-1" }, CTX);
	assert.deepEqual(listed.map(({ id }) => id), [ids[0], ids[2]]);
	assert.equal(render.runs().length, runs + 2, "the ending one's guest is not read");
});

test("releaseOlder over Render fails closed on a run's sandbox it can't read: a newer epoch's still fences the claim, and an older one's is never a success", async () => {
	const options = { dial: dialServer(), daemonPath: fileURLToPath(import.meta.url), timeouts: { pollMs: 1, listedStableMs: 0 } };
	const fenced = wedgedRender(2, { epochs: [1, 3], wedged: new Map([[runId(1), "exits"]]) });
	const refused = await releaseOlder(provider(fenced.render, options), "run-1", 2);
	assert.equal(refused.ok, false, "a newer epoch's sandbox left out would let a stale claim past the fence");
	assert.match(refused.error.message, /could not read the labels of sbx-run000000000001/);
	assert.equal(fenced.render.sandboxes.get(fenced.ids[0]).record.status, "running", "nothing released");

	const leaky = wedgedRender(2, { wedged: new Map([[runId(1), "exits"]]) });
	const partial = await releaseOlder(provider(leaky.render, options), "run-1", 2);
	assert.equal(partial.ok, false, "an older sandbox left out would make a leak a success");
	assert.match(partial.error.message, /could not read the labels of sbx-run000000000001/);
});

/** A fake Render whose labels-file reads exit 1 in each sandbox `wedged` holds, as a guest out of memory; create's launch still runs. */
function guestsRender(options = {}) {
	const wedged = new Set();
	const render = fakeRender({ ...options, answer: (method, path, body, { url }) => (path === "/runs/sync" && wedged.has(url.hostname.split(".")[0]) && body.command.startsWith("[ -f") ? json(200, { stdout: "", stderr: "fork: out of memory", exit_code: 1 }) : undefined) });
	return { render, wedged };
}

const DIALED = { dial: dialServer(), daemonPath: fileURLToPath(import.meta.url), timeouts: { pollMs: 1, listedStableMs: 0 } };

test("two providers of one workspace: a sandbox one terminated, which Render still reads running, is never read by the other's listing by run", async () => {
	const render = fakeRender({ lag: 5 });
	const ending = provider(render).host;
	const { id: gone } = await ending.create(runRequest(1, "run-1", 1), CTX);
	const { id: kept } = await ending.create(runRequest(2, "run-1", 2), CTX);
	await ending.delete(gone, CTX);
	const runs = render.runs().length;
	// serve makes a provider per claim, and one for the run's end: the next claim's lists the run while Render still reads the old one running.
	const listed = await provider(render).host.list({ "agentrun.computer": "1", "agentrun.run": "run-1" }, CTX);
	assert.deepEqual(listed.map(({ id, state }) => [id, state]), [[gone, "running"], [kept, "running"]], "the listing answers, with Render's reading of each and the labels known");
	assert.equal(render.runs().length, runs, "the ending sandbox's guest is not read, and the one made in this process is known");
});

test("a listing by run reads only that run's sandboxes: another run's wedged guest never refuses a claim, while this run's own still fails it closed", async () => {
	const { render, wedged } = guestsRender();
	const maker = provider(render).host;
	const { id: other } = await maker.create(runRequest(1, "run-2", 1), CTX);
	const { id: mine } = await maker.create(runRequest(2, "run-1", 1), CTX);
	wedged.add(other);
	// A server that restarted knows no labels: the next claim of run-1, at epoch 2, releases its epoch-1 sandbox.
	const released = await releaseOlder(provider(restarted(render), DIALED), "run-1", 2);
	assert.equal(released.ok, true, released.ok ? "" : `another run's unreadable sandbox refused the claim: ${released.error.message}`);
	assert.deepEqual(released.value.released.map(({ name }) => name), ["computer-000000000002"]);
	assert.equal(render.sandboxes.get(mine).record.status, "terminated");
	assert.equal(render.sandboxes.get(other).record.status, "running", "another run's sandbox is left as it is");
	assert.equal(render.runs().filter(({ url, body }) => url.hostname.startsWith(`${other}.`) && body.command.startsWith("[ -f")).length, 0, "and its guest is never read");

	const own = guestsRender();
	const theirs = await provider(own.render).host.create(runRequest(1, "run-2", 1), CTX);
	const ours = await provider(own.render).host.create(runRequest(2, "run-1", 1), CTX);
	own.wedged.add(theirs.id).add(ours.id);
	const fenced = await releaseOlder(provider(restarted(own.render), DIALED), "run-1", 2);
	assert.equal(fenced.ok, false, "this run's own unreadable sandbox still fails the claim closed");
	assert.equal(fenced.error.message.includes(`could not read the labels of ${ours.id}: reading the labels file of ${ours.id} exited 1: fork: out of memory; the listing can't tell whether it carries agentrun.run=run-1`), true, fenced.error.message);
	assert.equal(fenced.error.message.includes(theirs.id), false, "naming this run's sandbox alone");
	assert.equal(own.render.sandboxes.get(ours.id).record.status, "running", "nothing released");
});

test("prepareImage shares an import only between providers of one key: a wrong key's refusal is its own", async () => {
	const render = fakeRender();
	const [wrong, right] = await Promise.all([provider(render, { apiKey: "not-a-secret" }).prepareImage(), provider(render).prepareImage()]);
	assert.equal(wrong.ok, false, "the wrong key is refused");
	assert.match(wrong.error.message, /401/);
	assert.deepEqual(right, { ok: true, value: BUILD }, "the right key's import is not the wrong key's 401");
});

test("delete terminates the sandbox, which Render answers 204 even once it is terminated", async () => {
	const render = fakeRender();
	const { host } = provider(render);
	await host.create(REQUEST, CTX);
	await host.delete(SBX, CTX);
	await host.delete(SBX, CTX);
	const terminates = render.calls.filter(({ url }) => url.pathname === `/v1/sandboxes/${SBX}/terminate`);
	assert.deepEqual(terminates.map(({ method, url }) => [method, url.searchParams.get("ownerId")]), [["POST", render.owner], ["POST", render.owner]]);
	assert.equal(await host.get(SBX, CTX), undefined);
});

test("dialLog and dialExit read agentrun-dial's log and exit through runs/sync, none before it wrote them; redial starts its launch script once more", async () => {
	const render = fakeRender();
	const { host } = provider(render);
	assert.equal(typeof host.dialLog, "function");
	await host.create(REQUEST, CTX);
	const sandbox = render.sandboxes.get(SBX);
	assert.equal(await host.dialExit(SBX, CTX), undefined, "running: no exit yet");
	sandbox.files.set(DIAL_LOG, "agentrun-dial: fetching the daemon\nagentrun-dial: the daemon's sha256 is not the server's\n");
	sandbox.files.set(DIAL_EXIT, "3\n");
	assert.equal(await host.dialLog(SBX, CTX), "agentrun-dial: fetching the daemon\nagentrun-dial: the daemon's sha256 is not the server's\n");
	assert.equal(await host.dialExit(SBX, CTX), 3);
	assert.match(render.runs().at(-2).body.command, /tail -c 65536 \/run\/agentrun-dial\/log$/);
	await host.redial(SBX, CTX);
	assert.deepEqual(sandbox.starts, [dialLaunch({ attach: ATTACH }), dialLaunch({ attach: ATTACH })]);
	assert.equal(await host.dialExit(SBX, CTX), undefined, "the new start's: the old exit is gone");
	assert.equal(render.runs().at(-2).body.command.includes(BOOT.AGENTRUN_ATTACH_TOKEN), false);
	sandbox.files.delete(DIAL_LOG);
	sandbox.files.delete(DIAL_SCRIPT);
	assert.equal(await host.dialLog(SBX, CTX), undefined);
	await assert.rejects(host.redial(SBX, CTX), (error) => error.code === "not_found" && /no agentrun-dial was started/.test(error.message));
});

test("Render's errors are codes in Render's words, never the key; a 429 create is sent again, a create with no answer never", async () => {
	for (const [status, code] of [[401, "denied"], [403, "denied"], [400, "invalid"], [402, "limit"], [404, "not_found"]]) {
		const render = fakeRender({ answer: (method, path) => (path === "/sandboxes" ? json(status, { id: "e1", message: "workspace said no" }) : undefined) });
		const { host } = provider(render);
		const error = await host.create(REQUEST, CTX).catch((caught) => caught);
		assert.equal(codeOfError(host, error), code, String(status));
		assert.equal(error.message, `POST /v1/sandboxes answered ${status}: workspace said no`);
		assert.equal(error.message.includes(KEY), false);
	}
	let posts = 0;
	const busy = fakeRender({ answer: (method, path) => (path === "/sandboxes" && method === "POST" && ++posts === 1 ? json(429, { message: "rate limited" }) : undefined) });
	assert.deepEqual(await provider(busy).host.create(REQUEST, CTX), { id: SBX });
	assert.equal(posts, 2);
	let tries = 0;
	const silent = { fetch: async () => (tries++, Promise.reject(new TypeError("fetch failed"))) };
	await assert.rejects(provider(silent).host.create(REQUEST, CTX));
	assert.equal(tries, 1, "a create that got no answer may have made a sandbox: never sent again");
});

test("the provider dials: kind linux, a microVM, no exec or upload, a synced folder, none, open and a list; a server with no public address calls Render for nothing", async () => {
	const render = fakeRender();
	const made = provider(render, { dial: { tokens: new MemoryMachineTokens(), hub: new AttachHub() } });
	assert.equal(made.id, "render");
	assert.equal(made.host.facts.connect, "dial");
	assert.equal(made.host.exec, undefined);
	assert.equal(made.host.upload, undefined);
	assert.equal(made.host.extend, undefined, "Render moves no timeout");
	const caps = made.capabilities();
	assert.deepEqual([caps.kind, caps.isolation, caps.mount, caps.network], ["linux", "microvm", ["sync"], ["none", "open", "allow"]]);
	const refused = await made.create({ image: BUILD, lifetimeMs: 600_000, network: "none" }, { requestId: "render-no-address" });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /^Render machines dial this server, and it has no public https address/);
	assert.deepEqual(render.calls, []);
});

test("prepareImage answers the box image's build in the workspace's default sandbox group: a succeeded one of its name is kept, else the box image's public tag is imported and waited for, onWait told once", async () => {
	const ready = fakeRender({ builds: [{ id: "sbb-00000000000000000009", sandboxGroupId: GROUP, name: BUILD, status: "succeeded" }] });
	const waits = [];
	assert.deepEqual(await provider(ready).prepareImage({ onWait: (...said) => waits.push(said) }), { ok: true, value: BUILD });
	assert.deepEqual(waits, []);
	assert.deepEqual(
		ready.calls.map(({ method, url }) => `${method} ${url.pathname}${url.search}`),
		[`GET /v1/sandbox-groups?ownerId=${ready.owner}&limit=100`, `GET /v1/sandbox-groups/${GROUP}/builds?name=${BUILD}&status=succeeded&status=pending&status=running&limit=100`],
	);
	const fresh = fakeRender();
	const made = provider(fresh);
	assert.deepEqual(await made.prepareImage({ onWait: (...said) => waits.push(said) }), { ok: true, value: BUILD });
	assert.deepEqual(waits, [["build", BUILD]]);
	const post = fresh.calls.find(({ method, url }) => method === "POST" && url.pathname.endsWith("/builds"));
	assert.deepEqual(post.body, { name: BUILD, sourceImage: boxImageRef() });
	const calls = fresh.calls.length;
	assert.deepEqual(await made.prepareImage(), { ok: true, value: BUILD });
	assert.equal(fresh.calls.length, calls, "a build this provider saw succeed is not asked for again");
	const failed = fakeRender({ answer: (method, path) => (method === "GET" && /\/builds\/sbb-/.test(path) ? json(200, { id: "sbb-00000000000000000000", name: BUILD, status: "failed", failureReason: "the image's manifest is not linux/amd64" }) : undefined) });
	const answer = await provider(failed).prepareImage();
	assert.equal(answer.error?.code, "vendor");
	assert.match(answer.error.message, /^the box image as the Render build agentrun-box-[0-9a-f]{12}: Render's build sbb-00000000000000000000 failed: the image's manifest is not linux\/amd64$/);
});

test("prepareImage imports the box image once: calls side by side share one import, and a build of its name still pending or running is waited for, not posted again", async () => {
	const fresh = fakeRender();
	const made = provider(fresh);
	const waits = [];
	const both = await Promise.all([made.prepareImage({ onWait: (...said) => waits.push(["a", ...said]) }), made.prepareImage({ onWait: (...said) => waits.push(["b", ...said]) })]);
	assert.deepEqual(both, [{ ok: true, value: BUILD }, { ok: true, value: BUILD }]);
	assert.equal(fresh.calls.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/builds")).length, 1, "one import");
	assert.deepEqual(waits.sort(), [["a", "build", BUILD], ["b", "build", BUILD]], "each caller told once");
	// serve makes a provider per claim: two claims of one workspace, starting together, still share the import.
	const workspace = fakeRender();
	const claimsTold = [];
	const claims = await Promise.all([provider(workspace).prepareImage({ onWait: (...said) => claimsTold.push(["a", ...said]) }), provider(workspace).prepareImage({ onWait: (...said) => claimsTold.push(["b", ...said]) })]);
	assert.deepEqual(claims, [{ ok: true, value: BUILD }, { ok: true, value: BUILD }]);
	assert.equal(workspace.calls.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/builds")).length, 1, "one import for the workspace, not one per provider");
	assert.deepEqual(claimsTold.sort(), [["a", "build", BUILD], ["b", "build", BUILD]], "each claim told once");
	// Another workspace's import is its own.
	const elsewhere = fakeRender();
	const workspaces = await Promise.all([provider(elsewhere).prepareImage(), provider(elsewhere, { ownerId: "tea-otherworkspace0123" }).prepareImage()]);
	assert.deepEqual(workspaces, [{ ok: true, value: BUILD }, { ok: true, value: BUILD }]);
	assert.equal(elsewhere.calls.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/builds")).length, 2, "one import per workspace");
	for (const status of ["pending", "running"]) {
		const under = fakeRender({ builds: [{ id: "sbb-00000000000000000007", sandboxGroupId: GROUP, name: BUILD, status: "failed" }, { id: "sbb-00000000000000000008", sandboxGroupId: GROUP, name: BUILD, status, walk: ["running", "succeeded"] }] });
		const told = [];
		assert.deepEqual(await provider(under).prepareImage({ onWait: (...said) => told.push(said) }), { ok: true, value: BUILD }, status);
		assert.equal(under.calls.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/builds")).length, 0, `${status}: no second import`);
		assert.ok(under.calls.some(({ method, url }) => method === "GET" && url.pathname.endsWith("/builds/sbb-00000000000000000008")), `${status}: the build under way is waited for`);
		assert.deepEqual(told, [["build", BUILD]], status);
	}
	let importing = true;
	const slow = fakeRender({ answer: (method, path) => (importing && method === "GET" && /\/builds\/sbb-/.test(path) ? json(200, { id: "sbb-00000000000000000000", name: BUILD, status: "running" }) : undefined) });
	const shared = provider(slow);
	const caller = new AbortController();
	setTimeout(() => caller.abort(), 30);
	assert.equal((await shared.prepareImage({ signal: caller.signal })).error?.code, "aborted", "a caller's abort ends its own wait");
	importing = false;
	assert.deepEqual(await shared.prepareImage(), { ok: true, value: BUILD });
	assert.equal(slow.calls.filter(({ method, url }) => method === "POST" && url.pathname.endsWith("/builds")).length, 1, "the import a caller left is the next caller's");
});

test("prepareImage reads the sandbox groups page by page, by cursor, until it finds the default one", async () => {
	const others = Array.from({ length: 100 }, (_, i) => ({ sandboxGroup: { id: `sbg-other${String(i).padStart(12, "0")}`, isDefault: false }, cursor: `c${i}` }));
	const paged = fakeRender({
		builds: [{ id: "sbb-00000000000000000009", sandboxGroupId: GROUP, name: BUILD, status: "succeeded" }],
		answer: (method, path) => (method === "GET" && path === "/sandbox-groups" ? json(200, paged.calls.at(-1).url.searchParams.get("cursor") === "c99" ? [{ sandboxGroup: { id: GROUP, isDefault: true }, cursor: "d" }] : others) : undefined),
	});
	assert.deepEqual(await provider(paged).prepareImage(), { ok: true, value: BUILD });
	assert.deepEqual(
		paged.calls.filter(({ url }) => url.pathname === "/v1/sandbox-groups").map(({ url }) => [url.searchParams.get("limit"), url.searchParams.get("cursor")]),
		[["100", null], ["100", "c99"]],
	);
});

test("a Render sandbox over dial, as serve builds it: the sandbox boots from its env and the launch script, dials, and its daemon answers linux; release terminates it", async () => {
	const dial = dialServer();
	const daemonPath = fileURLToPath(import.meta.url);
	let booted;
	// The sandbox's agentrun-dial runs with the sandbox's env and the launch script's attach URL: that machine boots and dials.
	const render = fakeRender({
		start: (sandbox, script) => {
			booted = bootDial({ ...sandbox.env, AGENTRUN_ATTACH_URL: /AGENTRUN_ATTACH_URL='([^']*)'/.exec(script)[1] }, dial, { daemon: readFileSync(daemonPath) });
		},
	});
	const made = provider(render, { dial, daemonPath, timeouts: { pollMs: 1, listedStableMs: 0 } });
	const created = await made.create({ image: BUILD, lifetimeMs: 600_000, network: "none" }, { requestId: "render-over-dial" });
	assert.equal(created.ok, true, created.ok ? "" : `${created.error.code}: ${created.error.message}`);
	assert.equal(booted.dialed, true, "the sandbox's daemon is the server's: it dialed");
	const connection = await made.connect(created.value);
	assert.equal(connection.ok, true, connection.ok ? "" : `${connection.error.code}: ${connection.error.message}`);
	assert.equal(connection.value.hello.kind, "linux");
	await connection.value.close();
	const released = await made.release(created.value, "delete");
	assert.equal(released.ok, true, released.ok ? "" : `${released.error.code}: ${released.error.message}`);
	assert.equal(render.sandboxes.get(SBX).record.status, "terminated");
});

test("a create that fails after Render made the sandbox terminates it, in the create's own code: a run token refused by 429s past every retry (limit) or by a 401 (denied)", async () => {
	for (const [status, code] of [[429, "limit"], [401, "denied"]]) {
		const render = fakeRender({ answer: (method, path) => (method === "POST" && path.endsWith("/runs/sync/token") ? json(status, { message: "the workspace said no" }) : undefined) });
		const made = provider(render, { dial: dialServer(), daemonPath: fileURLToPath(import.meta.url), timeouts: { pollMs: 1, listedStableMs: 0 } });
		const created = await made.create({ image: BUILD, lifetimeMs: 600_000, network: "none" }, { requestId: `render-unmade-${status}` });
		assert.equal(created.error?.code, code, String(status));
		assert.match(created.error.message, new RegExp(`the sandbox ${SBX} it made was terminated`), String(status));
		assert.equal(render.sandboxes.get(SBX).record.status, "terminated", `${status}: a sandbox create made is never left running`);
		assert.deepEqual(render.runs(), [], "agentrun-dial was never started");
	}
});

test("check holds a size to Render's plans and an image to a Render build: Render's base image has no agentrun-dial", () => {
	const { host } = provider(fakeRender());
	assert.deepEqual(host.check({ cpus: 2, memoryMb: 4096, image: BUILD }), []);
	assert.deepEqual(host.check({ image: "sbb-abcdefghij0123456789" }), []);
	assert.deepEqual(host.check({ cpus: 16 }).map(({ field }) => field), ["cpus"]);
	assert.deepEqual(host.check({ memoryMb: 32_768 }).map(({ field }) => field), ["memoryMb"]);
	assert.deepEqual(host.check({ image: "default" }).map(({ field, message }) => [field, /agentrun-dial/.test(message)]), [["image", true]]);
	assert.deepEqual(host.check({ image: "--privileged" }).map(({ field }) => field), ["image"]);
	assert.deepEqual(host.check({ image: "ghcr.io/parcha-ai/agentrun-box:0123456789ab" }).map(({ field }) => field), ["image"], "an OCI image is imported by prepareImage, not started");
});

test("the constructor refuses a missing key, a workspace id with characters no id has, a fetch that is no function and a lifetime past a day, never echoing the key; Render's answer, not a prefix, says whether a workspace is one", () => {
	assert.throws(() => new RenderProvider({ ownerId: OWNER }), /options.apiKey, a Render API key, is required/);
	assert.throws(() => new RenderProvider({ apiKey: KEY, ownerId: "tea x/.." }), (error) => /options.ownerId is the Render workspace/.test(error.message) && !error.message.includes(KEY));
	assert.throws(() => new RenderProvider({ apiKey: KEY, ownerId: "" }), /options.ownerId is the Render workspace/);
	assert.ok(new RenderProvider({ apiKey: KEY, ownerId: "test-value" }) instanceof RenderProvider, "serve builds every provider from test values");
	assert.throws(() => new RenderProvider({ apiKey: KEY, ownerId: OWNER, fetch: "no" }), /options.fetch must be a function/);
	assert.throws(() => new RenderProvider({ apiKey: KEY, ownerId: OWNER, maxLifetimeMs: 25 * 3_600_000 }), /maxLifetimeMs/);
	assert.ok(create({ apiKey: KEY, ownerId: OWNER }) instanceof RenderProvider);
});

test("render is in the registry, and its conformance module reads COMPUTER_RENDER_* alone and refuses a dialKit off the public server", async () => {
	assert.ok(registry.providerIds.includes("render"));
	assert.equal((await registry.providerModule("render")).create, create);
	assert.deepEqual(registry.descriptorOf("render").keys.map(({ name, option, required }) => [name, option, required]), [["RENDER_API_KEY", "apiKey", true], ["RENDER_WORKSPACE_ID", "ownerId", true]]);
	assert.deepEqual(renderModule.ENV, { key: "COMPUTER_RENDER_API_KEY", workspace: "COMPUTER_RENDER_WORKSPACE_ID", image: "COMPUTER_RENDER_IMAGE" });
	assert.throws(() => renderModule.settingsFromEnv({ RENDER_API_KEY: KEY, COMPUTER_RENDER_WORKSPACE_ID: OWNER }), /needs COMPUTER_RENDER_API_KEY and COMPUTER_RENDER_WORKSPACE_ID/);
	const env = { COMPUTER_RENDER_API_KEY: KEY, COMPUTER_RENDER_WORKSPACE_ID: OWNER };
	assert.equal(renderModule.createProvider({ env }).capabilities().maxLifetimeMs, 30 * 60_000);
	assert.equal(renderModule.sweepScope({ env }), `the Render workspace ${OWNER}`);
	assert.equal(await renderModule.conformanceImage({ env: { ...env, COMPUTER_RENDER_IMAGE: "my-build" } }), "my-build");
	const ready = fakeRender({ builds: [{ id: "sbb-00000000000000000009", sandboxGroupId: GROUP, name: BUILD, status: "succeeded" }] });
	assert.equal(await renderModule.conformanceImage({ env, fetch: ready.fetch }), BUILD);
	assert.throws(() => renderModule.dialKit({ env }), /^Error: Render's machines dial the server that minted their tokens, and this run has no public server: run its Core with packages\/serve\/scripts\/dial-conformance\.mjs --provider render/);
});
