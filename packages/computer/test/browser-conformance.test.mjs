// The browser case set, run through the conformance CLI as `--provider browserbase` and `--provider kernel` are, against
// the fake vendors and a fake CDP browser (test/fake-browser.mjs): no key, no network, no wall-clock wait. Each passes
// Core with one browser for the whole run and leaves nothing behind; a browser that drifts from what a case checks
// fails that case in words, and no report carries a signed URL.
import assert from "node:assert/strict";
import test from "node:test";
import { browserCases, formatReport, kindCases, runConformance } from "../dist/index.js";
import { main } from "../dist/conformance/cli.js";
import { BROWSERBASE_KEY, BROWSERBASE_URL, fakeBrowserbase, fakeKernel, KERNEL_KEY, KERNEL_URL } from "./fake-browser.mjs";

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

const VENDORS = {
	browserbase: {
		fake: fakeBrowserbase,
		async make(fake) {
			const { BrowserbaseProvider } = await import("../dist/browserbase.js");
			return new BrowserbaseProvider({ apiKey: BROWSERBASE_KEY, apiUrl: BROWSERBASE_URL, fetch: fake.fetch, sleep: async () => {} });
		},
		env: { AGENTRUN_COMPUTER_LIVE_BROWSERBASE: "1", COMPUTER_BROWSERBASE_API_KEY: BROWSERBASE_KEY, COMPUTER_BROWSERBASE_API_URL: BROWSERBASE_URL },
		creates: (fake) => fake.only("POST", "/v1/sessions").length,
		live: (fake) => [...fake.sessions.values()].filter((s) => s.status === "RUNNING").length,
	},
	kernel: {
		fake: fakeKernel,
		async make(fake) {
			const { KernelProvider } = await import("../dist/kernel.js");
			return new KernelProvider({ apiKey: KERNEL_KEY, apiUrl: KERNEL_URL, fetch: fake.fetch, sleep: async () => {} });
		},
		env: { AGENTRUN_COMPUTER_LIVE_KERNEL: "1", COMPUTER_KERNEL_API_KEY: KERNEL_KEY, COMPUTER_KERNEL_API_URL: KERNEL_URL },
		creates: (fake) => fake.only("POST", "/browsers").length,
		live: (fake) => [...fake.browsers.values()].filter((b) => b.deletedAt === undefined).length,
	},
};

async function conformance(id, fake, { env = VENDORS[id].env, args = [] } = {}) {
	const stdout = sink();
	const stderr = sink();
	const code = await main(["--provider", id, "--json", ...args], {
		stdout,
		stderr,
		cdp: fake.cdp,
		providerOptions: { env, fetch: fake.fetch, sleep: async () => {} },
	});
	return { code, stdout: stdout.text(), stderr: stderr.text(), report: stdout.text() === "" ? undefined : JSON.parse(stdout.text()) };
}

test("the browser case set covers create with labels, attach, list, CDP, the stream, release and the cap", () => {
	const ids = browserCases.map((c) => c.id);
	for (const id of ["browser.check-refuses", "browser.labels", "browser.cdp", "browser.stream", "browser.release"]) assert.ok(ids.includes(id), `${id} is a case`);
	for (const c of browserCases) assert.ok(c.group === "browser" || c.group === "health", `${c.id}: group ${c.group}`);
	assert.equal(ids.at(-1), "browser.release", "release runs last: it ends the run's one browser");
	assert.deepEqual(kindCases("browser").map((c) => c.id), ids, "kindCases(browser) defaults to the browser cases");
});

