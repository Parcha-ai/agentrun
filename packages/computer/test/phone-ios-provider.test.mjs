// The phone kind's provider on the phone harness's cloud iPhone (machine ios): the shared session and ledger layer of
// src/phone-harness.ts, and the control client of src/phone-control.ts, which answers the protocol over the iPhone's
// HTTPS ops. Against the fakes test/fake-phone-harness.mjs and test/fake-iphone.mjs: no port, no wall-clock wait.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { kindRefusals, PROVIDERS } from "../dist/index.js";
import { IOS_HOME, IOS_ITEMS, IOS_OPS, IOS_SCALE, IOS_SCREEN, IOS_SETTINGS } from "./fake-iphone.mjs";
import { fakePhoneHarness, IPHONE_ID, KEY } from "./fake-phone-harness.mjs";

const phone = await import("../dist/phone-harness.js");
const { create, memoryLedger, CAPABILITIES, PHONE_GROUPS, IOS_GROUPS } = phone;
const { controlClient, CONTROL_OPS, frameMap } = await import("../dist/phone-control.js");
const conformance = await import("../dist/conformance/phone-harness.js");

const dir = mkdtempSync(join(tmpdir(), "computer-ios-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const SPEC = { image: "ios", lifetimeMs: 10 * 60_000, network: "open" };

/** An iPhone provider over a fresh fake whose account holds one iPhone, with its ledger. */
async function setup(fakeOptions = {}, options = {}) {
	const fake = fakePhoneHarness({ iphones: [IPHONE_ID], ...fakeOptions });
	const ledger = options.ledger ?? memoryLedger();
	const provider = await create({ apiKey: KEY, platform: "ios", fetch: fake.fetch, ledger, now: fake.clock.now, sleep: fake.clock.sleep, ...options });
	return { fake, provider, ledger };
}

/** An iPhone made and connected: its fake session, and the connection. */
async function connected(fakeOptions = {}, options = {}) {
	const made = await setup(fakeOptions, options);
	const ref = (await made.provider.create(SPEC)).value;
	assert.ok(ref, "create");
	const connection = await made.provider.connect(ref);
	assert.equal(connection.ok, true, JSON.stringify(connection));
	return { ...made, ref, connection: connection.value, client: connection.value.client, session: made.fake.sessions.get(ref.id) };
}

async function shot(client, params = {}) {
	const first = await client.call("screen.shot", params);
	assert.equal(first.ok, true, JSON.stringify(first));
	const parts = [Buffer.from(first.value.data, "base64")];
	let eof = first.value.eof;
	while (!eof) {
		const more = await client.call("screen.read", { id: first.value.id, offset: Buffer.concat(parts).length });
		assert.equal(more.ok, true, JSON.stringify(more));
		parts.push(Buffer.from(more.value.data, "base64"));
		eof = more.value.eof;
	}
	const bytes = Buffer.concat(parts);
	assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "a PNG signature");
	return { ...first.value, bytes, png: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } };
}

/** Whether a secret appears anywhere in value. */
const holds = (value, secret) => JSON.stringify(value).includes(secret);

