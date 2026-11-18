// The attach binding over an in-memory socket pair: the ui cases pass through it on a fake driver that "dialed out";
// a drop fails what was in flight with gone and a redial is a fresh connection; a second socket replaces the first; a
// hello that is not what the computer paired as is closed with its code; one run holds the computer at a time.
import assert from "node:assert/strict";
import test from "node:test";
import { ATTACH_CLOSE, AttachHub, attachedProvider, conformanceCases, formatReport, kindServed, PROTOCOL_VERSION, redialDelay, redials, runConformance, socketStreams } from "../dist/index.js";
import { FakeUiDriver, serveUiSocket, UI_FIXTURE } from "../dist/fake-ui-driver.js";

const APP = UI_FIXTURE.id;
/** The groups a desktop must declare to be given to an agent, and the ui group these tests call. */
const DESKTOP = ["screen", "input.pointer", "input.keys", "apps", "ui"];
/** A new create request: each create below is its own unless a test retries one. */
let requests = 0;
const req = () => ({ requestId: `attach-test-${++requests}` });

/** A Mac's driver as serve sees it: a desktop that declares what a desktop needs. The fake answers apps and ui alone, all these tests call. */
class Mac extends FakeUiDriver {
	constructor(options = {}) {
		super({ groups: DESKTOP, ...options });
	}
}

/** Two ends of one socket, delivering in order, closing both ends at once. */
function socketPair() {
	const ends = [
		{ text: [], closes: [] },
		{ text: [], closes: [] },
	];
	let closed;
	const side = (me, peer) => ({
		send(text) {
			if (!closed) queueMicrotask(() => peer.text.forEach((listener) => listener(text)));
		},
		close(code, reason) {
			if (closed) return;
			closed = { code, reason };
			queueMicrotask(() => [...me.closes, ...peer.closes].forEach((listener) => listener(code, reason)));
		},
		onText(listener) {
			me.text.push(listener);
		},
		onClose(listener) {
			me.closes.push(listener);
		},
		get closed() {
			return closed;
		},
	});
	return [side(ends[0], ends[1]), side(ends[1], ends[0])];
}

/** A fake driver dialed in: serve's end accepted by the hub. */
async function dial(hub, paired, driver) {
	const [serve, computer] = socketPair();
	serveUiSocket(driver, computer);
	return { serve, computer, accepted: await hub.accept(paired, serve) };
}

const pairedFor = (driver, id = "c-1") => ({ id, name: "Test Mac", hello: driver.hello(), labels: { owner: "test" } });

test("the ui cases pass through the attach binding, and the run's hold ends on release", { timeout: 60_000 }, async () => {
	const driver = new Mac();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const { accepted } = await dial(hub, paired, driver);
	assert.equal(accepted.ok, true);
	const ids = ["ui.hello", "ui.observe-shape", "ui.fixture-shape", "ui.refs-stable", "ui.expect", "ui.stale-ref", "ui.stale-point", "ui.route-reported", "ui.features-declared", "ui.features-off-refused"];
	const report = await runConformance(attachedProvider(paired, hub), { image: "attached", patience: 5000, cases: conformanceCases.filter((c) => ids.includes(c.id)) });
	for (const id of ids.filter((id) => id !== "ui.observe-shape")) assert.equal(report.results.find((r) => r.id === id)?.status, "pass", `${id}\n${formatReport(report)}`);
	assert.equal(hub.claimed(paired.id), undefined, "the run released its hold");
	assert.equal(hub.online(paired.id), true, "and the computer stays attached");
	driver.close();
});

test("a drop fails the calls in flight with gone; a redial is a fresh connection, whose refs are its own", async () => {
	const driver = new Mac();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const dialed = Date.now();
	const first = await dial(hub, paired, driver);
	const since = hub.since(paired.id);
	assert.ok(since instanceof Date && since.getTime() >= dialed && since.getTime() <= Date.now(), `live since its hello: ${since}`);
	const before = hub.connection(paired.id);
	await before.client.call("apps.launch", { id: APP });
	const seen = await before.client.call("ui.observe", {});
	const waiting = before.client.call("ui.act", { steps: [], expect: { text: "never", timeoutMs: 30_000 } });
	await new Promise((resolve) => setTimeout(resolve, 50));
	first.computer.close(ATTACH_CLOSE.going, "the network changed");
	const dropped = await waiting;
	assert.equal(dropped.ok, false);
	assert.equal(dropped.error.code, "gone");
	assert.equal(hub.online(paired.id), false);
	assert.equal(hub.since(paired.id), undefined, "not live, so no since");
	assert.equal(hub.connection(paired.id), undefined);
	await dial(hub, paired, driver);
	const after = hub.connection(paired.id);
	const save = seen.value.nodes.find((n) => n.id === "save").ref;
	const old = await after.client.call("ui.act", { steps: [{ press: save }] });
	assert.equal(old.error.code, "invalid", "a ref from the dropped connection is not this one's: observe again");
	assert.equal((await after.client.call("ui.observe", {})).value.app.id, APP, "the apps outlive the connection");
	driver.close();
});

