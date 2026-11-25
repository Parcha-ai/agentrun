// The TTI mode of the conformance runner (src/conformance/tti.ts): time from create to the first command that succeeds,
// one computer at a time and a burst all at once, scored as ComputeSDK's sandbox board scores it. Against the fake
// provider (test/fake-computer.mjs) and a clock the test moves: no vendor, no wall clock.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatTti, measureTti, ttiScore, ttiStats } from "../dist/index.js";
import { main } from "../dist/conformance/cli.js";
import { fakeComputers } from "./fake-computer.mjs";

const IMAGE = "debian:bookworm-slim";
const HERE = fileURLToPath(new URL(".", import.meta.url));

/** A clock that moves only when the test moves it. */
const fakeClock = () => {
	const clock = { time: 1_000_000, now: () => clock.time, sleep: async () => {} };
	return clock;
};

/** The fake provider with each create taking the next of delays on the clock, and refusing the creates refuse names (1-based). */
function timed({ delays = [], refuse = [], ...options } = {}) {
	const fake = fakeComputers(options);
	const clock = fakeClock();
	const create = fake.provider.create.bind(fake.provider);
	let calls = 0;
	fake.provider.create = async (spec, context) => {
		calls += 1;
		clock.time += delays[calls - 1] ?? 0;
		if (refuse.includes(calls)) return { ok: false, error: { code: "limit", message: "the plan keeps fewer computers" } };
		return create(spec, context);
	};
	return { ...fake, clock };
}

const sink = () => {
	let text = "";
	return {
		write: (chunk, done) => {
			text += chunk;
			done?.();
			return true;
		},
		text: () => text,
	};
};

test("ttiStats is ComputeSDK's: 5% trimmed from each end, the median of what is left, p95 and p99 by nearest rank", () => {
	const values = Array.from({ length: 100 }, (_, i) => 100 - i);
	// 1..100 trimmed to 6..95: the median is (50 + 51) / 2, p95 the 86th of 90, p99 the 90th.
	assert.deepEqual(ttiStats(values), { median: 50.5, p95: 91, p99: 95 });
	assert.deepEqual(ttiStats([300, 100, 200]), { median: 200, p95: 300, p99: 300 }, "too few to trim");
	assert.deepEqual(ttiStats([]), { median: 0, p95: 0, p99: 0 });
});

test("ttiScore is ComputeSDK's: each of median, p95 and p99 against a 10 s ceiling, weighted 0.6, 0.25, 0.15, times the success rate", () => {
	const stats = { median: 500, p95: 1000, p99: 2000 };
	assert.equal(ttiScore(stats, 1), 91.5);
	assert.equal(ttiScore(stats, 0.5), 45.75);
	assert.equal(ttiScore({ median: 12_000, p95: 20_000, p99: 30_000 }, 1), 0, "past the ceiling scores 0");
	assert.equal(ttiScore(stats, 0), 0);
});

test("one at a time: each computer's TTI is from its create's call to its first command, read on the run's clock, and each is deleted before the next", async () => {
	const fake = timed({ delays: [400, 600, 500] });
	const report = await measureTti(fake.provider, { image: IMAGE, iterations: 3, burst: 0, clock: fake.clock });
	assert.equal(report.provider, "fake");
	assert.equal(report.cameUp, true);
	assert.deepEqual(report.serial.ttiMs, [400, 600, 500]);
	assert.equal(report.serial.n, 3);
	assert.equal(report.serial.ok, 3);
	assert.equal(report.serial.successRate, 1);
	assert.deepEqual(report.serial.stats, { median: 500, p95: 600, p99: 600 });
	assert.equal(report.serial.score, ttiScore({ median: 500, p95: 600, p99: 600 }, 1));
	assert.equal(report.burst, undefined);
	assert.deepEqual(fake.alive(), []);
	assert.deepEqual(report.cleanup.left, []);
	assert.deepEqual(report.cleanup.errors, []);
	assert.equal(report.cleanup.deleted.length, 3);
	assert.equal(report.computers.peak, 1, "one computer at a time");
	assert.equal(report.pass, true);
});

test("a burst makes every computer at once; one that does not come up counts against the success rate in its own words, and all are deleted", async () => {
	const fake = timed({ refuse: [2] });
	const report = await measureTti(fake.provider, { image: IMAGE, iterations: 0, burst: 4, clock: fake.clock });
	assert.equal(report.serial, undefined);
	assert.equal(report.burst.n, 4);
	assert.equal(report.burst.ok, 3);
	assert.equal(report.burst.successRate, 0.75);
	assert.equal(report.burst.ttiMs.length, 3);
	assert.deepEqual(report.burst.errors, [{ words: "create failed (limit): the plan keeps fewer computers", count: 1 }]);
	assert.equal(report.computers.peak, 4, "all four at once");
	assert.deepEqual(fake.alive(), []);
	assert.deepEqual(report.cleanup.left, []);
	assert.equal(report.cameUp, true);
	assert.equal(report.pass, false, "a computer that did not come up fails the run");
});

test("a burst's creates are all in flight together, where the serial shape's are one at a time", async () => {
	// Each create stays open for a turn of the event loop: a burst that awaited each computer in turn would show one.
	const fake = fakeComputers();
	const create = fake.provider.create.bind(fake.provider);
	let open = 0;
	let most = 0;
	fake.provider.create = async (spec, context) => {
		open += 1;
		most = Math.max(most, open);
		await new Promise((resolve) => setImmediate(resolve));
		open -= 1;
		return create(spec, context);
	};
	const burst = await measureTti(fake.provider, { image: IMAGE, iterations: 0, burst: 4, clock: fakeClock() });
	assert.equal(burst.burst.ok, 4);
	assert.equal(most, 4, "all four creates were asked before any answered");
	most = 0;
	const serial = await measureTti(fake.provider, { image: IMAGE, iterations: 3, burst: 0, clock: fakeClock() });
	assert.equal(serial.serial.ok, 3);
	assert.equal(most, 1);
});

