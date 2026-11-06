// The drift check, field by field: a pure function of the spec, docker inspect, hello and what the provider expects.
import assert from "node:assert/strict";
import test from "node:test";
import { drift, helloDrift } from "../dist/index.js";

const DEADLINE = "2026-11-06T12:00:00.000Z";
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none", labels: { team: "a" } };
const SIZED = { ...SPEC, network: "open", cpus: 1.5, memoryMb: 512, pids: 64 };
const EXPECTED = { version: "1.2.3", capabilities: ["exec", "files", "processes"], arch: "amd64", daemonPath: "/data/computerd", deadline: DEADLINE };
const HELLO = { version: "1.2.3", os: "linux", arch: "amd64", capabilities: ["exec", "files", "processes"] };

/** What docker inspect reports for SPEC (or SIZED), as create makes it. */
function inspected(sized = false) {
	return {
		Id: "f".repeat(64),
		Name: "/computer-0123456789ab",
		State: { Running: true, Status: "running" },
		Config: {
			Entrypoint: ["/opt/agentrun/computerd"],
			Cmd: ["init"],
			Labels: { team: "a", "agentrun.computer": "1", "agentrun.computer.deadline": DEADLINE },
		},
		HostConfig: {
			NetworkMode: sized ? "bridge" : "none",
			CapDrop: ["ALL"],
			CapAdd: null,
			Privileged: false,
			SecurityOpt: ["no-new-privileges"],
			PidsLimit: sized ? 64 : 4096,
			Memory: sized ? 512 * 1024 * 1024 : 0,
			MemorySwap: sized ? 512 * 1024 * 1024 : 0,
			NanoCpus: sized ? 1_500_000_000 : 0,
		},
		Mounts: [{ Type: "bind", Source: "/data/computerd", Destination: "/opt/agentrun/computerd", RW: false, Mode: "", Propagation: "rprivate" }],
		NetworkSettings: { Networks: { [sized ? "bridge" : "none"]: { EndpointID: "e" } } },
	};
}

/** The drift after change(inspect) mutates a copy of what create made. */
function after(change, { spec = SPEC, hello = HELLO, expected = EXPECTED } = {}) {
	const report = structuredClone(inspected(spec === SIZED));
	change(report);
	return drift(spec, report, hello, expected);
}

/** Exactly one mismatch, in words that match. */
function one(found, words) {
	assert.equal(found.length, 1, JSON.stringify(found));
	assert.match(found[0], words);
}

test("a computer made as declared has no drift", () => {
	assert.deepEqual(drift(SPEC, inspected(), HELLO, EXPECTED), []);
	assert.deepEqual(drift(SIZED, inspected(true), HELLO, EXPECTED), []);
	assert.deepEqual(after((i) => (i.HostConfig.SecurityOpt = ["no-new-privileges:true", "seccomp=x"])), [], "no-new-privileges:true is the same");
	assert.deepEqual(after((i) => (i.HostConfig.CapAdd = [])), []);
	assert.deepEqual(after((i) => (i.Config.Labels.extra = "x")), [], "labels Docker or the image adds are no drift");
	assert.deepEqual(after((i) => i.Mounts.push({ Type: "volume", Source: "", Destination: "/var/lib/data", RW: true })), [], "a volume the image declares");
	assert.deepEqual(drift(SPEC, inspected(), { ...HELLO, capabilities: [...HELLO.capabilities, "display"] }, EXPECTED), [], "a daemon may offer more");
});

test("network: none must read back as none, open as the bridge, and nothing else", () => {
	one(after((i) => (i.HostConfig.NetworkMode = "bridge")), /network: declared none, read back .*bridge/);
	one(after((i) => (i.NetworkSettings.Networks.extra = {})), /network: declared none, read back .*extra/);
	one(after((i) => (i.HostConfig.NetworkMode = "host")), /network: declared none, read back .*host/);
	one(after((i) => (i.HostConfig.NetworkMode = "none"), { spec: SIZED }), /network: declared open/);
	one(after((i) => (i.NetworkSettings.Networks = { bridge: {}, other: {} }), { spec: SIZED }), /network: declared open, read back .*other/);
});

test("CapDrop must be ALL, with no capability added and no privileged mode", () => {
	one(after((i) => (i.HostConfig.CapDrop = null)), /CapDrop/);
	one(after((i) => (i.HostConfig.CapDrop = ["NET_RAW"])), /CapDrop/);
	one(after((i) => (i.HostConfig.CapAdd = ["SYS_ADMIN"])), /CapAdd.*SYS_ADMIN/);
	one(after((i) => (i.HostConfig.Privileged = true)), /Privileged/);
});

test("no-new-privileges must be set", () => {
	one(after((i) => (i.HostConfig.SecurityOpt = null)), /no-new-privileges/);
	one(after((i) => (i.HostConfig.SecurityOpt = ["no-new-privileges:false"])), /no-new-privileges/);
	one(after((i) => (i.HostConfig.SecurityOpt = ["seccomp=unconfined"])), /no-new-privileges/);
});

