// The conformance case isolation.vendor-agent against fake computers: a program the computer's user runs reaches no
// port of the vendor's own agent, on either loopback, and no outside address (a public IP literal on 443, a DNS name),
// and sees its own loopback alone. The agent's ports are each provider's own declaration
// (capabilities().vendorAgentPorts), never the case's. No Docker, no daemon, no vendor.
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

test("it passes with no ports declared (a vendor with no agent inside), on the outside and the interfaces alone", async () => {
	const report = await run({ vendorAgentPorts: [] });
	assert.deepEqual(statuses(report), { [ID]: "pass" }, reasons(report)[ID]);
});

test("it fails where a program reaches an outside address, by a public IP literal on 443 or by a DNS name, with or without agent ports", async () => {
	for (const vendorAgentPorts of [[2280], []]) {
		for (const target of ["1.1.1.1:443", "example.com:443"]) {
			const report = await run({ vendorAgentPorts, agentAnswers: [target] });
			assert.equal(statuses(report)[ID], "fail", `${target} with ports ${JSON.stringify(vendorAgentPorts)}`);
			assert.ok(reasons(report)[ID].includes(target), reasons(report)[ID]);
		}
	}
});

test("it fails where a program reaches the vendor's agent on a loopback, and names the target", async () => {
	for (const target of ["127.0.0.1:2280", "[::1]:2280"]) {
		const report = await run({ vendorAgentPorts: [2280], agentAnswers: [target] });
		assert.equal(statuses(report)[ID], "fail", target);
		assert.ok(reasons(report)[ID].includes(target), reasons(report)[ID]);
	}
});

test("a kernel's fallback tunnels, down and addressless, pass; one a program of the computer's user could bring up fails, named", async () => {
	// The Modal live run: Modal's kernel gives every new network namespace tunl0, gre0, sit0 and the rest, down and with no
	// address; no program can use them, holding no CAP_NET_ADMIN. One a program could raise is a way out.
	const quiet = await run({ vendorAgentPorts: [2280], probeQuiet: ["tunl0", "gre0", "sit0"] });
	assert.deepEqual(statuses(quiet), { [ID]: "pass" }, reasons(quiet)[ID]);
	const raised = await run({ vendorAgentPorts: [2280], probeQuiet: ["tunl0"], probeRaised: ["tunl0"] });
	assert.equal(statuses(raised)[ID], "fail");
	assert.match(reasons(raised)[ID], /tunl0/);
});

test("a desktop's own display socket (the daemon's DISPLAY :N, /tmp/.X11-unix/XN) is its own; any other socket still fails, and a computer with no desktop has no display of its own", async () => {
	// The ruling for desktop providers (Orgo's X99, Docker's and E2B's X0): the tool must reach the display, nothing else.
	const own = ["/run/agentrun/computerd.sock"];
	const desktop = { kind: "desktop", groups: ["exec", "files", "processes", "screen", "input.pointer", "input.keys"], vendorAgentPorts: [2280], display: ":99" };
	const passing = await run({ ...desktop, pathSockets: [...own, "/tmp/.X11-unix/X99"] });
	assert.deepEqual(statuses(passing), { [ID]: "pass" }, reasons(passing)[ID]);
	const bus = await run({ ...desktop, pathSockets: [...own, "/tmp/.X11-unix/X99", "/run/user/2510/bus"] });
	assert.equal(statuses(bus)[ID], "fail");
	assert.match(reasons(bus)[ID], /\/run\/user\/2510\/bus/);
	assert.doesNotMatch(reasons(bus)[ID], /: .*X11-unix\/X99/, "the display is not among the sockets named as not its own");
	const another = await run({ ...desktop, pathSockets: [...own, "/tmp/.X11-unix/X0"] });
	assert.equal(statuses(another)[ID], "fail", "a display other than its own DISPLAY's");
	assert.match(reasons(another)[ID], /X11-unix\/X0/);
	const linux = await run({ vendorAgentPorts: [2280], display: ":99", pathSockets: [...own, "/tmp/.X11-unix/X99"] });
	assert.equal(statuses(linux)[ID], "fail", "a computer with no desktop");
	assert.match(reasons(linux)[ID], /X11-unix\/X99/);
});

test("it fails where a program sees another interface than its own loopback, and names them", async () => {
	const report = await run({ vendorAgentPorts: [2280], probeInterfaces: ["lo", "eth0"] });
	assert.equal(statuses(report)[ID], "fail");
	assert.match(reasons(report)[ID], /eth0/);
});

test("it fails where a program connects to a path unix socket that is not the computer's own, naming it; the computer's own sockets pass, and are recorded", async () => {
	// Review (#1994, P2-2): a network namespace does not cut a path socket, so a vendor's agent listening on one is
	// reached from inside; the computer's own (computerd's, the Archil sync socket's) are the only ones allowed.
	const own = ["/run/agentrun/computerd.sock", "/run/agentrun-archil/archil.sock"];
	const passing = await run({ vendorAgentPorts: [2280], pathSockets: own });
	assert.deepEqual(statuses(passing), { [ID]: "pass" }, reasons(passing)[ID]);
	assert.ok(passing.results[0].observed.some((line) => line.includes("/run/agentrun/computerd.sock")), JSON.stringify(passing.results[0].observed));
	const vendor = await run({ vendorAgentPorts: [2280], pathSockets: [...own, "/run/vendor/agent.sock"] });
	assert.equal(statuses(vendor)[ID], "fail");
	assert.match(reasons(vendor)[ID], /\/run\/vendor\/agent\.sock/);
	// The listing is computerd's own (the probe's sockets), so no image lacks it; a daemon whose probe reports no list is a
	// failure in words, never a fence that silently did not run.
	const unlisted = await run({ vendorAgentPorts: [2280], pathSockets: "no list" });
	assert.equal(statuses(unlisted)[ID], "fail");
	assert.match(reasons(unlisted)[ID], /no list of the path unix sockets/);
});

test("it is skipped in words where nothing is declared (Docker), and fails Core for a child daemon that declares nothing", async () => {
	const docker = await run({});
	assert.equal(statuses(docker)[ID], "skip");
	assert.match(reasons(docker)[ID], /vendor-agent/);
	const child = await run({ mode: "child" });
	assert.equal(statuses(child)[ID], "fail");
	assert.match(reasons(child)[ID], /vendor-agent/);
});
