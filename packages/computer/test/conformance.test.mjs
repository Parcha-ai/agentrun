// The conformance runner, its report and its CLI against a fake provider and fake daemon (test/fake-computer.mjs):
// no Docker, no daemon binary.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { conformanceCases, formatReport, runConformance } from "../dist/index.js";
import { main } from "../dist/conformance/cli.js";
import { fakeComputers } from "./fake-computer.mjs";

const IMAGE = "debian:bookworm-slim";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/conformance/cli.js", import.meta.url));
const GROUPS = ["health", "exec", "files", "process", "provider", "drift"];
const CAPABILITIES = ["exec", "files", "processes", "network:none", "network:open", "network:allow", "lifetime:janitor", "user:root", "user:uid"];

const pass = (id, extra = {}) => ({ id, level: "core", group: id.split(".")[0], needs: [], run: async () => {}, ...extra });
const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasons = (report) => Object.fromEntries(report.results.filter((r) => r.reason).map((r) => [r.id, r.reason]));
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
			pass("exec.refused", { run: async (t) => t.ok(await t.client.call("process.read", { id: "p1", stream: "stdout", offset: 0 }), "process.read") }),
		],
	});
	assert.deepEqual(statuses(report), { "health.echo": "pass", "exec.two": "fail", "exec.refused": "fail" });
	assert.equal(reasons(report)["exec.two"], "one and two: expected 2, got 1");
	assert.match(reasons(report)["exec.refused"], /^process\.read: unsupported: process\.read is not a method/);
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
			pass("exec.root", { level: "full", needs: ["exec", "user:root"], run: count }),
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
		"exec.root": "skip",
	});
	assert.deepEqual(reasons(report), {
		"files.read": "the daemon's hello does not declare files",
		"process.start": "the provider does not declare processes",
		"provider.allow": "the provider does not declare network:allow",
		"provider.janitor": 'the provider declares lifetime "vendor", not lifetime:janitor',
		"exec.root": "the provider does not declare user:root",
	});
	assert.equal(report.core, "fail", "a Core case that could not run is not a Core pass");
	assert.deepEqual(report.undeclared, ["network:allow", "lifetime:janitor", "user:root"]);
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

const byId = (...ids) => conformanceCases.filter((c) => ids.includes(c.id));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The run's report, or a failure in words when it has not ended within 10 s. */
async function ends(run) {
	let timer;
	const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the run did not end within 10 s")), 10_000)));
	try {
		return await Promise.race([run, late]);
	} finally {
		clearTimeout(timer);
	}
}

test("a provider whose create never answers gives a failed report in bounded time", async () => {
	const fake = fakeComputers({ createHangs: true });
	const report = await ends(
		runConformance(fake.provider, {
			image: IMAGE,
			caseTimeoutMs: 300,
			cleanupTimeoutMs: 300,
			cases: [pass("health.ping"), pass("exec.argv", { needs: ["exec"] })],
		}),
	);
	assert.deepEqual(statuses(report), { "health.ping": "fail", "exec.argv": "fail" });
	assert.match(reasons(report)["health.ping"], /no computer: create did not answer within 0\.3 s/);
	assert.equal(report.core, "fail");
});

test("a provider whose release never answers gives a failed report naming it, and the run ends", async () => {
	const fake = fakeComputers({ releaseHangs: true });
	const report = await ends(runConformance(fake.provider, { image: IMAGE, caseTimeoutMs: 300, cleanupTimeoutMs: 300, cases: [pass("health.ping")] }));
	assert.equal(statuses(report)["health.ping"], "pass");
	assert.ok(report.cleanup.errors.some((error) => /release fake-1 did not answer within 0\.3 s/.test(error)), JSON.stringify(report.cleanup.errors));
	assert.deepEqual(report.cleanup.left, ["fake-1"]);
	assert.equal(report.core, "fail");
});

