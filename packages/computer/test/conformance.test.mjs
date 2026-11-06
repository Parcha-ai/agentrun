// The conformance runner, its report and its CLI against a fake provider and fake daemon (test/fake-computer.mjs):
// no Docker, no daemon binary.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { conformanceCases, formatReport, runConformance } from "../dist/index.js";
import { main } from "../dist/conformance/cli.js";
import { fakeComputers } from "./fake-computer.mjs";

const IMAGE = "debian:bookworm-slim";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/conformance/cli.js", import.meta.url));
const GROUPS = ["health", "exec", "files", "process", "provider", "drift"];
const CAPABILITIES = ["exec", "files", "processes", "network:none", "network:open", "network:allow", "lifetime:janitor"];

const pass = (id, extra = {}) => ({ id, level: "core", group: id.split(".")[0], needs: [], run: async () => {}, ...extra });
const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasons = (report) => Object.fromEntries(report.results.filter((r) => r.reason).map((r) => [r.id, r.reason]));
const sink = () => {
	let text = "";
	return { write: (chunk) => (text += chunk), text: () => text };
};

test("a case that passes is pass; one that throws is fail, with what it found as the reason", async () => {
	const { provider } = fakeComputers();
	const report = await runConformance(provider, {
		image: IMAGE,
		cases: [
			pass("health.echo", {
				run: async (t) => {
					t.equal((await t.exec(["echo", "hi", "there"])).out, "hi there\n", "echo's output");
					t.deepEqual(await t.call("ping", {}), {}, "ping");
				},
			}),
			pass("exec.two", { run: async (t) => t.equal(1, 2, "one and two") }),
			pass("exec.refused", { run: async (t) => t.ok(await t.client.call("process.list", {}), "process.list") }),
		],
	});
	assert.deepEqual(statuses(report), { "health.echo": "pass", "exec.two": "fail", "exec.refused": "fail" });
	assert.equal(reasons(report)["exec.two"], "one and two: expected 2, got 1");
	assert.match(reasons(report)["exec.refused"], /^process\.list: unsupported: process\.list is not a method/);
	assert.equal(report.core, "fail");
	assert.equal(report.provider, "fake");
	assert.equal(report.providerVersion, "1.0.0");
	assert.equal(report.image, IMAGE);
	assert.deepEqual(report.daemon, { version: "1.0.0", arch: "amd64" });
	assert.deepEqual(
		report.results.map(({ id, level, group }) => [id, level, group]),
		[
			["health.echo", "core", "health"],
			["exec.two", "core", "exec"],
			["exec.refused", "core", "exec"],
		],
	);
});

test("a case whose needs the provider or the daemon does not declare is skip with the reason, never fail", async () => {
	const { provider } = fakeComputers({ daemon: ["exec", "files"], network: ["none", "open"], lifetime: "vendor", hello: { capabilities: ["exec"] } });
	let ran = 0;
	const count = async () => void ran++;
	const report = await runConformance(provider, {
		image: IMAGE,
		cases: [
			pass("exec.argv", { needs: ["exec"], run: count }),
			pass("files.read", { needs: ["files"], run: count }),
			pass("process.start", { needs: ["processes"], run: count }),
			pass("provider.open", { level: "full", needs: ["network:open"], run: count }),
			pass("provider.allow", { level: "full", needs: ["network:allow"], run: count }),
			pass("provider.janitor", { level: "full", needs: ["lifetime:janitor"], run: count }),
		],
	});
	assert.equal(ran, 2);
	assert.deepEqual(statuses(report), {
		"exec.argv": "pass",
		"files.read": "skip",
		"process.start": "skip",
		"provider.open": "pass",
		"provider.allow": "skip",
		"provider.janitor": "skip",
	});
	assert.deepEqual(reasons(report), {
		"files.read": "the daemon's hello does not declare files",
		"process.start": "the provider does not declare processes",
		"provider.allow": "the provider does not declare network:allow",
		"provider.janitor": 'the provider declares lifetime "vendor", not lifetime:janitor',
	});
	assert.equal(report.core, "fail", "a Core case that could not run is not a Core pass");
	assert.deepEqual(report.undeclared, ["network:allow", "lifetime:janitor"]);
});

