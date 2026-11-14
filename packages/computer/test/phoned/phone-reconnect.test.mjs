// One phone, one accessibility connection, across the phone harness's connections: phoned's real core (FakeMain) on a
// phone where every phoned shares the one UiAutomation registration (FakeMain's phone directory), as Android's
// UiAutomationManager keeps it. Run by `npm run test:phoned`, which builds FakeMain first.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakePhoneHarness, KEY, PHONED_JAR } from "../fake-phone-harness.mjs";
import { startFakeMain } from "./fake-main.mjs";

const { create, memoryLedger } = await import("../../dist/phone-harness.js");

/** The wall clock, every provider wait cut to a few milliseconds: FakeMain keeps real time. */
const clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) };
const SPEC = { image: "android", lifetimeMs: 10 * 60_000, network: "open" };
let requests = 0;

/**
 * A provider over the fake phone harness whose phoned is FakeMain, each holding the phone's registration exitMs after
 * its stdin closes. held: at each phoned's start, whether another held the registration then.
 */
async function setup({ exitMs = 0 } = {}) {
	const phoneDir = mkdtempSync(join(tmpdir(), "phoned-phone-"));
	const holder = join(phoneDir, "uiautomation");
	const held = [];
	const fake = fakePhoneHarness({
		clock,
		startPhoned: () => {
			held.push(existsSync(holder));
			const main = startFakeMain({ phone: phoneDir, exitMs });
			// A killed phoned's registration goes as the system drops it when the process dies.
			const kill = () => {
				main.child.kill("SIGKILL");
				main.exited.then(() => {
					if (existsSync(holder) && readFileSync(holder, "utf8") === String(main.child.pid)) rmSync(holder);
				});
			};
			return { stream: main.stream, pid: main.child.pid, exited: main.exited, kill };
		},
	});
	const provider = await create({ apiKey: KEY, fetch: fake.fetch, adb: fake.adb, ledger: memoryLedger(), now: clock.now, sleep: clock.sleep, maxLifetimeMs: 10 * 60_000, phoned: PHONED_JAR });
	const ref = (await provider.create(SPEC, { requestId: `phone-reconnect-${++requests}` })).value;
	const connections = [];
	/** A connection to the phone, closed by done() if the test has not closed it. */
	const connect = async () => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connections.push(connected.value);
		return connected.value;
	};
	const done = async () => {
		for (const connection of connections) await connection.close();
		await provider.release(ref);
		await Promise.all(fake.phone.phoned.map((started) => started.exited));
		rmSync(phoneDir, { recursive: true, force: true });
	};
	return { fake, connect, holder, held, done };
}

test("a phoned slow to let go of the phone's accessibility after its connection closes: the next connection's phoned starts once it is gone, and its first ui call connects", { timeout: 60_000 }, async () => {
	const { fake, connect, holder, held, done } = await setup({ exitMs: 1500 });
	try {
		const first = await connect();
		const seen = await first.client.call("ui.observe", {});
		assert.equal(seen.ok, true, JSON.stringify(seen));
		assert.ok(existsSync(holder), "the first phoned holds the phone's registration");
		await first.close();
		assert.ok(existsSync(holder), "and still holds it once its connection closed: it lets go only as it exits");

		const second = await connect();
		const again = await second.client.call("ui.observe", {});
		assert.equal(again.ok, true, `the next connection's first ui call: ${JSON.stringify(again)}`);
		assert.deepEqual(held, [false, false], "no phoned started while another held the registration");
		assert.equal(fake.phone.phoned[0].gone, true, "the first phoned had exited");
		assert.deepEqual(fake.phone.killed, [], "on its own, within its bound: nothing was killed");
	} finally {
		await done();
	}
});

test("another holder of the phone's accessibility that never lets go: connect still serves, and the first ui call is unsupported in words", { timeout: 60_000 }, async () => {
	const { connect, holder, done } = await setup();
	try {
		// A `uiautomator dump`, an instrumentation test or Appium, which this provider never started and never waits for.
		writeFileSync(holder, "1");
		const connected = await connect();
		const seen = await connected.client.call("ui.observe", {});
		assert.equal(seen.ok, false);
		assert.equal(seen.error.code, "unsupported");
		assert.match(seen.error.message, /^another UiAutomation client holds the phone's accessibility \(a `uiautomator dump`, an instrumentation test, Appium or another phoned\): only one may connect at a time; stop it and try again$/);
		const apps = await connected.client.call("apps.list", {});
		assert.equal(apps.ok, true, "what needs no accessibility still answers");
		await connected.close();
		const again = await connect();
		assert.equal((await again.client.call("ui.observe", {})).error?.code, "unsupported", "and the next connection's phoned is refused the same way");
		await again.close();
		assert.equal(readFileSync(holder, "utf8"), "1", "and the other holder's registration is left alone");
	} finally {
		await done();
	}
});
