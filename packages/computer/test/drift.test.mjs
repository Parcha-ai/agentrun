// The drift check, field by field: a pure function of the spec, docker inspect, hello and what the provider expects.
import assert from "node:assert/strict";
import test from "node:test";
import { drift, helloDrift } from "../dist/index.js";

const DEADLINE = "2026-11-06T12:00:00.000Z";
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none", labels: { team: "a" } };
const SIZED = { ...SPEC, network: "open", cpus: 1.5, memoryMb: 512, pids: 64 };
const EXPECTED = { version: "1.2.3", capabilities: ["exec", "files", "processes"], arch: "amd64", daemonPath: "/data/computerd", deadline: DEADLINE, user: "1000:1000" };
const MIB = 1024 * 1024;
const HELLO = { version: "1.2.3", os: "linux", arch: "amd64", capabilities: ["exec", "files", "processes"] };
/** The tmpfs options create gives 1000:1000, before their sizes. */
const WORK_OPTIONS = "rw,nosuid,nodev,exec,uid=1000,gid=1000,mode=0700";
const SOCKET_OPTIONS = "rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700";

/** What docker inspect reports for SPEC (or SIZED), as create makes it. */
function inspected(sized = false) {
	return {
		Id: "f".repeat(64),
		Name: "/computer-0123456789ab",
		State: { Running: true, Status: "running" },
		Config: {
			User: "1000:1000",
			Entrypoint: ["/opt/agentrun/computerd"],
			Cmd: ["init", "--deadline", DEADLINE],
			Labels: { team: "a", "agentrun.computer": "1", "agentrun.computer.deadline": DEADLINE },
		},
		HostConfig: {
			NetworkMode: sized ? "bridge" : "none",
			CapDrop: ["ALL"],
			CapAdd: null,
			Privileged: false,
			SecurityOpt: ["no-new-privileges"],
			PidsLimit: sized ? 64 : 1024,
			Memory: (sized ? 512 : 4096) * MIB,
			MemorySwap: (sized ? 512 : 4096) * MIB,
			NanoCpus: 0,
			CpuPeriod: 100_000,
			CpuQuota: sized ? 150_000 : 200_000,
			Tmpfs: { "/run/agentrun": `${SOCKET_OPTIONS},size=1m`, "/work": `${WORK_OPTIONS},size=${sized ? 256 : 2048}m` },
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
	assert.deepEqual(after((i) => (i.HostConfig.Tmpfs["/work"] = "size=2048m,mode=0700,gid=1000,uid=1000,exec,nodev,nosuid,rw")), [], "a tmpfs's options in another order");
	assert.deepEqual(after((i) => (i.HostConfig.Tmpfs["/tmp"] = "rw")), [], "a tmpfs the computer was not given is no widening");
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

test("PidsLimit must be the spec's, or 1024; none or unlimited is drift", () => {
	one(after((i) => (i.HostConfig.PidsLimit = 1023)), /PidsLimit: declared 1024, read back 1023/);
	one(after((i) => (i.HostConfig.PidsLimit = 4096)), /PidsLimit: declared 1024, read back 4096/);
	one(after((i) => (i.HostConfig.PidsLimit = null)), /PidsLimit/);
	one(after((i) => (i.HostConfig.PidsLimit = -1)), /PidsLimit/);
	one(after((i) => (i.HostConfig.PidsLimit = 1024), { spec: SIZED }), /PidsLimit: declared 64, read back 1024/);
});

test("Memory and MemorySwap: both the spec's memoryMb, or 4096 MiB, so swap never adds to it", () => {
	one(after((i) => (i.HostConfig.Memory = 1024 * MIB), { spec: SIZED }), /Memory: declared 536870912/);
	one(after((i) => (i.HostConfig.MemorySwap = -1), { spec: SIZED }), /MemorySwap: declared 536870912, read back -1/);
	one(after((i) => (i.HostConfig.Memory = 0)), /Memory: declared 4294967296, read back 0/);
	one(after((i) => (i.HostConfig.MemorySwap = 8192 * MIB)), /MemorySwap: declared 4294967296, read back 8589934592/);
});

test("CpuPeriod and CpuQuota: a quota of the spec's cpus, or 2, of each 100 ms", () => {
	one(after((i) => (i.HostConfig.CpuQuota = 0)), /CpuQuota: declared 200000, read back 0/);
	one(after((i) => (i.HostConfig.CpuQuota = -1)), /CpuQuota: declared 200000, read back -1/);
	one(after((i) => (i.HostConfig.CpuQuota = 200_000), { spec: SIZED }), /CpuQuota: declared 150000, read back 200000/);
	one(after((i) => (i.HostConfig.CpuPeriod = 50_000)), /CpuPeriod: declared 100000, read back 50000/);
	one(after((i) => (i.HostConfig.CpuPeriod = 0)), /CpuPeriod: declared 100000, read back 0/);
	one(after((i) => (i.HostConfig.CpuQuota = 300), { spec: { ...SPEC, cpus: 0.01 } }), /CpuQuota: declared 1000, read back 300/);
});

test("User: the uid:gid asked for, never another or none", () => {
	one(after((i) => (i.Config.User = "")), /User: declared "1000:1000", read back ""/);
	one(after((i) => delete i.Config.User), /User: declared "1000:1000", read back nothing/);
	one(after((i) => (i.Config.User = "0:0")), /User: declared "1000:1000", read back "0:0"/);
	one(after((i) => (i.Config.User = "1000")), /User/);
	one(after((i) => (i.Config.User = "1000:0")), /User/);
	const root = { ...EXPECTED, user: "0:0" };
	const rooted = structuredClone(inspected());
	rooted.Config.User = "0:0";
	rooted.HostConfig.Tmpfs = { "/work": "rw,nosuid,nodev,exec,uid=0,gid=0,mode=0700,size=2048m", "/run/agentrun": "rw,noexec,nosuid,nodev,uid=0,gid=0,mode=0700,size=1m" };
	assert.deepEqual(drift({ ...SPEC, user: "0" }, rooted, HELLO, root), [], "root, when asked, is no drift");
});

test("the tmpfs mounts: /work and /run/agentrun, the asked user's, mode 0700, /run/agentrun noexec", () => {
	one(after((i) => delete i.HostConfig.Tmpfs["/work"]), /tmpfs \/work: declared "rw,nosuid,nodev,exec,uid=1000,gid=1000,mode=0700,size=2048m", read back nothing/);
	one(after((i) => delete i.HostConfig.Tmpfs["/run/agentrun"]), /tmpfs \/run\/agentrun: declared .*read back nothing/);
	assert.equal(after((i) => (i.HostConfig.Tmpfs = null)).filter((m) => m.startsWith("tmpfs ")).length, 2);
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = "rw,nosuid,nodev,exec,uid=0,gid=1000,mode=0700,size=2048m")), /tmpfs \/work: .*uid=0/);
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = "rw,nosuid,nodev,exec,uid=1000,gid=0,mode=0700,size=2048m")), /tmpfs \/work: .*gid=0/);
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = "rw,nosuid,nodev,exec,uid=1000,gid=1000,mode=0777,size=2048m")), /tmpfs \/work: .*mode=0777/);
	one(after((i) => (i.HostConfig.Tmpfs["/run/agentrun"] = "rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0755,size=1m")), /tmpfs \/run\/agentrun: .*mode=0755/);
	one(after((i) => (i.HostConfig.Tmpfs["/run/agentrun"] = "rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=1m")), /tmpfs \/run\/agentrun/);
	one(after((i) => (i.HostConfig.Tmpfs["/run/agentrun"] = "rw,noexec,nosuid,nodev,uid=2000,gid=2000,mode=0700,size=1m")), /tmpfs \/run\/agentrun: .*uid=2000/);
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = "")), /tmpfs \/work/);
});