test("Core passes when every Core case passes, whatever Full skips", async () => {
	const { provider } = fakeComputers();
	const report = await runConformance(provider, {
		image: IMAGE,
		cases: [pass("health.ping"), pass("provider.allow", { level: "full", needs: ["network:allow"] })],
	});
	assert.equal(report.core, "pass");
	assert.deepEqual(report.undeclared, ["network:allow"]);
});

test("every computer the run made is deleted, even when a case throws or hangs; each carries the run's label", async () => {
	const fake = fakeComputers();
	const report = await runConformance(fake.provider, {
		image: IMAGE,
		caseTimeoutMs: 500,
		cases: [
			pass("provider.throws", {
				run: async (t) => {
					await t.create();
					await t.create({ labels: { role: "second" } });
					await t.connect();
					throw new Error("it broke halfway");
				},
			}),
			pass("provider.fresh", { computer: "fresh", run: async (t) => t.assert(t.ref.name !== undefined, "a ref") }),
			pass("provider.hangs", {
				run: async (t) => {
					await t.create();
					await new Promise((resolve) => t.signal.addEventListener("abort", resolve));
					await new Promise(() => {});
				},
			}),
		],
	});
	assert.deepEqual(statuses(report), { "provider.throws": "fail", "provider.fresh": "pass", "provider.hangs": "fail" });
	assert.equal(reasons(report)["provider.throws"], "it broke halfway");
	assert.match(reasons(report)["provider.hangs"], /did not finish within 0\.5 s/);
	assert.equal(fake.made.length, 5, "the shared computer and four of the cases'");
	const [label] = Object.entries(fake.made[0].labels);
	assert.equal(label[0], "agentrun.conformance");
	assert.match(label[1], /^[0-9a-f]{12}$/);
	for (const { labels } of fake.made) assert.equal(labels["agentrun.conformance"], label[1]);
	assert.deepEqual(fake.alive(), []);
	assert.equal(fake.open(), 0, "every connection was closed");
	assert.deepEqual(report.cleanup.left, []);
	assert.deepEqual(report.cleanup.errors, []);
	assert.equal(report.cleanup.deleted.length, 5);
	assert.deepEqual(
		fake.calls.filter(([kind]) => kind === "list").at(-1),
		["list", { "agentrun.conformance": label[1] }],
		"the run checks, by its label, that nothing is left",
	);
});

test("the janitor's sweep, scoped to the run's label, ends a computer a case made behind the runner's back", async () => {
	const fake = fakeComputers();
	const report = await runConformance(fake.provider, {
		image: IMAGE,
		cases: [pass("provider.direct", { computer: "none", run: async (t) => t.ok(await t.provider.create(t.spec()), "create") })],
	});
	assert.equal(statuses(report)["provider.direct"], "pass");
	assert.deepEqual(fake.alive(), []);
	assert.deepEqual(report.cleanup.left, []);
	assert.equal(report.core, "pass");
});

test("a computer the run cannot delete is named in the report, and Core fails", async () => {
	const fake = fakeComputers({ keepOnRelease: true, lifetime: "vendor" });
	const report = await runConformance(fake.provider, { image: IMAGE, cases: [pass("health.ping")] });
	assert.equal(statuses(report)["health.ping"], "pass");
	assert.deepEqual(report.cleanup.left, ["fake-1"]);
	assert.equal(report.core, "fail");
	assert.match(formatReport(report), /left fake-1/);
});

test("when no computer can be made, every case that needs one fails with create's words; the rest run", async () => {
	const fake = fakeComputers({ failCreate: "no capacity in this region" });
	const report = await runConformance(fake.provider, {
		image: IMAGE,
		cases: [pass("health.ping"), pass("provider.check", { computer: "none", run: async (t) => t.equal(t.provider.check(t.spec()).length, 0, "refusals") })],
	});
	assert.deepEqual(statuses(report), { "health.ping": "fail", "provider.check": "pass" });
	assert.match(reasons(report)["health.ping"], /no computer: create was refused: no capacity in this region/);
	assert.equal(report.daemon, null);
	assert.equal(report.core, "fail");
});

