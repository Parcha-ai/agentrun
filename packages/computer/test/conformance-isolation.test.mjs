// The conformance case isolation.vendor-agent against fake computers: a program the computer's user runs reaches no
// port of the vendor's own agent, on either loopback, and sees its own loopback alone. Its ports are each provider's own
// declaration (capabilities().vendorAgentPorts), never the case's. No Docker, no daemon, no vendor.
import assert from "node:assert/strict";
import test from "node:test";
import { conformanceCases, coreGroups, runConformance } from "../dist/index.js";
import { fakeComputers } from "./fake-computer.mjs";

const IMAGE = "fixture:image";
const ID = "isolation.vendor-agent";
const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasons = (report) => Object.fromEntries(report.results.filter((r) => r.reason).map((r) => [r.id, r.reason]));
const run = (options) => runConformance(fakeComputers(options).provider, { image: IMAGE, cases: conformanceCases.filter((c) => c.id === ID) });

test("isolation.vendor-agent is a Core case of its own group, which needs the declaration and exec", () => {
	const found = conformanceCases.filter((c) => c.id === ID);
	assert.equal(found.length, 1);
	assert.equal(found[0].level, "core");
	assert.equal(found[0].group, "isolation");
	assert.deepEqual([...found[0].needs].sort(), ["exec", "vendor-agent"]);
});

test("a child daemon must declare its vendor's agent; a pid1 or Docker-shaped one need not", () => {
	assert.ok(coreGroups("linux", "child").includes("vendor-agent"));
	assert.ok(!coreGroups("linux", "pid1").includes("vendor-agent"));
	assert.ok(!coreGroups("android", "none").includes("vendor-agent"));
});

test("it passes where the probe of each declared port on both loopbacks is refused and the loopback is alone", async () => {
	const report = await run({ vendorAgentPorts: [2280, 49983] });
	assert.deepEqual(statuses(report), { [ID]: "pass" }, reasons(report)[ID]);
});

test("it passes with no ports declared (a vendor with no agent inside), on the interfaces alone", async () => {
	const report = await run({ vendorAgentPorts: [] });
	assert.deepEqual(statuses(report), { [ID]: "pass" }, reasons(report)[ID]);
});

test("it fails where a program reaches the vendor's agent on a loopback, and names the target", async () => {
	for (const target of ["127.0.0.1:2280", "[::1]:2280"]) {
		const report = await run({ vendorAgentPorts: [2280], agentAnswers: [target] });
		assert.equal(statuses(report)[ID], "fail", target);
		assert.ok(reasons(report)[ID].includes(target), reasons(report)[ID]);
	}
});

test("it fails where a program sees another interface than its own loopback, and names them", async () => {
	const report = await run({ vendorAgentPorts: [2280], probeInterfaces: ["lo", "eth0"] });
	assert.equal(statuses(report)[ID], "fail");
	assert.match(reasons(report)[ID], /eth0/);
});

test("it is skipped in words where nothing is declared (Docker), and fails Core for a child daemon that declares nothing", async () => {
	const docker = await run({});
	assert.equal(statuses(docker)[ID], "skip");
	assert.match(reasons(docker)[ID], /vendor-agent/);
	const child = await run({ mode: "child" });
	assert.equal(statuses(child)[ID], "fail");
	assert.match(reasons(child)[ID], /vendor-agent/);
});