test("the tmpfs sizes: /work half the spec's memoryMb (or of 4096 MiB), so a full /work is ENOSPC, never an OOM; /run/agentrun 1 MiB", () => {
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = WORK_OPTIONS)), /tmpfs \/work: declared "[^"]*size=2048m", read back "rw,nosuid,nodev,exec,uid=1000,gid=1000,mode=0700"$/);
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = `${WORK_OPTIONS},size=4096m`)), /tmpfs \/work: declared "[^"]*size=2048m", read back "[^"]*size=4096m"/);
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = `${WORK_OPTIONS},size=0`)), /tmpfs \/work: .*size=0"/);
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = `${WORK_OPTIONS},size=2048m,size=8g`)), /tmpfs \/work: .*size=8g/);
	one(after((i) => (i.HostConfig.Tmpfs["/work"] = `${WORK_OPTIONS},size=2048m`), { spec: SIZED }), /tmpfs \/work: declared "[^"]*size=256m", read back "[^"]*size=2048m"/);
	one(after((i) => (i.HostConfig.Tmpfs["/run/agentrun"] = SOCKET_OPTIONS)), /tmpfs \/run\/agentrun: declared "[^"]*size=1m", read back "rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700"$/);
	one(after((i) => (i.HostConfig.Tmpfs["/run/agentrun"] = `${SOCKET_OPTIONS},size=64m`)), /tmpfs \/run\/agentrun: declared "[^"]*size=1m", read back "[^"]*size=64m"/);
	const odd = { ...SPEC, memoryMb: 7 };
	one(after((i) => (i.HostConfig.Memory = i.HostConfig.MemorySwap = 7 * MIB), { spec: odd }), /tmpfs \/work: declared "[^"]*size=3m"/);
});

test("the daemon is the declared binary, bind-mounted read-only at /opt/agentrun/computerd, and no other bind mount", () => {
	one(after((i) => (i.Mounts = [])), /daemon mount/);
	one(after((i) => (i.Mounts[0].RW = true)), /daemon mount.*read-only/);
	one(after((i) => (i.Mounts[0].Source = "/data/other")), /daemon mount.*\/data\/other/);
	one(after((i) => (i.Mounts[0].Type = "volume")), /daemon mount/);
	one(after((i) => i.Mounts.push({ Type: "bind", Source: "/", Destination: "/host", RW: false })), /bind mount.*\/host/);
	one(after((i) => i.Mounts.push({ ...i.Mounts[0] })), /daemon mount/);
});

test("the entrypoint is the daemon and the command is init with the label's deadline", () => {
	one(after((i) => (i.Config.Entrypoint = ["/bin/sh"])), /Entrypoint/);
	one(after((i) => (i.Config.Entrypoint = null)), /Entrypoint/);
	one(after((i) => (i.Config.Cmd = ["stdio"])), /Cmd/);
	one(after((i) => (i.Config.Cmd = ["init"])), /Cmd: declared \["init","--deadline","2026-11-06T12:00:00.000Z"\], read back \["init"\]/);
	one(after((i) => (i.Config.Cmd = ["init", "--deadline", "2099-01-01T00:00:00.000Z"])), /Cmd: .*2099/);
	one(after((i) => (i.Config.Cmd = ["init", "--deadline", DEADLINE, "extra"])), /Cmd/);
	one(after((i) => (i.Config.Cmd = null)), /Cmd/);
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