test("only runs the groups or case ids named", async () => {
	const { provider } = fakeComputers();
	const cases = [pass("health.ping"), pass("exec.argv"), pass("files.read"), pass("files.write")];
	assert.deepEqual(Object.keys(statuses(await runConformance(provider, { image: IMAGE, cases, only: ["files"] }))), ["files.read", "files.write"]);
	const report = await runConformance(provider, { image: IMAGE, cases, only: ["health", "files.write"] });
	assert.deepEqual(Object.keys(statuses(report)), ["health.ping", "files.write"]);
	assert.deepEqual(report.only, ["health", "files.write"]);
});

test("the drift cases get the drifted provider when one is given, and skip in words when not", async () => {
	const fake = fakeComputers();
	const other = fakeComputers({ version: "0.9.0" });
	const drift = pass("drift.version", { computer: "none", run: async (t) => t.equal((await t.drifted()).version, "0.9.0", "the drifted version") });
	assert.equal(statuses(await runConformance(fake.provider, { image: IMAGE, cases: [drift], drifted: () => other.provider }))["drift.version"], "pass");
	const without = await runConformance(fake.provider, { image: IMAGE, cases: [drift] });
	assert.equal(statuses(without)["drift.version"], "skip");
	assert.match(reasons(without)["drift.version"], /no drifted provider was given/);
	assert.equal(without.core, "fail");
});

test("an aborted run ends what it made and reports the cases it did not run as failed", async () => {
	const fake = fakeComputers();
	const controller = new AbortController();
	const report = await runConformance(fake.provider, {
		image: IMAGE,
		signal: controller.signal,
		cases: [pass("health.one", { run: async () => controller.abort() }), pass("health.two")],
	});
	assert.equal(statuses(report)["health.two"], "fail");
	assert.match(reasons(report)["health.two"], /the run was aborted/);
	assert.deepEqual(fake.alive(), []);
});

test("the report prints one line per level and group, failures and skips under it, and the verdict", async () => {
	const { provider } = fakeComputers();
	const report = await runConformance(provider, {
		image: IMAGE,
		cases: [
			pass("health.hello"),
			pass("health.ping"),
			pass("exec.argv", { run: async (t) => t.equal(1, 2, "one and two") }),
			pass("exec.streams"),
			pass("provider.open", { level: "full", needs: ["network:open"] }),
			pass("provider.janitor", { level: "full", needs: ["lifetime:janitor"] }),
		],
	});
	const lines = formatReport(report).trimEnd().split("\n");
	assert.equal(lines[0], "computer conformance · fake · computerd 1.0.0 linux/amd64");
	assert.match(lines[1], /^core health +hello ping +✓ 2$/);
	assert.match(lines[2], /^core exec +argv streams +✓ 1 ✗ 1$/);
	assert.equal(lines[3], "  ✗ exec.argv: one and two: expected 2, got 1");
	assert.match(lines[4], /^full provider +open janitor +✓ 1 - 1$/);
	assert.equal(lines[5], "  - provider.open: the provider does not declare network:open");
	assert.equal(lines.at(-1), "core FAIL 3/4 · full 1/2 · network:open not declared");
	const passing = await runConformance(provider, { image: IMAGE, cases: [pass("health.ping")], only: ["health"] });
	assert.equal(formatReport(passing).trimEnd().split("\n").at(-1), "core PASS 1/1 · full: none run · only health");
});

test("the CLI loads a provider module by path, prints the report, and exits 0 when Core passes", async () => {
	const out = sink();
	const code = await main(["--provider", "./fixtures/fake-provider.mjs"], { stdout: out, cwd: HERE, cases: [pass("health.ping")] });
	assert.equal(code, 0);
	assert.match(out.text(), /^computer conformance · fake-module · computerd 1\.0\.0 linux\/amd64\n/);
	assert.match(out.text(), /core PASS 1\/1/);
});

