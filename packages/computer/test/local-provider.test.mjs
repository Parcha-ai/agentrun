// The local browser (src/local.ts) over a fake Chrome (fake-chrome.mjs): a create starts it under a supervisor with a
// fresh profile, its debugging port on loopback and the fence's arguments; connect hands over its DevTools URL; release
// ends it and removes its files; its deadline ends it though the process that made it is gone; a Chrome that cannot start
// its sandbox, root and a missing executable are refused in words. No real Chrome: test/local-chrome-live.test.mjs is
// the one that starts one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { CHROME_FLAGS, chromeFence, findChrome, NO_CHROME } from "../dist/chrome.js";
import { PROVIDERS } from "../dist/kinds.js";
import { create, LocalBrowserProvider } from "../dist/local.js";
import { providerModule } from "../dist/providers.js";

const FAKE = fileURLToPath(new URL("./fake-chrome.mjs", import.meta.url));
// A short root: the egress socket's path must fit a Unix socket.
const scratch = mkdtempSync(join("/tmp", "lbt-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
/** The fake as an executable, as a Chrome binary is. */
const CHROME = join(scratch, "chrome");
writeFileSync(CHROME, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(CHROME, 0o755);
let roots = 0;
/** This process's own user: the root it makes is its own, as the provider checks (a CI runner is not uid 1000). */
const UID = process.getuid();
const provider = (options = {}) => new LocalBrowserProvider({ executablePath: CHROME, root: join(scratch, `r${++roots}`), uid: UID, ...options });
const SPEC = { image: "chromium", lifetimeMs: 60_000, network: "open", labels: { "agentrun.run": "run-1" } };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function until(what, check, ms = 15_000) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
	assert.fail(`${what} within ${ms} ms`);
}
const files = (p, id) => join(p.root, id);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
/** One CDP command over a websocket to url, its reply's result. */
function cdp(url, method) {
	return new Promise((done, failed) => {
		const socket = new WebSocket(url);
		socket.onopen = () => socket.send(JSON.stringify({ id: 1, method }));
		socket.onmessage = (event) => {
			done(JSON.parse(String(event.data)).result);
			socket.close();
		};
		socket.onerror = () => failed(new Error(`no websocket at ${url}`));
	});
}

test("capabilities: a browser on this host, open to public addresses, CDP only, ended by our own janitor", () => {
	const caps = provider().capabilities();
	assert.deepEqual(
		{ kind: caps.kind, isolation: caps.isolation, network: caps.network, daemon: caps.daemon, groups: caps.groups, lifetime: caps.lifetime, release: caps.release },
		{ kind: "browser", isolation: "host", network: ["open"], daemon: "none", groups: ["cdp"], lifetime: "janitor", release: ["delete"] },
	);
	assert.equal(caps.maxLifetimeMs, 24 * 60 * 60_000);
	const entry = PROVIDERS.find((one) => one.id === "local");
	assert.deepEqual([entry.keys, entry.metered, entry.kinds, entry.mounts], [[], false, ["browser"], []], "no key, nothing billed, kind browser");
});

test("check refuses what a local browser does not take, and a start as root, in words", () => {
	assert.deepEqual(provider().check(SPEC), []);
	const refused = provider().check({ image: "ubuntu", lifetimeMs: 0, network: "none", cpus: 2 });
	assert.deepEqual(refused.map((r) => r.field).sort(), ["cpus", "image", "lifetimeMs", "network"]);
	const root = provider({ uid: 0 }).check(SPEC);
	assert.equal(root.length, 1);
	assert.match(root[0].message, /does not start Chrome as root/);
	assert.doesNotMatch(root[0].message, /--no-sandbox/);
});

test("no Chrome: findChrome finds none, and check, create and testConnection say what to install and the setting that names one", async () => {
	assert.equal(findChrome({ PATH: "/nowhere" }, () => false), null);
	assert.equal(findChrome({ CHROME_PATH: "/opt/x/chrome" }, (file) => file === "/opt/x/chrome"), "/opt/x/chrome");
	assert.equal(findChrome({ PI_BROWSER_CHROME: "/a", CHROME_PATH: "/b" }, () => true), "/a", "pi-browser's own name first");
	assert.equal(findChrome({ PATH: "/usr/local/bin:/bin" }, (file) => file === "/bin/chromium"), "/bin/chromium");
	const missing = provider({ executablePath: join(scratch, "no-chrome") });
	const [refusal] = missing.check(SPEC);
	assert.equal(refusal.field, "image");
	assert.ok(refusal.message.endsWith(NO_CHROME));
	assert.match(NO_CHROME, /install Google Chrome or Chromium/);
	assert.match(NO_CHROME, /executablePath/);
	assert.match(NO_CHROME, /CHROME_PATH/);
	const made = await missing.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "not_found");
	const tested = await missing.testConnection();
	assert.equal(tested.ok, false);
	assert.equal(tested.error.code, "not_found");
	assert.match(tested.error.message, /install Google Chrome or Chromium/);
});

test("create starts Chrome headless with a fresh profile, a loopback debugging port and the fence; connect hands over its DevTools URL; release ends it", async () => {
	const p = provider();
	const made = await p.create(SPEC);
	assert.ok(made.ok, made.ok ? "" : made.error.message);
	const { id } = made.value;
	assert.match(id, /^lb-[0-9a-f]{16}$/);
	const dir = files(p, id);
	const record = json(join(dir, "browser.json"));
	assert.deepEqual(record.labels, SPEC.labels, "the labels a list finds it by, in its own directory");
	assert.ok(Math.abs(Date.parse(record.deadline) - Date.parse(record.created) - SPEC.lifetimeMs) < 5);
	const state = json(join(dir, "state.json"));
	const argv = json(join(dir, "profile", "argv.json"));
	for (const flag of CHROME_FLAGS) assert.ok(argv.includes(flag), flag);
	assert.ok(argv.includes("--headless=new"));
	assert.ok(argv.includes(`--user-data-dir=${join(dir, "profile")}`));
	assert.ok(argv.includes("--remote-debugging-port=0"), "a port Chrome picks");
	assert.ok(argv.includes("--remote-debugging-address=127.0.0.1"), "on loopback alone"); // key-gate: loopback-rule the fake Chrome's DevTools socket
	assert.ok(!argv.some((arg) => arg.startsWith("--no-sandbox")), "the sandbox is never turned off");
	const relay = `http://127.0.0.1:${state.relay}`; // key-gate: loopback-rule the local Chrome's relay to its egress proxy
	for (const flag of chromeFence(relay)) assert.ok(argv.includes(flag), flag);
	assert.ok(argv.includes(`--host-resolver-rules=MAP 127.0.0.1:${state.relay} 127.0.0.1:${state.relay}, MAP * ~NOTFOUND`), "Chrome resolves no name but its proxy's"); // key-gate: loopback-rule the local Chrome's relay
	assert.ok(argv.includes("--proxy-bypass-list=<-loopback>"), "loopback goes through the proxy too");
	// The fence holds: through the proxy, the metadata address and this machine's loopback are both refused.
	await until("the fake Chrome's probe", () => existsSync(join(dir, "profile", "probe.json")));
	const probe = json(join(dir, "profile", "probe.json"));
	assert.match(probe.metadata, /^HTTP\/1\.1 403 /, "a cloud's metadata address is refused");
	assert.match(probe.loopback, /^HTTP\/1\.1 403 /, "this machine's own services are refused");

	const connected = await p.connect(made.value);
	assert.ok(connected.ok, connected.ok ? "" : connected.error.message);
	assert.equal(connected.value.cdp.url, `ws://127.0.0.1:${state.port}${state.path}`); // key-gate: loopback-rule the fake Chrome's DevTools socket
	assert.equal(connected.value.hello.kind, "browser");
	assert.deepEqual(await cdp(connected.value.cdp.url, "Browser.getVersion"), { product: "FakeChrome/1.0" });
	assert.ok((await connected.value.client.call("ping", {})).ok);
	assert.equal((await connected.value.client.call("exec", {})).error.code, "unsupported");
	await connected.value.close();

	const listed = await p.list({ "agentrun.run": "run-1" });
	assert.deepEqual(listed.value.map((one) => [one.ref.id, one.state, one.network]), [[id, "running", "open"]]);
	assert.equal(listed.value[0].deadline.toISOString(), record.deadline);
	assert.deepEqual((await p.list({ "agentrun.run": "other" })).value, []);
	assert.equal((await p.attach({ labels: { "agentrun.run": "run-1" } })).value.id, id);
	const attached = await p.attach({ id });
	assert.deepEqual([attached.value.spec.image, attached.value.spec.network, attached.value.spec.kind], ["chromium", "open", "browser"]);
	assert.equal((await p.network(made.value)).value, "open");
	assert.equal((await p.network(made.value, "none")).error.code, "refused");
	assert.equal((await p.release(made.value, "stop")).error.code, "refused");

	const supervisor = Number(readFileSync(join(dir, "supervisor.pid"), "utf8"));
	assert.ok(alive(state.pid) && alive(supervisor));
	const released = await p.release(made.value, "delete");
	assert.ok(released.ok, released.ok ? "" : released.error.message);
	assert.equal(existsSync(dir), false, "the profile and every file of the browser's are gone");
	await until("Chrome and its supervisor ended", () => !alive(state.pid) && !alive(supervisor));
	assert.ok((await p.release(made.value, "delete")).ok, "a release of a browser already gone is done");
	assert.equal((await p.connect(made.value)).error.code, "not_found");
	assert.deepEqual((await p.list({})).value, []);
});

test("the deadline ends the browser though the process that made it is gone: a crashed run leaves no Chrome", async () => {
	const root = join(scratch, "crashed");
	// A process that makes a browser of 1.5 s and exits at once, without releasing it.
	const maker = `import { LocalBrowserProvider } from ${JSON.stringify(new URL("../dist/local.js", import.meta.url).href)};
const made = await new LocalBrowserProvider({ executablePath: ${JSON.stringify(CHROME)}, root: ${JSON.stringify(root)}, uid: ${UID} }).create({ image: "chromium", lifetimeMs: 1500, network: "open" });
process.stdout.write(JSON.stringify(made));
process.exit(0);`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", maker], { stdio: ["ignore", "pipe", "inherit"] });
	let out = "";
	child.stdout.on("data", (chunk) => (out += chunk));
	await new Promise((done) => child.once("exit", done));
	const made = JSON.parse(out);
	assert.ok(made.ok, out);
	const dir = join(root, made.value.id);
	const { pid } = json(join(dir, "state.json"));
	assert.ok(alive(pid), "Chrome outlives the process that made it");
	await until("the deadline ended Chrome and removed its files", () => !existsSync(dir) && !alive(pid), 10_000);
});

test("a supervisor killed while Chrome starts leaves Chrome's pid: the release ends that Chrome and removes its files", async (t) => {
	process.env.FAKE_CHROME_MODE = "hang";
	t.after(() => delete process.env.FAKE_CHROME_MODE);
	const p = provider();
	const making = p.create(SPEC);
	let id;
	await until("the supervisor spawned Chrome and wrote its pid", () => {
		id = existsSync(p.root) ? readdirSync(p.root).find((name) => existsSync(join(p.root, name, "chrome.pid"))) : undefined;
		return id !== undefined;
	});
	const dir = files(p, id);
	const pid = Number(readFileSync(join(dir, "chrome.pid"), "utf8"));
	assert.ok(alive(pid), "Chrome runs, not yet answering");
	process.kill(Number(readFileSync(join(dir, "supervisor.pid"), "utf8")), "SIGKILL");
	assert.ok(!existsSync(join(dir, "state.json")), "no state was written: Chrome never answered");
	assert.deepEqual(await p.release({ id, name: id }, "delete"), { ok: true, value: undefined });
	await until("the release ended the Chrome the supervisor left", () => !alive(pid));
	assert.ok(!existsSync(dir), "and removed its files");
	assert.equal((await making).ok, false, "the create that lost its supervisor fails");
});

test("a Chrome that cannot start its sandbox is refused in words that never offer to turn it off, and leaves nothing", async (t) => {
	process.env.FAKE_CHROME_MODE = "sandbox";
	t.after(() => delete process.env.FAKE_CHROME_MODE);
	const p = provider();
	const made = await p.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /could not start its sandbox/);
	assert.match(made.error.message, /never runs Chrome without it/);
	assert.deepEqual((await p.list({})).value, [], "no browser left");
	const tested = await p.testConnection();
	assert.equal(tested.ok, false);
	assert.equal(tested.error.code, "refused");
	assert.match(tested.error.message, /No usable sandbox/);
	assert.ok((await provider({ uid: 0 }).testConnection()).error.message.includes("root"));
});