test("a provider that makes no computer did not come up, and says why in create's words", async () => {
	const fake = timed({ failCreate: "no capacity in this region" });
	const report = await measureTti(fake.provider, { image: IMAGE, iterations: 2, burst: 2, clock: fake.clock });
	assert.equal(report.cameUp, false);
	assert.equal(report.why, "create was refused: no capacity in this region");
	assert.equal(report.serial.ok, 0);
	assert.equal(report.serial.score, 0);
	assert.deepEqual(report.serial.errors, [{ words: "create was refused: no capacity in this region", count: 2 }]);
	assert.equal(report.burst.ok, 0);
	assert.equal(report.pass, false);
	const text = formatTti(report);
	assert.match(text, /^came up: no: create was refused: no capacity in this region$/m);
});

test("a provider that declares no exec is not measured: TTI is the first command's, and it makes no computer", async () => {
	const fake = timed({ groups: ["files"] });
	const report = await measureTti(fake.provider, { image: IMAGE, iterations: 2, burst: 2, clock: fake.clock });
	assert.equal(report.cameUp, false);
	assert.match(report.why, /^the provider declares no exec/);
	assert.deepEqual(fake.made, []);
	assert.equal(report.pass, false);
});

test("the text report: came up, one line per shape with n, the success rate, median, p95, p99 and score, the errors, and the cleanup", async () => {
	const fake = timed({ delays: [400, 600, 500, 0, 0], refuse: [5] });
	const report = await measureTti(fake.provider, { image: IMAGE, iterations: 3, burst: 2, clock: fake.clock });
	const lines = formatTti(report).trimEnd().split("\n");
	assert.equal(lines[0], `computer tti · fake · linux, daemon pid1 · image ${IMAGE}`);
	assert.equal(lines[1], "came up: yes");
	assert.equal(lines[2], `serial n 3 · ok 3/3 (100%) · median 500 ms · p95 600 ms · p99 600 ms · score ${ttiScore({ median: 500, p95: 600, p99: 600 }, 1)}`);
	assert.match(lines[3], /^burst {2}n 2 at once · ok 1\/2 \(50%\) · median \d+ ms · p95 \d+ ms · p99 \d+ ms · score [\d.]+$/);
	assert.equal(lines[4], "  ✗ 1x create failed (limit): the plan keeps fewer computers");
	assert.equal(lines[5], "cleanup ✓ 0 left · 4 deleted");
	assert.equal(lines[6], "computers alive at once: 2 at most");
	assert.equal(lines.at(-1), "tti FAIL: 1 of 5 computers did not come up");
});

test("the CLI's --tti and --burst run the TTI mode through the provider module, print it, and exit 0 only when every computer came up", async () => {
	const clock = fakeClock();
	const out = sink();
	const code = await main(["--provider", "./fixtures/fake-provider.mjs", "--tti", "2", "--burst", "3"], { stdout: out, cwd: HERE, clock });
	assert.equal(code, 0, out.text());
	assert.match(out.text(), /^computer tti · fake-module · linux, daemon pid1 · image debian:bookworm-slim$/m);
	assert.match(out.text(), /^serial n 2 · ok 2\/2 \(100%\) · median 0 ms/m);
	assert.match(out.text(), /^burst {2}n 3 at once · ok 3\/3 \(100%\)/m);
	assert.match(out.text(), /^tti PASS: 5 of 5 computers came up$/m);
	const json = sink();
	assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", "--burst=2", "--json"], { stdout: json, cwd: HERE, clock }), 0);
	const report = JSON.parse(json.text());
	assert.equal(report.burst.n, 2);
	assert.equal(report.serial, undefined);
	assert.equal(report.pass, true);
	const broken = sink();
	assert.equal(await main(["--provider", "./fixtures/broken-provider.mjs", "--tti", "1"], { stdout: broken, cwd: HERE, clock }), 1);
	assert.match(broken.text(), /^came up: no: create was refused: no capacity in this region$/m);
});

test("a TTI run under --run (the live sweep's --before id) labels every computer it makes with that id, so --after finds them", async () => {
	const { made } = await import(new URL("./fixtures/labels-provider.mjs", import.meta.url).href);
	const out = sink();
	const code = await main(["--provider", "./fixtures/labels-provider.mjs", "--tti", "2", "--burst", "2", "--run", "0123456789ab"], { stdout: out, cwd: HERE, clock: fakeClock() });
	assert.equal(code, 0, out.text());
	assert.equal(made.length, 4, "two serial computers and two at once");
	for (const { labels } of made) assert.equal(labels["agentrun.conformance"], "0123456789ab");
});

test("the CLI refuses --tti and --burst with a flag of the suite's, or a count that is not a whole number of 1 or more", async () => {
	for (const [argv, words] of [
		[["--tti", "0"], /--tti: "0" is not a whole number of computers, 1 or more/],
		[["--burst", "x"], /--burst: "x" is not a whole number of computers, 1 or more/],
		[["--tti", "3", "--only", "exec"], /--tti and --burst measure time to the first command alone: drop --only/],
		[["--burst", "3", "--concurrency", "2"], /drop --concurrency/],
		[["--tti", "3", "--exec-stream", "--machine", "m"], /--exec-stream runs alone: drop --tti/],
	]) {
		const err = sink();
		assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", ...argv], { stdout: sink(), stderr: err, cwd: HERE }), 2, argv.join(" "));
		assert.match(err.text(), words, argv.join(" "));
	}
});