test("the CLI's --json prints the report object; a Core failure exits 1", async () => {
	const out = sink();
	const cases = [pass("health.ping"), pass("exec.argv", { run: async (t) => t.equal(1, 2, "one and two") })];
	const code = await main(["--provider", "./fixtures/fake-provider.mjs", "--json", "--image", "alpine:3.20"], { stdout: out, cwd: HERE, cases });
	assert.equal(code, 1);
	const report = JSON.parse(out.text());
	assert.deepEqual(Object.keys(report).sort(), ["cleanup", "core", "daemon", "image", "provider", "providerVersion", "results", "undeclared"]);
	assert.equal(report.provider, "fake-module");
	assert.equal(report.image, "alpine:3.20");
	assert.equal(report.core, "fail");
	assert.deepEqual(report.results[1], { id: "exec.argv", level: "core", group: "exec", status: "fail", reason: "one and two: expected 2, got 1" });
});

test("the CLI exits 2 on a usage error, and says what is wrong", async () => {
	for (const [argv, words] of [
		[[], /--provider is required/],
		[["--provider"], /--provider needs a value/],
		[["--provider", "docker", "--frobnicate"], /unknown option --frobnicate/],
		[["--provider", "./fixtures/missing.mjs"], /cannot load the provider module .*missing\.mjs/],
		[["--provider", "./fixtures/no-factory.mjs"], /does not export createProvider\(\)/],
		[["--provider", "./fixtures/fake-provider.mjs", "--only", "exec,network"], /--only: network is neither a group .* nor a case id/],
	]) {
		const err = sink();
		const code = await main(argv, { stdout: sink(), stderr: err, cwd: HERE, cases: [pass("exec.argv")] });
		assert.equal(code, 2, `${argv.join(" ")}: ${err.text()}`);
		assert.match(err.text(), words, argv.join(" "));
		assert.match(err.text(), /usage: npm run conformance/);
	}
});

test("the CLI as a process: a usage error exits 2; a provider that cannot make a computer fails Core and exits 1", async () => {
	const run = (args) =>
		new Promise((resolve) => {
			execFile(process.execPath, [CLI, ...args], { cwd: HERE, env: { ...process.env, INIT_CWD: HERE } }, (error, stdout, stderr) =>
				resolve({ code: error ? error.code : 0, stdout, stderr }),
			);
		});
	const usage = await run(["--frobnicate"]);
	assert.equal(usage.code, 2, usage.stderr);
	const broken = await run(["--provider", "./fixtures/broken-provider.mjs", "--only", "health"]);
	assert.equal(broken.code, 1, broken.stderr);
	assert.match(broken.stdout, /computer conformance · broken · no daemon reached/);
	assert.match(broken.stdout, /✗ health\.hello: no computer: create was refused: no capacity in this region/);
	assert.match(broken.stdout, /core FAIL 0\/\d+/);
});

test("each case of the suite is data: a unique id in its group, a level, and needs the runner knows", () => {
	assert.ok(conformanceCases.length >= 40, `${conformanceCases.length} cases`);
	const ids = new Set();
	for (const c of conformanceCases) {
		assert.ok(GROUPS.includes(c.group), `${c.id}: group ${c.group}`);
		assert.ok(c.id.startsWith(`${c.group}.`), c.id);
		assert.ok(!ids.has(c.id), `${c.id} twice`);
		ids.add(c.id);
		assert.ok(c.level === "core" || c.level === "full", `${c.id}: level ${c.level}`);
		for (const need of c.needs) assert.ok(CAPABILITIES.includes(need), `${c.id} needs ${need}`);
		if (c.level === "core") assert.ok(c.needs.every((need) => ["exec", "files", "processes", "network:none"].includes(need)), `${c.id}: a Core case needs only Core capabilities`);
		assert.equal(typeof c.run, "function");
	}
	for (const group of GROUPS) assert.ok(conformanceCases.some((c) => c.group === group && c.level === "core"), `a Core case in ${group}`);
});