test("a second socket from the same computer replaces the first", async () => {
	const driver = new Mac();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const first = await dial(hub, paired, driver);
	const second = await dial(hub, paired, driver);
	assert.equal(second.accepted.ok, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(first.serve.closed.code, ATTACH_CLOSE.replaced);
	assert.equal(hub.online(paired.id), true, "the replaced socket's close does not take the new one down");
	assert.equal((await hub.connection(paired.id).client.call("ping", {})).ok, true);
	driver.close();
});

test("an older dial whose hello answers after a newer one went live is closed, never put in its place", async () => {
	const hub = new AttachHub();
	let answer;
	const gate = new Promise((resolve) => {
		answer = resolve;
	});
	class Slow extends Mac {
		async handle(engine, method, params, signal) {
			if (method === "hello") await gate;
			return super.handle(engine, method, params, signal);
		}
	}
	const slow = new Slow();
	const quick = new Mac();
	const paired = pairedFor(quick);
	const [olderServe, olderComputer] = socketPair();
	serveUiSocket(slow, olderComputer);
	const older = hub.accept(paired, olderServe);
	const newer = await dial(hub, paired, quick);
	assert.equal(newer.accepted.ok, true);
	answer();
	const late = await older;
	assert.equal(late.ok, false);
	assert.match(late.error.message, /dialed again while this socket said hello, and the newer one is live/);
	assert.equal(olderServe.closed.code, ATTACH_CLOSE.replaced);
	assert.equal(newer.serve.closed, undefined, "the newer socket stays open");
	assert.equal((await hub.connection(paired.id).client.call("ping", {})).ok, true, "and stays the live one");
	slow.close();
	quick.close();
});

test("a socket that closes while it says hello never goes live", async () => {
	const hub = new AttachHub();
	let answer;
	const gate = new Promise((resolve) => {
		answer = resolve;
	});
	class Slow extends Mac {
		async handle(engine, method, params, signal) {
			if (method === "hello") await gate;
			return super.handle(engine, method, params, signal);
		}
	}
	const driver = new Slow();
	const paired = pairedFor(driver);
	const [serve, computer] = socketPair();
	serveUiSocket(driver, computer);
	const accepting = hub.accept(paired, serve);
	await new Promise((resolve) => setTimeout(resolve, 20));
	computer.close(ATTACH_CLOSE.going, "the network changed");
	answer();
	const accepted = await accepting;
	assert.equal(accepted.ok, false, JSON.stringify(accepted));
	assert.equal(hub.online(paired.id), false, "the closed socket is not the computer's live one");
	driver.close();
});

test("a run's connection outlives a redial: gone while the computer is away; the first call after it is refused gone unrun (its old refs and handles are void), then its calls go over the new socket", async () => {
	const driver = new Mac();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const first = await dial(hub, paired, driver);
	const run = hub.connection(paired.id);
	assert.equal((await run.client.call("ping", {})).ok, true);
	first.computer.close(ATTACH_CLOSE.going, "the network changed");
	await new Promise((resolve) => setImmediate(resolve));
	const away = await run.client.call("ping", {});
	assert.equal(away.error?.code, "gone", JSON.stringify(away));
	await dial(hub, paired, driver);
	const told = await run.client.call("ping", {});
	assert.equal(told.error?.code, "gone", JSON.stringify(told));
	assert.match(told.error.message, /dialed back since the last call: its refs, states and handles from before are void/);
	assert.equal((await run.client.call("ping", {})).ok, true, "then the run's connection reaches the computer over its new socket");
	// A redial between two calls, with no call seeing the computer away, is told all the same.
	const replaced = await dial(hub, paired, driver);
	assert.equal(replaced.accepted.ok, true);
	assert.equal((await run.client.call("ping", {})).error?.code, "gone", "a socket replaced between calls is told");
	assert.equal((await run.client.call("ping", {})).ok, true, "and the call after goes over the one that replaced it");
	driver.close();
});

test("a hello that is not what the computer paired as is closed: another kind with mismatch, another protocol with protocol", async () => {
	const hub = new AttachHub();
	const phone = new FakeUiDriver({ os: "android", kind: "android" });
	const mac = new Mac();
	const wrongKind = await dial(hub, pairedFor(phone), mac);
	assert.equal(wrongKind.accepted.ok, false);
	assert.match(wrongKind.accepted.error.message, /paired as a android android on arm64 and now says macos desktop on arm64: pair it again/);
	assert.equal(wrongKind.serve.closed.code, ATTACH_CLOSE.mismatch);
	class Old extends Mac {
		hello() {
			return { ...super.hello(), protocol: "0.1" };
		}
	}
	const old = await dial(hub, pairedFor(mac), new Old());
	assert.equal(old.serve.closed.code, ATTACH_CLOSE.protocol);
	assert.match(old.accepted.error.message, /speaks protocol 0\.1, and this server 0\.2: update the driver on Test Mac \(the download is on the console's Computers page\)$/);
	assert.equal(redials(old.serve.closed.code), false, "a driver of another protocol stops dialing until it is updated");
	assert.equal(hub.online("c-1"), false);
});

test("a paired computer's token on another machine: another arch or os is closed with mismatch and stops dialing; the same os and arch replaces the live socket", async () => {
	const hub = new AttachHub();
	const box = new FakeUiDriver({ os: "linux", kind: "desktop", groups: DESKTOP });
	const paired = { ...pairedFor(box, "cmp-box"), hello: { ...box.hello(), arch: "amd64" } };
	class OtherArch extends FakeUiDriver {
		hello() {
			return { ...super.hello(), arch: "arm64" };
		}
	}
	const otherArch = await dial(hub, paired, new OtherArch({ os: "linux", kind: "desktop", groups: DESKTOP }));
	assert.equal(otherArch.accepted.ok, false);
	assert.equal(otherArch.accepted.error.message, "Test Mac paired as a linux desktop on amd64 and now says linux desktop on arm64: pair it again");
	assert.equal(otherArch.serve.closed.code, ATTACH_CLOSE.mismatch);
	assert.equal(redials(otherArch.serve.closed.code), false, "a machine the token was not paired on stops dialing");
	class Amd64 extends FakeUiDriver {
		hello() {
			return { ...super.hello(), arch: "amd64" };
		}
	}
	const otherOs = await dial(hub, paired, new Amd64({ groups: DESKTOP }));
	assert.equal(otherOs.accepted.error.message, "Test Mac paired as a linux desktop on amd64 and now says macos desktop on amd64: pair it again");
	assert.equal(otherOs.serve.closed.code, ATTACH_CLOSE.mismatch);
	assert.equal(hub.online(paired.id), false);
	// A copy on a machine of the same os and arch says the same hello: nothing in it tells the two apart, so the newer
	// dial takes the computer and the older socket is closed with replaced (and dials again).
	const first = await dial(hub, paired, new Amd64({ os: "linux", kind: "desktop", groups: DESKTOP }));
	assert.equal(first.accepted.ok, true);
	const copy = await dial(hub, paired, new Amd64({ os: "linux", kind: "desktop", groups: DESKTOP }));
	assert.equal(copy.accepted.ok, true);
	assert.equal(first.serve.closed.code, ATTACH_CLOSE.replaced);
	assert.equal(redials(ATTACH_CLOSE.replaced), true);
});

test("a desktop whose hello lacks the pointer and keys is closed at connect with protocol, naming its os, its kind and the groups, and stops dialing", async () => {
	const hub = new AttachHub();
	// What the first Mac driver said: a desktop with no input.pointer and no input.keys, which no agent can be given.
	const lacking = new FakeUiDriver({ groups: ["exec", "files", "screen", "apps", "ui"] });
	const { serve, accepted } = await dial(hub, pairedFor(lacking), lacking);
	assert.equal(accepted.ok, false);
	assert.equal(serve.closed.code, ATTACH_CLOSE.protocol);
	assert.equal(accepted.error.message, "Test Mac says it is a macos desktop but declares no input.pointer, input.keys: update the driver on Test Mac (the download is on the console's Computers page)");
	assert.equal(redials(serve.closed.code), false, "a person updates the driver before it dials again");
	assert.equal(hub.online("c-1"), false);
	const phone = new FakeUiDriver({ os: "android", kind: "android", groups: ["screen", "apps", "ui"] });
	const refused = await dial(hub, pairedFor(phone, "p-1"), phone);
	assert.match(refused.accepted.error.message, /^Test Mac says it is a android android but declares no input\.touch: /);
	const served = new Mac();
	assert.equal((await dial(hub, pairedFor(served), served)).accepted.ok, true, "the same machine declaring what a desktop needs goes live");
	assert.deepEqual(kindServed(served.hello()), []);
	assert.deepEqual(kindServed({ kind: "desktop", groups: ["apps", "ui"] }), ["screen", "input.pointer", "input.keys"]);
	assert.deepEqual(kindServed({ kind: "browser", groups: ["cdp"] }), []);
	assert.deepEqual(kindServed({ kind: "linux", groups: ["exec"] }), ["files", "processes"]);
});

test("a revoke while the computer says hello closes that socket too: a removed computer never comes back", async () => {
	const hub = new AttachHub();
	let answer;
	const gate = new Promise((resolve) => {
		answer = resolve;
	});
	class Slow extends Mac {
		async handle(engine, method, params, signal) {
			if (method === "hello") await gate;
			return super.handle(engine, method, params, signal);
		}
	}
	const driver = new Slow();
	const paired = pairedFor(driver);
	const [serve, computer] = socketPair();
	serveUiSocket(driver, computer);
	const accepting = hub.accept(paired, serve);
	await new Promise((resolve) => setTimeout(resolve, 20));
	hub.revoke(paired.id, "the owner removed this computer");
	answer();
	const accepted = await accepting;
	assert.equal(accepted.ok, false);
	assert.equal(serve.closed.code, ATTACH_CLOSE.unauthorized);
	assert.equal(hub.online(paired.id), false, "it is not back in the hub");
	driver.close();
});

test("a hello with no protocol or version is closed with protocol and the update words, never left open", async () => {
	const hub = new AttachHub();
	const mac = new Mac();
	class Blank extends Mac {
		hello() {
			return {};
		}
	}
	const blank = await dial(hub, pairedFor(mac), new Blank());
	assert.equal(blank.accepted.ok, false);
	assert.equal(blank.serve.closed.code, ATTACH_CLOSE.protocol);
	assert.match(blank.accepted.error.message, /answered hello without its protocol and version: update the driver on Test Mac/);
	// A hello of this protocol without a field serve reads is refused at the door, never met later as a throw.
	class NoGroups extends Mac {
		hello() {
			const { groups: _groups, arch: _arch, ...rest } = super.hello();
			return rest;
		}
	}
	const thin = await dial(hub, pairedFor(mac), new NoGroups());
	assert.equal(thin.serve.closed.code, ATTACH_CLOSE.protocol);
	assert.match(thin.accepted.error.message, /answered a protocol 0\.2 hello without arch, groups: update the driver on Test Mac \(the download is on the console's Computers page\)/);
	assert.equal(hub.online("c-1"), false);
});

test("a driver that answers pings but never hello is closed idle once the hello wait ends, saying so", async () => {
	const hub = new AttachHub({ helloMs: 50 });
	class Mute extends Mac {
		async handle(engine, method, params, signal) {
			if (method === "hello") return new Promise(() => {});
			return super.handle(engine, method, params, signal);
		}
	}
	const driver = new Mute();
	const paired = pairedFor(driver);
	const [serve, computer] = socketPair();
	serveUiSocket(driver, computer);
	const accepted = await hub.accept(paired, serve);
	assert.equal(accepted.error?.code, "timeout");
	assert.match(accepted.error.message, /did not answer hello within 0\.05 s/);
	assert.equal(serve.closed.code, ATTACH_CLOSE.idle);
	assert.equal(redials(ATTACH_CLOSE.idle), true, "it dials again on its own schedule");
	assert.equal(hub.online(paired.id), false);
	driver.close();
});

test("a driver updated within the protocol is accepted, and the provider's version and groups follow its live hello", async () => {
	const hub = new AttachHub();
	const driver = new Mac();
	const paired = pairedFor(driver);
	class Updated extends Mac {
		hello() {
			return { ...super.hello(), version: "fake.2", groups: [...DESKTOP, "files"] };
		}
	}
	const provider = attachedProvider(paired, hub);
	assert.equal(provider.version, "fake");
	const updated = await dial(hub, paired, new Updated());
	assert.equal(updated.accepted.ok, true);
	assert.equal(provider.version, "fake.2");
	assert.deepEqual(provider.capabilities().groups, [...DESKTOP, "files"]);
	const connected = await provider.connect({ id: paired.id, name: paired.name });
	assert.equal(connected.value.hello.version, provider.version, "the drift check's two versions agree");
});

test("one run holds an attached computer; offline refuses create; release never stops it; revoke closes it", async () => {
	const driver = new Mac();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const provider = attachedProvider(paired, hub);
	const spec = { image: "attached", lifetimeMs: 60_000, network: "open", labels: { run: "a" } };
	const offline = await provider.create(spec, req());
	assert.equal(offline.error.code, "gone");
	assert.match(offline.error.message, /is not attached now/);
	assert.equal((await provider.create(spec)).error.code, "invalid", "a create with no request id");
	const { serve } = await dial(hub, paired, driver);
	const request = req();
	const held = (await provider.create(spec, request)).value;
	assert.match(held.id, new RegExp(`^${paired.id}\\.[0-9a-f]{16}$`), "the run's ref names its hold");
	assert.equal((await provider.create(spec, request)).value.id, held.id, "the same request again answers its hold");
	const relabelled = await provider.create({ ...spec, labels: { run: "b" } }, request);
	assert.equal(relabelled.error.code, "exists", "the same request id with other labels is another request");
	assert.match(relabelled.error.message, /other labels/);
	assert.equal((await provider.create({ ...spec, labels: { run: "a", extra: "1" } }, request)).error.code, "exists", "labels beyond the claim's");
	assert.equal((await provider.create({ ...spec, labels: {} }, request)).error.code, "exists", "labels short of the claim's");
	assert.equal((await provider.create(spec, request)).value.id, held.id, "the claim's own labels still answer");
	const second = await provider.create({ ...spec, labels: { run: "b" } }, req());
	assert.equal(second.error.code, "refused");
	assert.deepEqual((await provider.list({ run: "a" })).value.map((one) => one.ref.id), [held.id]);
	assert.deepEqual((await provider.list({ run: "b" })).value, []);
	assert.equal((await provider.release(held, "stop")).error.code, "unsupported");
	assert.equal((await provider.release({ id: paired.id, name: paired.name }, "delete")).error.code, "invalid", "release names a hold, never the computer");
	assert.equal((await provider.release(held, "delete")).ok, true);
	const spent = await provider.create(spec, request);
	assert.equal(spent.error.code, "exists", "the same request after its hold ended");
	assert.match(spent.error.message, /was made for this request and has ended: create with a new request id/);
	assert.equal((await provider.create({ ...spec, labels: { run: "b" } }, req())).ok, true, "released, another run may hold it");
	hub.revoke(paired.id, "the owner removed this computer");
	assert.equal(serve.closed.code, ATTACH_CLOSE.unauthorized);
	assert.equal(redials(ATTACH_CLOSE.unauthorized), false);
	assert.equal(hub.claimed(paired.id), undefined);
	driver.close();
});

test("a run's release closes its connections: their calls in flight are cancelled and later ones refused, so the next run's computer is its own; a narrowed network is refused", async () => {
	const driver = new Mac();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const provider = attachedProvider(paired, hub);
	await dial(hub, paired, driver);
	const spec = { image: "attached", lifetimeMs: 60_000, network: "open", labels: { run: "a" } };
	for (const network of ["none", { allow: ["example.com"] }]) {
		const refused = await provider.create({ ...spec, network }, req());
		assert.equal(refused.error.code, "refused");
		assert.match(refused.error.message, /a person's own machine on its own network, which a run cannot block or limit/);
	}
	assert.equal((await provider.network({ id: paired.id, name: paired.name }, "none")).error.code, "refused");
	const a = (await provider.create(spec, req())).value;
	const first = (await provider.connect(a)).value;
	await first.client.call("apps.launch", { id: APP });
	const waiting = first.client.call("ui.act", { steps: [], expect: { text: "never", timeoutMs: 30_000 } });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal((await provider.release(a, "delete")).ok, true);
	assert.equal((await waiting).error.code, "aborted", "the released run's call in flight is cancelled");
	assert.equal((await first.client.call("ping", {})).error.code, "gone", "and its later calls are refused");
	assert.equal((await provider.connect(a)).error?.code, "gone", "and it cannot connect again under its ended hold");
	const b = (await provider.create({ ...spec, labels: { run: "b" } }, req())).value;
	const second = (await provider.connect(b)).value;
	assert.equal((await second.client.call("ping", {})).ok, true, "the next run's connection works over the same socket");
	assert.equal((await provider.release(a, "delete")).ok, true, "a late release of the ended hold answers ok");
	assert.equal((await second.client.call("ping", {})).ok, true, "and ends nothing of the next run's");
	assert.deepEqual(hub.claimed(paired.id), { run: "b" });
	assert.equal((await provider.attach({ id: a.id })).error?.code, "gone");
	driver.close();
});

test("a run's hold on an attached computer ends at its lifetime, released or not: its connections close, the next run may claim it, and the machine stays attached", async () => {
	const driver = new Mac();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const provider = attachedProvider(paired, hub);
	const { serve } = await dial(hub, paired, driver);
	const spec = { image: "attached", lifetimeMs: 80, network: "open", labels: { run: "a" } };
	const a = (await provider.create(spec, req())).value;
	const [held] = (await provider.list({ run: "a" })).value;
	assert.ok(held.deadline instanceof Date && held.deadline.getTime() > Date.now(), "the hold reports its deadline");
	assert.ok((await provider.attach({ id: a.id })).value.spec.deadline instanceof Date);
	const run = (await provider.connect(a)).value;
	assert.equal((await run.client.call("ping", {})).ok, true);
	assert.equal((await provider.create({ ...spec, labels: { run: "b" } }, req())).error?.code, "refused", "held until its deadline");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal((await run.client.call("ping", {})).error?.code, "gone", "the expired run's connection is closed");
	assert.equal(hub.claimed(paired.id), undefined);
	assert.equal(hub.online(paired.id), true, "the person's machine stays attached");
	assert.equal(serve.closed, undefined);
	const b = (await provider.create({ ...spec, labels: { run: "b" }, lifetimeMs: 60_000 }, req())).value;
	assert.ok(b, "the next run claims it");
	assert.equal((await provider.release(a, "delete")).ok, true, "run a's late release, after its deadline");
	assert.deepEqual(hub.claimed(paired.id), { run: "b" }, "leaves run b's hold");
	assert.equal((await provider.release(b, "delete")).ok, true);
	const agent = await provider.create({ image: "attached", network: "open", labels: { agent: "x" }, owner: { agent: "x" } }, req());
	assert.equal(agent.ok, true, JSON.stringify(agent));
	assert.equal(hub.deadline(paired.id), undefined, "an agent's hold has no deadline");
	driver.close();
});

/** What computerd init says on a Linux box with no display: a sandbox's machine. */
const LINUX = { protocol: PROTOCOL_VERSION, version: "0.2.0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };
/** A run's create on it, its folder a synced folder, under the run's claim epoch 3. */
const SYNCED = { image: "attached", lifetimeMs: 60_000, network: "open", mount: { kind: "sync" }, labels: { "agentrun.run": "r1", "agentrun.epoch": "3" } };

/** A Linux box's computerd on `computer`'s end, scripted: it runs as uid 1000, its /workspace is `box.workspace` ({ type,
 *  uid, mode }, or none), holding the names in `box.entries` (its listing truncated when `box.truncated`, and a remove
 *  finding none of them when `box.unreachable`, as for a name that is not UTF-8 and reaches the wire changed); each
 *  files call is recorded with its path. */
function linuxBox(computer, box) {
	computer.onText((text) => {
		const { id, method, params } = JSON.parse(text);
		if (id === undefined) return;
		if (method.startsWith("files.")) box.calls.push(`${method} ${params.path}${params.recursive ? " recursive" : ""}`);
		if (method.startsWith("process.")) box.calls.push(`${method}${params.id ? ` ${params.id}` : ""}${params.signal ? ` ${params.signal}` : ""}`);
		const reply = (result) => computer.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
		const refuse = (kind, message) => computer.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message, data: { kind } } }));
		const program = box.programs.find((one) => one.id === params?.id);
		if (method === "hello") return reply(LINUX);
		if (method === "files.read" && params.path === "/proc/self/status") return reply({ data: Buffer.from("Name:\tcomputerd\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n").toString("base64"), eof: true, size: 0 });
		if (method === "files.stat" && params.path === "/workspace") return void box.stat.then(() => (box.workspace ? reply({ size: 0, mtimeMs: 0, gid: 1000, ...box.workspace }) : refuse("not_found", "stat /workspace: no such file or directory")));
		if (method === "process.list") return reply({ processes: box.programs.map((one) => ({ pid: 40, argv: ["sleep", "1000"], argvClipped: false, pty: false, startedAt: 0, endedAt: one.running ? null : 1, exitCode: null, signal: null, ...one })), truncated: false, next: box.programs.length });
		if (method === "process.signal") return program.stubborn ? reply({}) : ((program.running = false), reply({}));
		if (method === "process.wait") return reply({ running: program.running, exitCode: null, signal: program.running ? null : "KILL" });
		// A loop of listings never yields to a timer here (each answer is a microtask), so the fake bounds it.
		if (method === "files.list" && box.calls.filter((call) => call.startsWith("files.list")).length > 50) return refuse("limit", "listed /workspace 50 times: emptying it would go on forever");
		if (method === "files.list") return reply({ entries: box.entries.map((name) => ({ path: `/workspace/${name}`, type: "file", size: 0, mode: 0o644, mtimeMs: 0, uid: 1000, gid: 1000 })), truncated: box.truncated === true });
		if (method === "files.remove" && box.unreachable) return refuse("not_found", `lstat ${params.path}: no such file or directory`);
		if (method === "files.remove") {
			box.entries = box.entries.filter((name) => `/workspace/${name}` !== params.path);
			return reply({});
		}
		return reply({});
	});
}

test("a paired Linux box is a sandbox that takes the run's folder as a synced folder in its own /workspace: one that is missing, a link, another user's or open to others is refused naming the fix and the hold let go; an earlier run's folder is emptied; the folder reads back under the claim epoch, from inside", async () => {
	const hub = new AttachHub();
	const paired = { id: "c-box", name: "lab", hello: LINUX, labels: {} };
	const provider = attachedProvider(paired, hub);
	const { kind, daemon, mount, vendorAgentPorts } = provider.capabilities();
	assert.deepEqual({ kind, daemon, mount, vendorAgentPorts }, { kind: "linux", daemon: "child", mount: ["sync"], vendorAgentPorts: [] }, "computerd init runs there, a child of its service manager, and attach dials out");
	const fields = (spec) => provider.check(spec).map((refusal) => refusal.field);
	assert.deepEqual(fields(SYNCED), []);
	assert.deepEqual(fields({ ...SYNCED, mount: { kind: "bind", path: "/srv/runs/r1" } }), ["mount"], "a synced folder alone");
	assert.deepEqual(fields({ ...SYNCED, mount: { kind: "archil", disk: "d", region: "r", folder: "f", token: "not-a-secret" } }), ["mount"]);
	assert.deepEqual(fields({ ...SYNCED, labels: { "agentrun.run": "r1" } }), ["labels"], "read back under the run's claim epoch");
	const mac = attachedProvider(pairedFor(new Mac(), "c-mac"), hub);
	assert.equal(mac.capabilities().mount, undefined, "a desktop takes no mount");
	assert.match(mac.check(SYNCED).find((refusal) => refusal.field === "mount")?.message ?? "", /declares no mount kind/);

	const [serve, computer] = socketPair();
	const box = { workspace: undefined, entries: ["old.txt"], calls: [], programs: [], stat: Promise.resolve() };
	linuxBox(computer, box);
	assert.equal((await hub.accept(paired, serve)).ok, true);
	const fix = "make /workspace a directory of computerd's user's own, mode 0700, as root: the tmpfiles.d line in spec/computer/attach.md, A Linux box (d /workspace 0700 <user> <user> -), then systemd-tmpfiles --create";
	for (const [workspace, words] of [
		[undefined, `lab has no /workspace, where a run's synced folder goes: ${fix}`],
		[{ type: "symlink", uid: 1000, mode: 0o777, target: "/home/ada" }, `/workspace on lab is a link, and a run's synced folder is never written through one: remove it, then ${fix}`],
		[{ type: "file", uid: 1000, mode: 0o600 }, `/workspace on lab is a file, where a run's synced folder needs a directory: remove it, then ${fix}`],
		[{ type: "dir", uid: 0, mode: 0o700 }, `/workspace on lab is uid 0's, not uid 1000's, the user computerd runs as: ${fix}`],
		[{ type: "dir", uid: 1000, mode: 0o755 }, `/workspace on lab is open to its group or others (mode 0755): ${fix}`],
	]) {
		box.workspace = workspace;
		const refused = await provider.create(SYNCED, req());
		assert.deepEqual(refused.error, { code: "refused", message: words });
		assert.equal(hub.claimed(paired.id), undefined, "the hold is let go");
	}
	assert.deepEqual(box.calls.filter((call) => !call.startsWith("files.read") && !call.startsWith("files.stat")), [], "nothing is ended, listed or removed on a box whose /workspace is not its own");

	// An earlier run's program that outlives KILL: the box is not handed on, and the hold is let go.
	box.workspace = { type: "dir", uid: 1000, mode: 0o700 };
	box.programs = [{ id: "p9", pid: 49, running: true, stubborn: true }];
	assert.deepEqual((await provider.create(SYNCED, req())).error, { code: "refused", message: "ending an earlier run's programs on lab: sleep 1000 (pid 49) is still running 5 s after KILL" });
	assert.equal(hub.claimed(paired.id), undefined, "the hold is let go");
	assert.deepEqual(box.entries, ["old.txt"], "nothing removed while it runs");

	// An earlier run's program still running, and one that ended: the running one is killed and waited for, then the
	// folder emptied, before the push. A retry of the same request while that goes on shares its answer; another request
	// finds the box held.
	box.programs = [{ id: "p0", running: false }, { id: "p1", pid: 41, running: true }];
	box.calls.length = 0;
	let stat;
	box.stat = new Promise((resolve) => (stat = resolve));
	const first = req();
	const making = provider.create(SYNCED, first);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const retried = provider.create(SYNCED, first);
	assert.deepEqual((await provider.create({ ...SYNCED, labels: { "agentrun.run": "r2", "agentrun.epoch": "4" } }, first)).error?.code, "exists", "a retry with other labels is another request, while the first is pending too");
	assert.match((await provider.create(SYNCED, req())).error?.message ?? "", /^lab is held by another run/);
	stat();
	const held = (await making).value;
	assert.deepEqual((await retried).value, held, "the retry's answer is the first's");
	assert.deepEqual(box.calls, ["files.read /proc/self/status", "files.stat /workspace", "process.list", "process.signal p1 KILL", "process.wait p1", "files.list /workspace", "files.remove /workspace/old.txt recursive"], "an earlier run's programs are ended and its folder emptied before the push");
	assert.deepEqual((await provider.attach({ id: held.id })).value.spec.mount, { kind: "sync", epoch: 3 });
	assert.deepEqual((await provider.list({ "agentrun.run": "r1" })).value.map((one) => one.mount), [{ kind: "sync", epoch: 3 }]);
	// Swapped for a link while the run holds it: the read-back says so, and the claim's check refuses it.
	box.workspace = { type: "symlink", uid: 1000, mode: 0o777, target: "/home/ada" };
	assert.deepEqual((await provider.attach({ id: held.id })).value.spec.mount, { other: `/workspace on lab is a link, and a run's synced folder is never written through one: remove it, then ${fix}` });
	assert.equal((await provider.release(held, "delete")).ok, true);
	assert.equal((await provider.attach({ id: held.id })).error?.code, "gone");

	// A run that takes no folder there: nothing is read on the box, and nothing read back.
	box.calls.length = 0;
	const plain = (await provider.create({ ...SYNCED, mount: undefined }, req())).value;
	assert.equal((await provider.attach({ id: plain.id })).value.spec.mount, undefined);
	assert.deepEqual(box.calls, []);
	hub.revoke(paired.id, "the test is over");
});

test("a paired Linux box whose truncated /workspace listing holds nothing a remove can reach is refused in words naming what was left, and the hold let go", async () => {
	const hub = new AttachHub();
	const paired = { id: "c-box", name: "lab", hello: LINUX, labels: {} };
	const provider = attachedProvider(paired, hub);
	const [serve, computer] = socketPair();
	const box = { workspace: { type: "dir", uid: 1000, mode: 0o700 }, entries: ["a", "b"], truncated: true, unreachable: true, calls: [], programs: [], stat: Promise.resolve() };
	linuxBox(computer, box);
	assert.equal((await hub.accept(paired, serve)).ok, true);
	const answer = await provider.create(SYNCED, req());
	const claimed = hub.claimed(paired.id);
	hub.revoke(paired.id, "the test is over");
	assert.deepEqual(answer.error, { code: "refused", message: "emptying /workspace on lab of an earlier run's folder: 2 entries could not be removed (first: /workspace/a: lstat /workspace/a: no such file or directory)" });
	assert.equal(claimed, undefined, "the hold is let go");
	assert.equal(box.calls.filter((call) => call === "files.list /workspace").length, 1, "a pass that removes nothing ends it");
});

test("redial delays double from 1 s to 60 s, less up to a fifth; idle, replaced and going away redial", () => {
	assert.equal(redialDelay(0, () => 0), 1000);
	assert.equal(redialDelay(3, () => 1), 6400);
	assert.equal(redialDelay(10, () => 0), 60_000);
	assert.equal(redialDelay(1000, () => 0), 60_000);
	for (const code of [ATTACH_CLOSE.normal, ATTACH_CLOSE.going, ATTACH_CLOSE.idle, ATTACH_CLOSE.replaced, 1006, 1011]) assert.equal(redials(code), true, `${code}`);
});

test("socketStreams reads a frame with raw newlines as one message, and writes each line as one frame", async () => {
	const [mine, theirs] = socketPair();
	const frames = [];
	theirs.onText((text) => frames.push(text));
	const { readable, writable } = socketStreams(mine);
	writable.write('{"a":1}\n{"b":2}\n{"c"');
	writable.write(":3}\n");
	theirs.send('{\n  "jsonrpc": "2.0",\n  "id": 1,\n  "result": {}\n}');
	const line = await new Promise((resolve) => readable.once("data", (chunk) => resolve(chunk.toString())));
	assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, result: {} });
	assert.equal(line.trimEnd().includes("\n"), false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(frames, ['{"a":1}', '{"b":2}', '{"c":3}']);
});