test("a create stopped while it works starts no Chrome, or ends the one it started, and leaves nothing", async () => {
	/** A signal that reads as aborted from its nth read on, and fires no event: a stop that came between two checks. */
	const abortedFrom = (n) => {
		let reads = 0;
		return { get aborted() { return ++reads >= n; }, addEventListener() {}, removeEventListener() {} };
	};
	// Stopped while the directory was made: the supervisor is never started.
	const early = provider();
	const before = await early.create(SPEC, { signal: abortedFrom(2) });
	assert.equal(before.ok, false);
	assert.equal(before.error.code, "aborted");
	assert.match(before.error.message, /aborted before Chrome was started/);
	assert.deepEqual(readdirSync(early.root), [], "no directory left");
	// Stopped before the listener was added: the abort is read there, and the supervisor it started is ended.
	const late = provider();
	const during = await late.create(SPEC, { signal: abortedFrom(3) });
	assert.equal(during.ok, false);
	assert.equal(during.error.code, "aborted");
	assert.match(during.error.message, /aborted while Chrome started; it was ended/);
	assert.deepEqual((await late.list({})).value, [], "no browser left");
	assert.deepEqual(readdirSync(late.root), [], "no directory left");
});

test("testConnection starts the Chrome once with its sandbox on and keeps nothing", async () => {
	const p = provider();
	const tested = await p.testConnection();
	assert.ok(tested.ok, tested.ok ? "" : tested.error.message);
	assert.match(tested.value.detail, /starts here with its sandbox on: no key is needed/);
	assert.deepEqual((await p.list({})).value, []);
});

test("a relative root is made absolute once, so the profile Chrome is given and the one a liveness check or a release matches are the same path", () => {
	const p = new LocalBrowserProvider({ executablePath: CHROME, root: "browsers", uid: UID });
	assert.equal(p.root, resolve("browsers"));
});

test("the registry builds it from its options alone; an id that is not one is refused", async () => {
	const module = await providerModule("local");
	assert.deepEqual(module.MOUNT, []);
	assert.deepEqual(module.CAPABILITIES, [{ kind: "browser", groups: ["cdp"] }]);
	const built = await module.create({ executablePath: CHROME, root: join(scratch, "registry") });
	assert.equal(built.id, "local");
	assert.ok(create() instanceof LocalBrowserProvider);
	for (const bad of ["../x", "lb-zz", ""]) assert.equal((await built.release({ id: bad, name: bad }, "delete")).error.code, "invalid", bad);
});