test("a computer whose create answers after its case ended is deleted, and the report names it", async () => {
	const fake = fakeComputers({ createDelays: [0, 600] });
	const report = await runConformance(fake.provider, {
		image: IMAGE,
		caseTimeoutMs: 300,
		cleanupTimeoutMs: 5000,
		cases: [pass("provider.slow", { run: async (t) => void (await t.create()) })],
	});
	assert.match(reasons(report)["provider.slow"], /did not finish within 0\.3 s/);
	await sleep(800);
	assert.deepEqual(fake.alive(), [], "the late computer was deleted");
	assert.deepEqual(report.cleanup.late, ["fake-2"]);
});

test("Core needs network none: a provider that offers only open fails Core in words, and nothing is made wider", async () => {
	const fake = fakeComputers({ network: ["open"] });
	const report = await runConformance(fake.provider, {
		image: IMAGE,
		cases: [pass("health.ping"), ...byId("drift.network")],
	});
	assert.deepEqual(statuses(report), { "health.ping": "fail", "drift.network": "skip" });
	assert.match(reasons(report)["health.ping"], /create was refused: network none is not offered/);
	assert.equal(reasons(report)["drift.network"], "the provider does not declare network:none");
	assert.deepEqual(fake.made, [], "no computer was made with a wider network");
	assert.equal(report.core, "fail");
});

test("exec.user passes for a computer whose own user is already 65534 (nobody)", async () => {
	const fake = fakeComputers({ uid: 65534, users: { nobody: 65534 } });
	const report = await runConformance(fake.provider, { image: IMAGE, cases: byId("exec.user") });
	assert.equal(statuses(report)["exec.user"], "pass", reasons(report)["exec.user"]);
});

test("drift.version deletes the drifted computer even when connect throws", async () => {
	const fake = fakeComputers();
	const other = fakeComputers({ connectThrows: "the socket closed" });
	const report = await runConformance(fake.provider, { image: IMAGE, cases: byId("drift.version"), drifted: () => other.provider });
	assert.equal(statuses(report)["drift.version"], "fail");
	assert.match(reasons(report)["drift.version"], /the socket closed/);
	assert.deepEqual(other.alive(), [], "the drifted computer was deleted");
});

test("exec.user-uid fails a computer whose requested user has capabilities", async () => {
	const granting = fakeComputers({ user: ["uid"], capsForUser: true });
	const report = await runConformance(granting.provider, { image: IMAGE, cases: byId("exec.user-uid") });
	assert.equal(statuses(report)["exec.user-uid"], "fail");
	assert.match(reasons(report)["exec.user-uid"], /CapEff in \/proc\/self\/status: no capabilities/);
	const clean = fakeComputers({ user: ["uid"] });
	assert.equal(statuses(await runConformance(clean.provider, { image: IMAGE, cases: byId("exec.user-uid") }))["exec.user-uid"], "pass");
});

test("a files case that makes a directory needs exec too: a daemon with files and no exec skips it in words", async () => {
	const fake = fakeComputers({ daemon: ["files"] });
	const report = await runConformance(fake.provider, { image: IMAGE, cases: conformanceCases.filter((c) => c.group === "files") });
	for (const result of report.results.filter((r) => r.id !== "files.relative-path")) {
		assert.deepEqual([result.id, result.status, result.reason], [result.id, "skip", "the provider does not declare exec"]);
	}
});

test("a create or connect that rejects fails its case, and no rejection goes unhandled", async () => {
	const unhandled = [];
	const listen = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", listen);
	try {
		const rejecting = fakeComputers({ createRejects: "the vendor API is down" });
		const report = await runConformance(rejecting.provider, {
			image: IMAGE,
			cases: [pass("provider.rejects", { computer: "none", run: async (t) => void (await t.create()) }), pass("provider.after", { computer: "none" })],
		});
		assert.deepEqual(statuses(report), { "provider.rejects": "fail", "provider.after": "pass" });
		assert.match(reasons(report)["provider.rejects"], /the vendor API is down/);
		const throwing = fakeComputers({ connectThrows: "the socket closed" });
		const connected = await runConformance(throwing.provider, {
			image: IMAGE,
			cases: [pass("provider.connects", { computer: "none", run: async (t) => void (await t.connect(await t.create())) })],
		});
		assert.match(reasons(connected)["provider.connects"], /the socket closed/);
		await sleep(50);
	} finally {
		process.off("unhandledRejection", listen);
	}
	assert.deepEqual(unhandled.map(String), [], "no unhandled rejection");
});

