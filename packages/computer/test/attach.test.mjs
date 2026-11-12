// The attach binding over an in-memory socket pair: the ui cases pass through it on a fake driver that "dialed out";
// a drop fails what was in flight with gone and a redial is a fresh connection; a second socket replaces the first; a
// hello that is not what the computer paired as is closed with its code; one run holds the computer at a time.
import assert from "node:assert/strict";
import test from "node:test";
import { ATTACH_CLOSE, AttachHub, attachedProvider, conformanceCases, formatReport, redialDelay, redials, runConformance, socketStreams } from "../dist/index.js";
import { FakeUiDriver, serveUiSocket, UI_FIXTURE } from "../dist/fake-ui-driver.js";

const APP = UI_FIXTURE.id;

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
	const driver = new FakeUiDriver();
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
	const driver = new FakeUiDriver();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const first = await dial(hub, paired, driver);
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
	const driver = new FakeUiDriver();
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

test("a hello that is not what the computer paired as is closed: another kind with mismatch, another protocol with protocol", async () => {
	const hub = new AttachHub();
	const phone = new FakeUiDriver({ os: "android", kind: "android" });
	const mac = new FakeUiDriver();
	const wrongKind = await dial(hub, pairedFor(phone), mac);
	assert.equal(wrongKind.accepted.ok, false);
	assert.match(wrongKind.accepted.error.message, /paired as a android android and now says macos desktop: pair it again/);
	assert.equal(wrongKind.serve.closed.code, ATTACH_CLOSE.mismatch);
	class Old extends FakeUiDriver {
		hello() {
			return { ...super.hello(), protocol: "0.1" };
		}
	}
	const old = await dial(hub, pairedFor(mac), new Old());
	assert.equal(old.serve.closed.code, ATTACH_CLOSE.protocol);
	assert.match(old.accepted.error.message, /speaks protocol 0\.1, and this server 0\.2: update the driver on Test Mac \(Computerd: its menu's Check for Updates/);
	assert.equal(redials(old.serve.closed.code), false, "a driver of another protocol stops dialing until it is updated");
	assert.equal(hub.online("c-1"), false);
});

test("a revoke while the computer says hello closes that socket too: a removed computer never comes back", async () => {
	const hub = new AttachHub();
	let answer;
	const gate = new Promise((resolve) => {
		answer = resolve;
	});
	class Slow extends FakeUiDriver {
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
	const mac = new FakeUiDriver();
	class Blank extends FakeUiDriver {
		hello() {
			return {};
		}
	}
	const blank = await dial(hub, pairedFor(mac), new Blank());
	assert.equal(blank.accepted.ok, false);
	assert.equal(blank.serve.closed.code, ATTACH_CLOSE.protocol);
	assert.match(blank.accepted.error.message, /answered hello without its protocol and version: update the driver on Test Mac/);
});

test("a driver updated within the protocol is accepted, and the provider's version and groups follow its live hello", async () => {
	const hub = new AttachHub();
	const driver = new FakeUiDriver();
	const paired = pairedFor(driver);
	class Updated extends FakeUiDriver {
		hello() {
			return { ...super.hello(), version: "fake.2", groups: ["apps", "ui", "screen"] };
		}
	}
	const provider = attachedProvider(paired, hub);
	assert.equal(provider.version, "fake");
	const updated = await dial(hub, paired, new Updated());
	assert.equal(updated.accepted.ok, true);
	assert.equal(provider.version, "fake.2");
	assert.deepEqual(provider.capabilities().groups, ["apps", "ui", "screen"]);
	const connected = await provider.connect({ id: paired.id, name: paired.name });
	assert.equal(connected.value.hello.version, provider.version, "the drift check's two versions agree");
});

test("one run holds an attached computer; offline refuses create; release never stops it; revoke closes it", async () => {
	const driver = new FakeUiDriver();
	const hub = new AttachHub();
	const paired = pairedFor(driver);
	const provider = attachedProvider(paired, hub);
	const spec = { image: "attached", lifetimeMs: 60_000, network: "open", labels: { run: "a" } };
	const offline = await provider.create(spec);
	assert.equal(offline.error.code, "gone");
	assert.match(offline.error.message, /is not attached now/);
	const { serve } = await dial(hub, paired, driver);
	assert.equal((await provider.create(spec)).ok, true);
	const second = await provider.create({ ...spec, labels: { run: "b" } });
	assert.equal(second.error.code, "refused");
	assert.deepEqual((await provider.list({ run: "a" })).value.map((one) => one.ref.id), [paired.id]);
	assert.deepEqual((await provider.list({ run: "b" })).value, []);
	assert.equal((await provider.release({ id: paired.id, name: paired.name }, "stop")).error.code, "unsupported");
	assert.equal((await provider.release({ id: paired.id, name: paired.name }, "delete")).ok, true);
	assert.equal((await provider.create({ ...spec, labels: { run: "b" } })).ok, true, "released, another run may hold it");
	hub.revoke(paired.id, "the owner removed this computer");
	assert.equal(serve.closed.code, ATTACH_CLOSE.unauthorized);
	assert.equal(redials(ATTACH_CLOSE.unauthorized), false);
	assert.equal(hub.claimed(paired.id), undefined);
	driver.close();
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