for (const [id, vendor] of Object.entries(VENDORS)) {
	test(`conformance --provider ${id} on the fake vendor: Core passes with one browser, released, and no URL in the report`, async () => {
		const fake = vendor.fake();
		const run = await conformance(id, fake);
		assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
		const { report } = run;
		assert.equal(report.kind, "browser");
		assert.equal(report.daemonMode, "none");
		assert.equal(report.image, "chromium");
		assert.equal(report.core, "pass");
		const statuses = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
		for (const c of browserCases) assert.equal(statuses[c.id], "pass", `${c.id}: ${report.results.find((r) => r.id === c.id)?.reason}`);
		assert.deepEqual(report.cleanup.left, []);
		assert.deepEqual(report.cleanup.errors, []);
		assert.equal(vendor.creates(fake), 1, "one browser for the whole run: the cost is one session");
		assert.equal(vendor.live(fake), 0, "and it is released");
		assert.ok(fake.dialed.length > 0, "the cdp case drove the browser over CDP");
		assert.doesNotMatch(run.stdout + run.stderr, /SECRET/);
	});

	test(`conformance --provider ${id} --kind browser on the fake vendor: the provider passes the browser kind`, async () => {
		const run = await conformance(id, vendor.fake(), { args: ["--kind", "browser"] });
		assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
		assert.equal(run.report.kindVerdict?.verdict, "pass", JSON.stringify(run.report.kindVerdict));
	});

	test(`runConformance on ${id} with no cases given runs the browser cases: Core and the browser kind pass, as the CLI's do`, async () => {
		const fake = vendor.fake();
		const provider = await vendor.make(fake);
		for (const options of [{}, { kind: "browser" }]) {
			const report = await runConformance(provider, { image: "chromium", cdp: fake.cdp, ...options });
			const statuses = Object.fromEntries(report.results.map((r) => [r.id, r.status]));
			assert.equal(statuses["browser.cdp"], "pass", `${JSON.stringify(options)}: ${formatReport(report)}`);
			assert.equal(report.core, "pass", formatReport(report));
			if (options.kind) assert.deepEqual(report.kindVerdict, { kind: "browser", verdict: "pass", reasons: [] });
			assert.deepEqual(report.cleanup.left, []);
		}
	});

	test(`conformance --provider ${id}: a browser whose page does not hold what was navigated to fails browser.cdp in words`, async () => {
		const run = await conformance(id, vendor.fake({ title: "something else" }));
		assert.equal(run.code, 1, run.stdout);
		const cdp = run.report.results.find((r) => r.id === "browser.cdp");
		assert.equal(cdp.status, "fail");
		assert.match(cdp.reason, /Runtime\.evaluate/);
		assert.equal(run.report.core, "fail");
		assert.deepEqual(run.report.cleanup.left, [], "what the run made is released all the same");
	});

	test(`conformance --provider ${id}: a navigate that fails or is refused fails browser.cdp in words, and no rejection goes unhandled`, async () => {
		const unhandled = [];
		const listen = (reason) => unhandled.push(reason);
		process.on("unhandledRejection", listen);
		try {
			for (const [navigate, words] of [
				["errorText", /Page\.navigate to a data: URL failed: net::ERR_FAILED/],
				["throws", /Page\.navigate: Cannot navigate to invalid URL/],
			]) {
				const fake = vendor.fake({ navigate });
				const run = await conformance(id, fake);
				assert.equal(run.code, 1, run.stdout);
				const cdp = run.report.results.find((r) => r.id === "browser.cdp");
				assert.equal(cdp.status, "fail", `${navigate}: ${cdp.reason}`);
				assert.match(cdp.reason, words);
				assert.deepEqual(run.report.cleanup.left, []);
				// The case's socket is closed at its end: an event still awaited is rejected then, and must be handled.
				await new Promise((resolve) => setImmediate(resolve));
			}
		} finally {
			process.off("unhandledRejection", listen);
		}
		assert.deepEqual(unhandled.map(String), [], "no unhandled rejection");
	});

	test(`conformance --provider ${id} needs its live switch before anything else`, async () => {
		const { [`AGENTRUN_COMPUTER_LIVE_${id.toUpperCase()}`]: _, ...env } = vendor.env;
		const fake = vendor.fake();
		const run = await conformance(id, fake, { env });
		assert.equal(run.code, 1);
		assert.match(run.stderr, new RegExp(`set AGENTRUN_COMPUTER_LIVE_${id.toUpperCase()}=1`));
		assert.equal(fake.calls.length, 0, "no vendor call");
	});
}