test("create(options) with platform ios builds an iPhone: machine ios, its groups, no daemon; Android's and iOS's configurations are both declared", async () => {
	const { provider } = await setup();
	const caps = provider.capabilities();
	assert.deepEqual(
		{ kind: caps.kind, os: caps.os, daemon: caps.daemon, lifetime: caps.lifetime, network: caps.network, release: caps.release, groups: caps.groups, isolation: caps.isolation },
		{ kind: "ios", os: "ios", daemon: "none", lifetime: "vendor", network: ["open"], release: ["delete"], groups: IOS_GROUPS, isolation: "vm" },
	);
	assert.deepEqual(IOS_GROUPS, ["screen", "input.touch", "apps"], "input.keys, apps.terminate and apps.ui_tree wait for a live run");
	assert.deepEqual(PHONE_GROUPS, ["screen", "input.touch", "input.keys", "apps", "apps.terminate", "apps.ui_tree"]);
	assert.deepEqual(CAPABILITIES, [
		{ kind: "android", groups: [...PHONE_GROUPS] },
		{ kind: "ios", groups: [...IOS_GROUPS] },
	]);
	assert.deepEqual(PROVIDERS.find((p) => p.id === "phone-harness").capabilities, CAPABILITIES, "the registry's entry holds the module's configurations");
	assert.equal(caps.maxComputers, 1, "one session at a time holds an iPhone: the provider holds one computer at once");
	assert.deepEqual(kindRefusals(caps), []);
	await assert.rejects(create({ apiKey: KEY, deviceId: IPHONE_ID }), /^Error: deviceId names one of the account's iPhones: give it with platform "ios"$/);
	await assert.rejects(create({ apiKey: KEY, platform: "ios", deviceId: "iph 1; rm" }), /^Error: deviceId "iph 1; rm" is not a phone id/);
	assert.match(provider.check({ ...SPEC, user: "0" }).find((r) => r.field === "user").message, /a cloud iPhone has no user to choose/);
});

test("create starts the account's iPhone for the lifetime: platform ios, kind device and its device_id; attach, list and release read it back", async () => {
	const { fake, provider, ledger } = await setup({}, { deviceId: IPHONE_ID });
	const made = await provider.create({ ...SPEC, labels: { run: "r1" } });
	assert.equal(made.ok, true, JSON.stringify(made));
	const post = fake.requests().find((r) => r.method === "POST" && r.path === "/sessions");
	assert.deepEqual(post.body, { platform: "ios", kind: "device", device_id: IPHONE_ID, timeout_seconds: 600 });
	assert.match(post.headers["idempotency-key"], /^[0-9a-f]{32}$/);
	const entry = await ledger.get(made.value.id);
	assert.equal(entry.platform, "ios", "an iPhone's ledger entry names its platform");
	assert.deepEqual(entry.labels, { run: "r1" });
	const attached = await provider.attach({ labels: { run: "r1" } });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual({ ...attached.value.spec, deadline: undefined }, { image: "ios", user: "501:501", network: "open", kind: "ios", deadline: undefined });
	assert.deepEqual((await provider.list({ run: "r1" })).value.map((info) => info.ref.id), [made.value.id]);
	assert.equal((await provider.release(made.value, "delete")).ok, true);
	assert.equal(fake.sessions.size, 0, "the session is ended");
	assert.deepEqual((await provider.list({})).value, []);
	// With no deviceId the body names none, as the docs allow while the account holds one iPhone.
	const plain = await setup();
	const again = await plain.provider.create(SPEC);
	assert.equal(again.ok, true, JSON.stringify(again));
	assert.deepEqual(plain.fake.requests().find((r) => r.method === "POST" && r.path === "/sessions").body, { platform: "ios", kind: "device", timeout_seconds: 600 });
	await plain.provider.release(again.value, "delete");
});

test("the vendor's iPhone refusals are results in words with a code: no iPhone on the account, one another session holds (limit), and never the key", async () => {
	const none = await setup({ iphones: [] });
	const refused = await none.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "phone");
	assert.match(refused.error.message, /no phone of that platform and kind is available to this account \(400\)/);
	assert.ok(!holds(refused, KEY));

	const { provider } = await setup();
	const first = await provider.create(SPEC);
	assert.equal(first.ok, true);
	const second = await provider.create(SPEC);
	assert.equal(second.ok, false);
	assert.equal(second.error.code, "limit");
	assert.match(second.error.message, /that phone is running in another session \(profile_running\)/);
	assert.deepEqual((await provider.list({})).value.map((info) => info.ref.id), [first.value.id], "the refused create left no ledger entry");
	await provider.release(first.value, "delete");
});