test("PidsLimit must be the spec's, or 4096; none or unlimited is drift", () => {
	one(after((i) => (i.HostConfig.PidsLimit = 4095)), /PidsLimit: declared 4096, read back 4095/);
	one(after((i) => (i.HostConfig.PidsLimit = null)), /PidsLimit/);
	one(after((i) => (i.HostConfig.PidsLimit = -1)), /PidsLimit/);
	one(after((i) => (i.HostConfig.PidsLimit = 4096), { spec: SIZED }), /PidsLimit: declared 64, read back 4096/);
});

test("Memory and MemorySwap when memoryMb is asked: both the memory, so swap never adds to it", () => {
	one(after((i) => (i.HostConfig.Memory = 1024 * 1024 * 1024), { spec: SIZED }), /Memory: declared 536870912/);
	one(after((i) => (i.HostConfig.MemorySwap = -1), { spec: SIZED }), /MemorySwap: declared 536870912, read back -1/);
	assert.deepEqual(after((i) => (i.HostConfig.Memory = 1024)), [], "not asked, not checked");
});

test("NanoCpus when cpus is asked", () => {
	one(after((i) => (i.HostConfig.NanoCpus = 2_000_000_000), { spec: SIZED }), /NanoCpus: declared 1500000000, read back 2000000000/);
	one(after((i) => (i.HostConfig.NanoCpus = 0), { spec: SIZED }), /NanoCpus/);
	assert.deepEqual(after((i) => (i.HostConfig.NanoCpus = 1)), [], "not asked, not checked");
});

test("the daemon is the declared binary, bind-mounted read-only at /opt/agentrun/computerd, and no other bind mount", () => {
	one(after((i) => (i.Mounts = [])), /daemon mount/);
	one(after((i) => (i.Mounts[0].RW = true)), /daemon mount.*read-only/);
	one(after((i) => (i.Mounts[0].Source = "/data/other")), /daemon mount.*\/data\/other/);
	one(after((i) => (i.Mounts[0].Type = "volume")), /daemon mount/);
	one(after((i) => i.Mounts.push({ Type: "bind", Source: "/", Destination: "/host", RW: false })), /bind mount.*\/host/);
	one(after((i) => i.Mounts.push({ ...i.Mounts[0] })), /daemon mount/);
});

test("the entrypoint is the daemon and the command is init", () => {
	one(after((i) => (i.Config.Entrypoint = ["/bin/sh"])), /Entrypoint/);
	one(after((i) => (i.Config.Entrypoint = null)), /Entrypoint/);
	one(after((i) => (i.Config.Cmd = ["stdio"])), /Cmd/);
	one(after((i) => (i.Config.Cmd = ["init", "extra"])), /Cmd/);
});

test("the labels: agentrun.computer=1, the deadline as set, and every label the spec asked for", () => {
	one(after((i) => delete i.Config.Labels["agentrun.computer"]), /agentrun\.computer\b/);
	one(after((i) => (i.Config.Labels["agentrun.computer"] = "0")), /agentrun\.computer\b/);
	one(after((i) => delete i.Config.Labels["agentrun.computer.deadline"]), /agentrun\.computer\.deadline/);
	one(after((i) => (i.Config.Labels["agentrun.computer.deadline"] = "2099-01-01T00:00:00.000Z")), /agentrun\.computer\.deadline/);
	one(after((i) => (i.Config.Labels.team = "b")), /label team/);
	one(after((i) => (i.Config.Labels = null)).filter((m) => /label team/.test(m)), /label team/);
});

test("hello: the provider's version, every declared capability, linux, and the host's architecture", () => {
	one(helloDrift({ ...HELLO, version: "1.2.4" }, EXPECTED), /version 1\.2\.4.*expected 1\.2\.3/);
	one(helloDrift({ ...HELLO, capabilities: ["exec", "files"] }, EXPECTED), /processes/);
	one(helloDrift({ ...HELLO, capabilities: undefined }, EXPECTED), /capabilit/);
	one(helloDrift({ ...HELLO, os: "windows" }, EXPECTED), /os windows/);
	one(helloDrift({ ...HELLO, arch: "arm64" }, EXPECTED), /arch arm64.*amd64/);
	assert.deepEqual(helloDrift({ ...HELLO, arch: "arm64" }, { ...EXPECTED, arch: undefined }), [], "arch is checked only when known");
	one(drift(SPEC, inspected(), { ...HELLO, version: "0.0.1" }, EXPECTED), /version 0\.0\.1/);
});

test("every mismatch is listed, not only the first", () => {
	const found = drift(
		SPEC,
		(() => {
			const i = inspected();
			i.HostConfig.NetworkMode = "bridge";
			i.HostConfig.CapDrop = [];
			i.HostConfig.PidsLimit = 0;
			return i;
		})(),
		{ ...HELLO, version: "9", arch: "arm64" },
		EXPECTED,
	);
	assert.equal(found.length, 5, JSON.stringify(found));
});

test("a report missing whole sections is drift, never a throw", () => {
	const found = drift(SPEC, {}, { }, EXPECTED);
	assert.ok(found.length >= 8, JSON.stringify(found));
	assert.ok(drift(SPEC, null, null, EXPECTED).length >= 8);
});