test("the CLI's main resolves only once its report is written out", async () => {
	const events = [];
	const slow = {
		write: (chunk, done) => {
			setTimeout(() => {
				events.push("written");
				done?.();
			}, 200);
			return false;
		},
	};
	const finished = main(["--provider", "./fixtures/fake-provider.mjs", "--json"], { stdout: slow, cwd: HERE, cases: [pass("health.ping")] }).then((code) => {
		events.push("resolved");
		return code;
	});
	assert.equal(await finished, 0);
	assert.deepEqual(events, ["written", "resolved"]);
});

test("the CLI as a process prints a report of more than 1 MiB whole through a pipe", async () => {
	const { code, stdout, stderr } = await new Promise((resolve) => {
		execFile(
			process.execPath,
			[CLI, "--provider", "./fixtures/big-report-provider.mjs", "--only", "health", "--json"],
			{ cwd: HERE, env: { ...process.env, INIT_CWD: HERE }, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
		);
	});
	assert.equal(code, 1, stderr);
	assert.ok(stdout.length > 1024 * 1024, `${stdout.length} bytes`);
	const report = JSON.parse(stdout);
	assert.equal(report.results.length, 3);
	for (const result of report.results) assert.ok(result.reason.length > 512 * 1024, result.id);
});

test("provider.check-refuses deletes a computer that create made though check refused its spec, and fails", async () => {
	const fake = fakeComputers({ createIgnoresCheck: true, lifetime: "vendor" });
	const report = await runConformance(fake.provider, { image: IMAGE, cases: byId("provider.check-refuses") });
	assert.equal(statuses(report)["provider.check-refuses"], "fail");
	assert.match(reasons(report)["provider.check-refuses"], /expected an error \(refused\), got ok/);
	assert.deepEqual(fake.alive(), [], "the computer the wrong create made was deleted");
});

test("process.list passes a daemon whose pages hold one process each", async () => {
	const fake = fakeComputers({ listPage: 1 });
	const report = await runConformance(fake.provider, { image: IMAGE, cases: byId("process.list") });
	assert.equal(statuses(report)["process.list"], "pass", reasons(report)["process.list"]);
});

const asked = (fake) => fake.calls.filter(([kind]) => kind === "network").map(([, name, policy]) => [name, policy]);

test("provider.network-change never asks a Core computer for a network the provider declares: a provider that switches keeps it on none", async () => {
	const fake = fakeComputers({ network: ["none", "open"], networkSwitches: true });
	const report = await runConformance(fake.provider, { image: IMAGE, cases: byId("provider.network-change") });
	assert.equal(statuses(report)["provider.network-change"], "pass", reasons(report)["provider.network-change"]);
	const policies = asked(fake).map(([, policy]) => policy);
	assert.ok(!policies.includes("open"), `Core asked for network open: ${JSON.stringify(policies)}`);
	assert.deepEqual(policies, ["none", { allow: ["example.com"] }], "none, which it has, then only what the provider does not declare");
	const lying = fakeComputers({ network: ["none"], networkSwitches: true });
	lying.provider.network = async (ref, policy) => {
		if (policy !== undefined) lying.calls.push(["network", ref.name, policy]);
		return { ok: true, value: policy ?? "none" };
	};
	const applied = await runConformance(lying.provider, { image: IMAGE, cases: byId("provider.network-change") });
	assert.equal(statuses(applied)["provider.network-change"], "fail");
	assert.match(reasons(applied)["provider.network-change"], /expected an error \(refused\)/);
});

test("provider.network-switch (Full, network:open) applies or refuses a change truthfully, on a computer of its own", async () => {
	const switchCase = conformanceCases.find((c) => c.id === "provider.network-switch");
	assert.ok(switchCase, "a provider.network-switch case");
	assert.equal(switchCase.level, "full");
	assert.deepEqual(switchCase.needs, ["network:open"]);
	const fake = fakeComputers({ network: ["none", "open"], networkSwitches: true });
	const report = await runConformance(fake.provider, { image: IMAGE, cases: [pass("health.ping"), ...byId("provider.network-change", "provider.network-switch")] });
	assert.deepEqual(statuses(report), { "health.ping": "pass", "provider.network-change": "pass", "provider.network-switch": "pass" }, JSON.stringify(reasons(report)));
	const shared = fake.made[0].name;
	const opened = asked(fake).filter(([, policy]) => policy === "open");
	assert.ok(opened.length > 0, "the Full case asked for network open");
	assert.ok(opened.every(([name]) => name !== shared), `the run's shared computer ${shared} was asked for open: ${JSON.stringify(opened)}`);
	assert.deepEqual(fake.alive(), []);
	const fixed = fakeComputers({ network: ["none", "open"] });
	const refused = await runConformance(fixed.provider, { image: IMAGE, cases: byId("provider.network-switch") });
	assert.equal(statuses(refused)["provider.network-switch"], "pass", "a provider whose network is fixed at create refuses truthfully");
	const lying = fakeComputers({ network: ["none", "open"] });
	lying.provider.network = async (_ref, policy) => ({ ok: true, value: policy ?? "none" });
	const lied = await runConformance(lying.provider, { image: IMAGE, cases: byId("provider.network-switch") });
	assert.equal(statuses(lied)["provider.network-switch"], "fail");
	assert.match(reasons(lied)["provider.network-switch"], /read back after it/);
	const closed = await runConformance(fakeComputers().provider, { image: IMAGE, cases: byId("provider.network-switch") });
	assert.equal(reasons(closed)["provider.network-switch"], "the provider does not declare network:open");
});

test("a docker CLI that never answers `docker version` fails the docker run in bounded time, naming the call", { timeout: 180_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-hung-docker-"));
	try {
		writeFileSync(join(dir, "docker"), "#!/bin/sh\nexec sleep 600\n");
		chmodSync(join(dir, "docker"), 0o755);
		const script = `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)};
process.exitCode = await main(["--provider", "docker"], { dockerTimeoutMs: 500 });`;
		const { code, signal, stderr } = await new Promise((resolve) => {
			execFile(
				process.execPath,
				["--input-type=module", "-e", script],
				{ cwd: HERE, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 90_000, killSignal: "SIGKILL" },
				(error, _stdout, stderr) => resolve({ code: error ? error.code : 0, signal: error?.signal ?? null, stderr }),
			);
		});
		assert.equal(signal, null, "the run ended by itself, not killed by this test");
		assert.equal(code, 1, stderr);
		assert.match(stderr, /docker version did not answer within 0\.5 s/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a create that answers after its case ended, from provider.check-refuses or drift.version, is released and named in cleanup.late", async () => {
	const fake = fakeComputers({ createIgnoresCheck: true, lifetime: "vendor", createDelays: [600] });
	const report = await runConformance(fake.provider, { image: IMAGE, caseTimeoutMs: 300, cleanupTimeoutMs: 10_000, cases: byId("provider.check-refuses") });
	assert.match(reasons(report)["provider.check-refuses"], /did not finish within 0\.3 s/);
	assert.deepEqual(report.cleanup.late, ["fake-1"], "the late computer is in the report the run returned");
	assert.deepEqual(fake.alive(), [], "and deleted before the run returned");
	assert.ok(fake.calls.some(([kind, name, how]) => kind === "release" && name === "fake-1" && how === "delete"));

	const own = fakeComputers({ lifetime: "vendor" });
	const other = fakeComputers({ version: "0.9.0", lifetime: "vendor", createDelays: [600] });
	const drift = { ...byId("drift.version")[0], timeoutMs: 300 };
	const drifted = await runConformance(own.provider, { image: IMAGE, cleanupTimeoutMs: 10_000, cases: [drift], drifted: () => other.provider });
	assert.match(reasons(drifted)["drift.version"], /did not finish within 0\.3 s/);
	assert.deepEqual(drifted.cleanup.late, ["fake-1"]);
	assert.deepEqual(other.alive(), [], "the drifted provider's late computer was deleted through it");
});

test("--only that leaves Core cases out reports core partial, names them, prints no PASS, and the CLI exits 3", async () => {
	const { provider } = fakeComputers();
	const cases = [pass("health.ping"), pass("exec.argv"), pass("files.read"), pass("provider.open", { level: "full", needs: ["network:open"] })];
	const report = await runConformance(provider, { image: IMAGE, cases, only: ["health"] });
	assert.equal(report.core, "partial");
	assert.deepEqual(report.coreNotRun, ["exec.argv", "files.read"]);
	const text = formatReport(report);
	assert.doesNotMatch(text, /PASS/);
	assert.match(text, /^core not run +exec\.argv files\.read$/m);
	assert.equal(text.trimEnd().split("\n").at(-1), "core PARTIAL 1/1 · 2 Core cases not run · full: none run · only health");

	const failingCases = [pass("health.ping", { run: async (t) => t.equal(1, 2, "one and two") }), pass("exec.argv")];
	const failing = await runConformance(provider, { image: IMAGE, cases: failingCases, only: ["health"] });
	assert.equal(failing.core, "fail");
	const fullFails = await runConformance(provider, { image: IMAGE, cases: [...cases, pass("health.open", { level: "full", run: async (t) => t.equal(1, 2, "one and two") })], only: ["health"] });
	assert.equal(fullFails.core, "fail", "a subset passes only when every case it ran passed");
	const whole = await runConformance(provider, { image: IMAGE, cases, only: ["health", "exec", "files"] });
	assert.equal(whole.core, "pass", "an --only that runs every Core case can pass Core");
	assert.deepEqual(whole.coreNotRun, []);

	const out = sink();
	assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", "--only", "health"], { stdout: out, cwd: HERE, cases }), 3);
	assert.doesNotMatch(out.text(), /PASS/);
	const json = sink();
	assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", "--only", "health", "--json"], { stdout: json, cwd: HERE, cases }), 3);
	assert.equal(JSON.parse(json.text()).core, "partial");
	assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", "--only", "health"], { stdout: sink(), cwd: HERE, cases: failingCases }), 1);
	assert.equal(await main(["--provider", "./fixtures/fake-provider.mjs", "--only", "health,exec,files"], { stdout: sink(), cwd: HERE, cases }), 0);
});

test("provider.attach checks the spec attach reads back: the network and image create asked for, and a non-root user", async () => {
	const good = await runConformance(fakeComputers().provider, { image: IMAGE, cases: byId("provider.attach") });
	assert.equal(statuses(good)["provider.attach"], "pass", reasons(good)["provider.attach"]);
	for (const [attachSpec, words] of [
		[null, /attach by id reports the spec it read back/],
		[{ user: "0:0" }, /user 0:0, root/],
		[{ network: "open" }, /the network it reports: expected "none", got "open"/],
		[{ image: "alpine:3.20" }, /the image it reports/],
		[{ user: "nobody" }, /the user it reports, as uid:gid/],
	]) {
		const report = await runConformance(fakeComputers({ attachSpec }).provider, { image: IMAGE, cases: byId("provider.attach") });
		assert.equal(statuses(report)["provider.attach"], "fail", JSON.stringify(attachSpec));
		assert.match(reasons(report)["provider.attach"], words, JSON.stringify(attachSpec));
	}
});