test("one ledger, two platforms: an Android provider never lists, attaches, connects or releases an iPhone's entry, and the reverse; an entry with no platform is Android's", async () => {
	const ledger = memoryLedger();
	const fake = fakePhoneHarness({ iphones: [IPHONE_ID] });
	const base = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger, now: fake.clock.now, sleep: fake.clock.sleep };
	const android = await create(base);
	const ios = await create({ ...base, platform: "ios" });
	const a = (await android.create({ image: "android", lifetimeMs: 600_000, network: "open", labels: { who: "a" } })).value;
	const i = (await ios.create({ ...SPEC, labels: { who: "i" } })).value;
	assert.equal((await ledger.get(a.id)).platform, undefined, "an Android entry is written as before, with no platform");
	assert.equal((await ledger.get(i.id)).platform, "ios");

	assert.deepEqual((await android.list({})).value.map((info) => info.ref.id), [a.id]);
	assert.deepEqual((await ios.list({})).value.map((info) => info.ref.id), [i.id]);
	for (const [provider, other] of [
		[android, i],
		[ios, a],
	]) {
		assert.equal((await provider.attach({ id: other.id })).error.code, "not_found");
		assert.equal((await provider.connect(other)).error.code, "not_found");
		assert.equal((await provider.network(other)).error.code, "not_found");
		const deletes = fake.requests().filter((r) => r.method === "DELETE").length;
		const released = await provider.release(other, "delete");
		assert.equal(released.error.code, "not_found", `${provider.capabilities().kind} refuses the other platform's phone`);
		assert.equal(fake.requests().filter((r) => r.method === "DELETE").length, deletes, "and sends it no DELETE");
		assert.ok(await ledger.get(other.id), "and leaves its ledger entry");
	}
	assert.equal((await android.attach({ labels: { who: "i" } })).error.code, "not_found");
	assert.equal((await ios.attach({ labels: { who: "a" } })).error.code, "not_found");
	assert.equal((await android.release(a, "delete")).ok, true);
	assert.equal((await ios.release(i, "delete")).ok, true);
	assert.deepEqual(await ledger.list(), []);
});

test("an iPhone create whose answer was lost is found by its key only by the iPhone provider: an Android list never adopts the pending entry", async () => {
	const ledger = memoryLedger();
	const fake = fakePhoneHarness({ iphones: [IPHONE_ID], loseAnswer: true, loseRecovery: true });
	const base = { apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger, now: fake.clock.now, sleep: fake.clock.sleep };
	const ios = await create({ ...base, platform: "ios" });
	const android = await create(base);
	const lost = await ios.create({ ...SPEC, labels: { who: "i" } });
	assert.equal(lost.ok, false);
	const [pending] = await ledger.list();
	assert.match(pending.id, /^pending-/);
	assert.equal(pending.platform, "ios");
	assert.deepEqual((await android.list({})).value, []);
	assert.match((await ledger.list())[0].id, /^pending-/, "the Android list left the iPhone's pending entry as it was");
	const found = (await ios.list({})).value;
	assert.equal(found.length, 1);
	assert.equal((await ledger.get(found[0].ref.id)).platform, "ios", "the adopted entry keeps its platform");
	assert.equal((await ios.release(found[0].ref, "delete")).ok, true);
});

test("connect drives the iPhone through its control grant: GET /ops, a hello for machine ios; the token goes only in the Authorization header to the API's own origin", async () => {
	const { fake, provider, ref, connection, session } = await connected();
	assert.deepEqual(connection.hello, { version: provider.version, os: "ios", kind: "ios", arch: "arm64", groups: IOS_GROUPS });
	const token = session.control.token;
	const toControl = fake.requests().filter((r) => r.path.startsWith("/iphone/c/"));
	assert.deepEqual(toControl.map((r) => `${r.method} ${r.path.replace(/^\/iphone\/c\/[^/]+/, "")}`), ["GET /ops"]);
	for (const r of toControl) {
		assert.equal(r.headers.authorization, `Bearer ${token}`);
		assert.equal(r.origin, "https://api.phone-harness.com");
	}
	for (const r of fake.requests().filter((one) => !one.path.startsWith("/iphone/c/"))) assert.equal(r.headers.authorization, `Bearer ${KEY}`, "the API key goes only to the API");
	assert.ok(!holds(connection.hello, token));
	await connection.close();
	await provider.release(ref, "delete");
});

test("a control URL on another origin is refused at connect, and its token is sent nowhere", async () => {
	const { fake, provider } = await setup({ controlOrigin: "https://elsewhere.example" });
	const ref = (await provider.create(SPEC)).value;
	const refused = await provider.connect(ref);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "phone");
	assert.match(refused.error.message, /a control URL on elsewhere\.example, not api\.phone-harness\.com: its token is sent only to the API's own host/);
	const token = fake.sessions.get(ref.id).control.token;
	assert.ok(!holds(refused, token));
	assert.ok(!holds(refused, fake.sessions.get(ref.id).control.grant), "nor the URL's path, which is the grant");
	assert.deepEqual(fake.requests().filter((r) => r.origin !== "https://api.phone-harness.com"), [], "nothing was sent to the other origin");
	await provider.release(ref, "delete");
});

test("connect refuses an iPhone whose /ops lacks an op a declared group needs, naming each one, so hello never claims a group it cannot serve", async () => {
	const { provider } = await setup({ iphone: { ops: IOS_OPS.filter((op) => op !== "apps.current" && op !== "input.drag") } });
	const ref = (await provider.create(SPEC)).value;
	const refused = await provider.connect(ref);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "unsupported");
	assert.equal(refused.error.message, "the iPhone's control API does not list input.drag (input.touch) and apps.current (apps), which the groups the provider declares for it need");
	assert.deepEqual(CONTROL_OPS, {
		screen: ["screen.capture"],
		"input.touch": ["input.tap", "input.press", "input.drag"],
		"input.keys": ["input.text", "input.keys"],
		apps: ["apps.launch", "apps.list", "apps.current"],
	});
	await provider.release(ref, "delete");
});

test("the token and the grant never reach a result or an error, whatever the vendor echoes; an ended grant is gone, an unsupported op unsupported", async () => {
	let echo = "";
	const { provider, ref, client, session, fake } = await connected({
		iphone: {
			fail: ({ op }) => {
				if (op === "nav.home") return new Response(JSON.stringify({ error: `RuntimeError: refused ${echo}` }), { status: 500, headers: { "content-type": "application/json" } });
				if (op === "nav.recents") return new Response(JSON.stringify({ error: "this phone cannot 'nav.recents'", unsupported: true }), { status: 400, headers: { "content-type": "application/json" } });
				return undefined;
			},
		},
	});
	const { token, grant } = session.control;
	echo = `token ${token} at https://api.phone-harness.com/iphone/c/${grant}/op`;
	const failed = (await client.call("input.actions", { actions: [{ type: "button", name: "home" }] })).value;
	assert.equal(failed.done, 0);
	assert.ok(!holds(failed, token), JSON.stringify(failed));
	assert.ok(!holds(failed, grant), JSON.stringify(failed));
	assert.match(failed.failed.message, /^action 0: nav\.home: RuntimeError: refused token \[the token\] at https:\/\/api\.phone-harness\.com\/\[the grant\]\/op \(500\)$/);
	const unsupported = (await client.call("input.actions", { actions: [{ type: "button", name: "app_switch" }] })).value;
	assert.deepEqual(unsupported.failed, { index: 0, kind: "unsupported", message: "action 0: nav.recents: this phone cannot 'nav.recents'" });
	// The session ends: its grant answers 404, and the client says the phone is gone.
	fake.iphone.grants.clear();
	const gone = await client.call("screen.shot", {});
	assert.equal(gone.ok, false);
	assert.equal(gone.error.code, "gone");
	assert.match(gone.error.message, /^screen\.capture: the iPhone's session has ended, or its control grant expired \(404\)/);
	await provider.release(ref, "delete");
});

test("the client answers the iPhone's groups through its ops: a screenshot, a region of it, a tap, a long press, a swipe and the buttons; the rest is refused in words", async () => {
	const { provider, ref, client, fake } = await connected();
	const ops = () => fake.iphone.ops();
	const whole = await shot(client);
	// The frame is the capture's own pixels (2x Retina on the fake), never downscaled; the points sent are mapped.
	const frame = { width: IOS_SCREEN.width * IOS_SCALE, height: IOS_SCREEN.height * IOS_SCALE };
	assert.deepEqual({ width: whole.width, height: whole.height, scale: whole.scale }, { ...frame, scale: IOS_SCALE });
	assert.deepEqual(whole.png, frame);
	assert.deepEqual(ops().at(-1), ["screen.capture", {}]);
	const part = await shot(client, { region: [10, 20, 30, 40] });
	assert.deepEqual({ width: part.width, height: part.height }, { width: 30, height: 40 });
	assert.deepEqual(part.png, { width: 30, height: 40 });
	assert.equal((await client.call("screen.shot", { region: [0, 0, frame.width + 1, 10] })).error.code, "invalid");

	const before = ops().length;
	const ran = await client.call("input.actions", {
		actions: [
			{ type: "tap", at: [100, 860], count: 2 },
			{ type: "long_press", at: [20, 20], ms: 1200 },
			{ type: "swipe", path: [[300, 1000], [300, 400]], ms: 400 },
			{ type: "button", name: "home" },
			{ type: "button", name: "app_switch" },
			{ type: "wait", ms: 50 },
		],
	});
	assert.deepEqual(ran.value, { done: 6 });
	assert.deepEqual(ops().slice(before), [
		["input.tap", { x: 50, y: 430 }],
		["input.tap", { x: 50, y: 430 }],
		["input.press", { x: 10, y: 10, duration: 1.2 }],
		["input.drag", { x1: 150, y1: 500, x2: 150, y2: 200, duration: 0.4 }],
		["nav.home", {}],
		["nav.recents", {}],
	]);
	const refusedAction = async (action) => (await client.call("input.actions", { actions: [action] })).value.failed;
	assert.deepEqual(await refusedAction({ type: "button", name: "back" }), { index: 0, kind: "unsupported", message: "action 0: button back: an iPhone has no system Back button, and its control API lists no nav.back" });
	assert.deepEqual(await refusedAction({ type: "swipe", path: [[1, 1], [2, 2], [3, 3]] }), { index: 0, kind: "unsupported", message: "action 0: swipe: the iPhone's control API drags along one straight line, so a path of 3 points is not offered" });
	assert.deepEqual(await refusedAction({ type: "pinch", at: [5, 5], scale: 2 }), { index: 0, kind: "unsupported", message: "action 0: pinch: the iPhone's control API takes one finger" });
	assert.equal((await refusedAction({ type: "tap", at: [frame.width, 5] })).kind, "invalid", "a point off the frame");
	// input.keys is not declared for an iPhone until a live run proves it: a key and typing are refused by the batch check.
	for (const action of [{ type: "key", keys: ["enter"] }, { type: "type", text: "wifi" }]) {
		const failed = await refusedAction(action);
		assert.equal(failed.kind, "unsupported", JSON.stringify(failed));
		assert.match(failed.message, /input\.keys/);
	}
	for (const [method, words] of [
		["exec.run", /an iPhone has no shell in the computer protocol/],
		["files.read", /an iPhone has no shell in the computer protocol/],
		["process.start", /an iPhone has no shell in the computer protocol/],
		["apps.install", /apps\.install: this iPhone takes no files to install from/],
		["apps.terminate", /^apps\.terminate: the iPhone's control API has no op that ends an app, so the provider does not declare apps\.terminate$/],
		["apps.ui_tree", /^apps\.ui_tree: not declared for an iPhone until a live run shows its control API's tree$/],
		["deadline.extend", /a cloud phone's session ends when the phone harness says/],
		["no.such.method", /no\.such\.method is not a method this iPhone answers/],
	]) {
		const refused = await client.call(method, {});
		assert.equal(refused.ok, false, method);
		assert.equal(refused.error.code, "unsupported", method);
		assert.match(refused.error.message, words, method);
	}
	await provider.release(ref, "delete");
});

test("a button back goes to nav.back when the iPhone lists it", async () => {
	const { provider, ref, client, fake } = await connected({ iphone: { back: true } });
	assert.deepEqual((await client.call("input.actions", { actions: [{ type: "button", name: "back" }] })).value, { done: 1 });
	assert.deepEqual(fake.iphone.ops().at(-1), ["nav.back", {}]);
	await provider.release(ref, "delete");
});

test("apps: the list with what is in front, a launch by the id given, an app that is not there not_found; a launch is seen on the screen", async () => {
	const { provider, ref, client, fake } = await connected();
	const listed = await client.call("apps.list", {});
	assert.deepEqual(listed.value, { apps: [IOS_SETTINGS, "com.apple.MobileSMS", "com.apple.mobilesafari", IOS_HOME].sort().map((id) => ({ id })), foreground: IOS_HOME });
	assert.deepEqual(fake.iphone.ops().slice(-2), [
		["apps.list", { include_system: true }],
		["apps.current", {}],
	]);
	const home = (await shot(client)).bytes;
	assert.deepEqual((await client.call("apps.launch", { id: IOS_SETTINGS })).value, {});
	// fresh, as Android's launch clears the task: the app itself comes to the front, not what a never-wiped phone left open.
	assert.deepEqual(fake.iphone.ops().at(-1), ["apps.launch", { name: IOS_SETTINGS, fresh: true }]);
	assert.equal((await client.call("apps.list", {})).value.foreground, IOS_SETTINGS);
	assert.notDeepEqual((await shot(client)).bytes, home, "Settings is on the screen");
	const missing = await client.call("apps.launch", { id: "ai.agentrun.no.such.app" });
	assert.equal(missing.error.code, "not_found");
	assert.match(missing.error.message, /no installed app matches 'ai\.agentrun\.no\.such\.app'/);
	for (const id of ["", 7, "a\nb", "x".repeat(300)]) assert.equal((await client.call("apps.launch", { id })).error.code, "invalid", JSON.stringify(id));
	// A swipe up Settings' list scrolls it, which the screen shows.
	const top = (await shot(client)).bytes;
	await client.call("input.actions", { actions: [{ type: "swipe", path: [[150, 500], [150, 200]], ms: 400 }] });
	assert.ok(fake.iphone.phone.offset > 0);
	assert.notDeepEqual((await shot(client)).bytes, top);
	assert.ok(IOS_ITEMS.length > 0);
	await provider.release(ref, "delete");
});

test("frameMap is the one place a frame's pixels become the points input.tap and input.drag take: Retina scale and the bounds' origin", () => {
	const retina = frameMap({ width: 600, height: 1200 }, { x: 0, y: 0, w: 300, h: 600 });
	assert.deepEqual({ width: retina.width, height: retina.height, scale: retina.scale }, { width: 600, height: 1200, scale: 2 });
	assert.deepEqual(retina.toDevice([300, 600]), { x: 150, y: 300 }, "the frame's middle is the screen's middle in points");
	assert.deepEqual(retina.toDevice([0, 0]), { x: 0, y: 0 });
	assert.deepEqual(retina.toDevice([599, 1199]), { x: 300, y: 600 });
	const offset = frameMap({ width: 900, height: 1800 }, { x: 10, y: 40, w: 300, h: 600 });
	assert.deepEqual({ scale: offset.scale, middle: offset.toDevice([450, 900]) }, { scale: 3, middle: { x: 160, y: 340 } });
	// No bounds the map can use: the frame's pixels are the points, as the protocol's own space.
	for (const bounds of [undefined, null, {}, { x: 0, y: 0, w: 0, h: 600 }, { x: "1", y: 0, w: 300, h: 600 }]) {
		const plain = frameMap({ width: 600, height: 1200 }, bounds);
		assert.deepEqual({ scale: plain.scale, middle: plain.toDevice([300, 600]) }, { scale: 1, middle: { x: 300, y: 600 } }, JSON.stringify(bounds));
	}
});

test("a tap at the frame's middle lands at the screen's middle in points, on a 2x Retina capture and past a bounds origin, before any screenshot too", async () => {
	for (const origin of [{ x: 0, y: 0 }, { x: 10, y: 40 }]) {
		const { provider, ref, client, fake } = await connected({ iphone: { origin } });
		await client.call("apps.launch", { id: IOS_SETTINGS });
		// No screen.shot yet: the client captures once to learn the frame's space before it sends a point.
		const middle = [(IOS_SCREEN.width * IOS_SCALE) / 2, (IOS_SCREEN.height * IOS_SCALE) / 2];
		assert.deepEqual((await client.call("input.actions", { actions: [{ type: "tap", at: middle }] })).value, { done: 1 });
		assert.deepEqual(fake.iphone.phone.taps, [[IOS_SCREEN.width / 2 + origin.x, IOS_SCREEN.height / 2 + origin.y]]);
		// The row under the screen's middle opened: 120 px of header, rows of 50, so the fourth.
		assert.equal(fake.iphone.phone.page, IOS_ITEMS[3], JSON.stringify(origin));
		await provider.release(ref, "delete");
	}
});

test("an iPhone list adopts a pending entry only for a session of its own platform", async () => {
	let relabel = false;
	const fake = fakePhoneHarness({ iphones: [IPHONE_ID], loseAnswer: true, loseRecovery: true, onList: (snapshot) => (relabel ? snapshot.map((s) => ({ ...s, platform: "android" })) : snapshot) });
	const ledger = memoryLedger();
	const ios = await create({ apiKey: KEY, platform: "ios", fetch: fake.fetch, ledger, now: fake.clock.now, sleep: fake.clock.sleep });
	assert.equal((await ios.create(SPEC)).ok, false);
	relabel = true;
	assert.deepEqual((await ios.list({})).value, [], "a session the listing names android is not the iPhone's");
	assert.match((await ledger.list())[0].id, /^pending-/, "and the pending entry is kept");
	relabel = false;
	const found = (await ios.list({})).value;
	assert.equal(found.length, 1);
	assert.equal((await ios.release(found[0].ref, "delete")).ok, true);
});

test("the iPhone takes one op at a time: calls made together are sent in turn", async () => {
	const { provider, ref, client, fake } = await connected();
	await Promise.all([client.call("screen.shot", {}), client.call("apps.list", {}), client.call("input.actions", { actions: [{ type: "tap", at: [1, 1] }] }), client.call("screen.shot", {})]);
	assert.equal(fake.iphone.mostAtOnce(), 1);
	await provider.release(ref, "delete");
});

test("the key mapping, behind input.keys that an iPhone does not declare yet: our key table in the vendor's names, combos as modifiers and a key, typing as input.text", async () => {
	const { provider, ref, session, fake } = await connected();
	const client = controlClient({ url: `https://api.phone-harness.com/iphone/c/${session.control.grant}`, token: session.control.token, groups: [...IOS_GROUPS, "input.keys"], fetch: fake.fetch, sleep: fake.clock.sleep });
	assert.equal((await client.open("0.0.0")).value.groups.includes("input.keys"), true);
	const before = fake.iphone.ops().length;
	const ran = await client.call("input.actions", {
		actions: [
			{ type: "key", keys: ["enter"] },
			{ type: "key", keys: ["backspace"], repeat: 2 },
			{ type: "key", keys: ["super", "a"] },
			{ type: "key", keys: ["shift", "alt", "tab"] },
			{ type: "key", keys: ["escape"] },
			{ type: "key", keys: ["up"] },
			{ type: "key", keys: ["7"] },
			{ type: "key", keys: ["A"] },
			{ type: "type", text: "wifi ünïcode" },
		],
	});
	assert.deepEqual(ran.value, { done: 9 });
	assert.deepEqual(fake.iphone.ops().slice(before), [
		["input.keys", { combo: "return" }],
		["input.keys", { combo: "delete" }],
		["input.keys", { combo: "delete" }],
		["input.keys", { combo: "cmd+a" }],
		["input.keys", { combo: "shift+alt+tab" }],
		["input.keys", { combo: "escape" }],
		["input.keys", { combo: "up" }],
		["input.keys", { combo: "7" }],
		["input.text", { s: "A", keystrokes: true }],
		["input.text", { s: "wifi ünïcode" }],
	]);
	const refused = async (keys) => (await client.call("input.actions", { actions: [{ type: "key", keys }] })).value.failed;
	for (const key of ["home", "end", "delete", "insert", "pageup", "pagedown", "f1", "capslock"]) {
		assert.deepEqual(await refused([key]), { index: 0, kind: "unsupported", message: `action 0: key ${JSON.stringify(key)}: the iPhone's control API names no such key` });
	}
	assert.deepEqual(await refused(["a", "shift"]), { index: 0, kind: "unsupported", message: 'action 0: key ["a","shift"]: a combo on an iPhone is modifiers and then one key' });
	assert.deepEqual(await refused(["ctrl", "A"]), { index: 0, kind: "unsupported", message: 'action 0: key ["ctrl","A"]: the iPhone\'s control API names no such key as "A" in a combo' });
	assert.equal((await client.call("input.actions", { actions: [{ type: "hold", keys: ["shift"], ms: 10 }] })).value.failed.kind, "unsupported");
	client.close();
	await provider.release(ref, "delete");
});

test("the conformance module reads COMPUTER_PHONE_HARNESS_DEVICE beside the platform, and names an iPhone run's image ios", async () => {
	assert.equal(conformance.PHONE_ENV.device, "COMPUTER_PHONE_HARNESS_DEVICE");
	assert.deepEqual(conformance.settingsFromEnv({ COMPUTER_PHONE_HARNESS_API_KEY: KEY, COMPUTER_PHONE_HARNESS_PLATFORM: "ios", COMPUTER_PHONE_HARNESS_DEVICE: IPHONE_ID }), { apiKey: KEY, platform: "ios", deviceId: IPHONE_ID });
	const fake = fakePhoneHarness({ iphones: [IPHONE_ID] });
	const env = { COMPUTER_PHONE_HARNESS_API_KEY: KEY, AGENTRUN_COMPUTER_LIVE_PHONE_HARNESS: "1", COMPUTER_PHONE_HARNESS_PLATFORM: "ios", COMPUTER_PHONE_HARNESS_DEVICE: IPHONE_ID, COMPUTER_PHONE_HARNESS_LEDGER: join(dir, "ledger.json") };
	const built = await conformance.createProvider({ env, fetch: fake.fetch, now: fake.clock.now, sleep: fake.clock.sleep });
	assert.equal(built.capabilities().kind, "ios");
	const made = await built.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	assert.equal(fake.requests().find((r) => r.method === "POST" && r.path === "/sessions").body.device_id, IPHONE_ID);
	await built.release(made.value, "delete");
	assert.equal(await conformance.conformanceImage({ env }), "ios");
	assert.equal(await conformance.conformanceImage({ env: {} }), "android");
});
