// The drift check, field by field: a pure function of the spec, docker inspect, hello and what the provider expects.
import assert from "node:assert/strict";
import test from "node:test";
import * as computer from "../dist/index.js";
import { report } from "./fake-docker.mjs";

const { drift, helloDrift } = computer;
const hostOf = (info) => computer.hostOf(info);

const DEADLINE = "2026-11-06T12:00:00.000Z";
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none", labels: { team: "a" } };
const SIZED = { ...SPEC, network: "open", cpus: 1.5, memoryMb: 512, pids: 64 };
const EXPECTED = { version: "1.2.3", capabilities: ["exec", "files", "processes"], arch: "amd64", daemonPath: "/data/computerd", deadline: DEADLINE, user: "1000:1000", apparmor: false, selinux: false };
const MIB = 1024 * 1024;
const HELLO = { version: "1.2.3", os: "linux", arch: "amd64", capabilities: ["exec", "files", "processes"] };
/** The tmpfs options create gives 1000:1000, before their sizes. */
const WORK_OPTIONS = "rw,nosuid,nodev,exec,uid=1000,gid=1000,mode=0700";
const SOCKET_OPTIONS = "rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700";

/** What Docker 29 inspect reports for SPEC (or SIZED), as create makes it. */
function inspected(sized = false) {
	return report({
		id: "f".repeat(64),
		name: "computer-0123456789ab",
		labels: { team: "a", "agentrun.computer": "1", "agentrun.computer.deadline": DEADLINE },
		cmd: ["init", "--deadline", DEADLINE],
		network: sized ? "bridge" : "none",
		pids: sized ? 64 : 1024,
		memory: (sized ? 512 : 4096) * MIB,
		quota: sized ? 150_000 : 200_000,
		daemonPath: "/data/computerd",
	});
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
	assert.deepEqual(after((i) => (i.HostConfig.CapAdd = [])), []);
	assert.deepEqual(after((i) => (i.Config.Labels.extra = "x")), [], "labels Docker or the image adds are no drift");
	assert.deepEqual(drift(SPEC, inspected(), { ...HELLO, capabilities: [...HELLO.capabilities, "display"] }, EXPECTED), [], "a daemon may offer more");
	assert.deepEqual(after((i) => (i.HostConfig.Tmpfs["/work"] = "size=2048m,mode=0700,gid=1000,uid=1000,exec,nodev,nosuid,rw")), [], "a tmpfs's options in another order");
	assert.deepEqual(after((i) => i.HostConfig.MaskedPaths.splice(2, 1)), [], "Docker's masked paths of another version");
	assert.deepEqual(after((i) => i.HostConfig.MaskedPaths.push("/sys/devices/system/cpu/cpu0/thermal_throttle")), [], "masked per CPU");
	assert.deepEqual(after((i) => (i.HostConfig.MemorySwappiness = -1)), [], "an older Docker's default swappiness");
	assert.deepEqual(after((i) => (i.HostConfig.Isolation = "default")), []);
	assert.deepEqual(after((i) => (i.HostConfig.RestartPolicy = { Name: "", MaximumRetryCount: 0 })), []);
	assert.deepEqual(after((i) => (i.HostConfig.OomKillDisable = false)), []);
	assert.deepEqual(after((i) => (i.HostConfig.Sysctls = {})), [], "an empty field Docker adds");
	assert.deepEqual(after((i) => delete i.HostConfig.DeviceCgroupRules), [], "a field an older Docker leaves out");
});

/** Fields whose value is the host's or the image's and widens nothing the box bounds: none of them is drift. */
const IRRELEVANT = [
	["HostConfig.ContainerIDFile", "/tmp/cid"],
	["HostConfig.LogConfig", { Type: "journald", Config: { tag: "x" } }],
	["HostConfig.ConsoleSize", [24, 80]],
	["HostConfig.ShmSize", 1024 * MIB],
	["HostConfig.Ulimits", [{ Name: "nofile", Soft: 1048576, Hard: 1048576 }]],
	["Config.Hostname", "box"],
	["Config.Domainname", "example.com"],
	["Config.AttachStdin", true],
	["Config.Tty", true],
	["Config.OpenStdin", true],
	["Config.ExposedPorts", { "80/tcp": {} }],
	["Config.Healthcheck", { Test: ["CMD", "true"] }],
	["Config.StopSignal", "SIGINT"],
	["Config.StopTimeout", 1],
	["Config.Shell", ["/bin/bash", "-c"]],
	["Config.OnBuild", ["RUN true"]],
	["Config.ArgsEscaped", true],
	["Config.Env", ["HOME=/work", "PATH=/bin", "LANG=C.UTF-8"]],
];

const set = (report, path, value) => {
	const keys = path.split(".");
	const last = keys.pop();
	keys.reduce((at, key) => at[key], report)[last] = value;
};

test("fields that widen nothing the box bounds are no drift", () => {
	for (const [path, value] of IRRELEVANT) assert.deepEqual(after((i) => set(i, path, value)), [], path);
});

/**
 * The closed check: one bad value for each field create does not ask for, each named in exactly one mismatch. A field
 * Docker adds later is drift unless it is empty.
 */
const BAD = [
	["HostConfig.Binds", ["/:/host"]],
	["HostConfig.PortBindings", { "22/tcp": [{ HostIp: "", HostPort: "2222" }] }],
	["HostConfig.RestartPolicy", { Name: "always", MaximumRetryCount: 0 }],
	["HostConfig.RestartPolicy", { Name: "on-failure", MaximumRetryCount: 3 }],
	["HostConfig.AutoRemove", true],
	["HostConfig.VolumeDriver", "convoy"],
	["HostConfig.VolumesFrom", ["other"]],
	["HostConfig.CgroupnsMode", "host"],
	["HostConfig.Dns", ["192.0.2.1"]],
	["HostConfig.DnsOptions", ["ndots:1"]],
	["HostConfig.DnsSearch", ["example.com"]],
	["HostConfig.ExtraHosts", ["host.docker.internal:host-gateway"]],
	["HostConfig.GroupAdd", ["999"]],
	["HostConfig.IpcMode", "host"],
	["HostConfig.IpcMode", "shareable"],
	["HostConfig.IpcMode", "container:other"],
	["HostConfig.Cgroup", "container:other"],
	["HostConfig.Links", ["/db:/computer-0123456789ab/db"]],
	["HostConfig.OomScoreAdj", -1000],
	["HostConfig.PidMode", "host"],
	["HostConfig.PidMode", "container:other"],
	["HostConfig.PublishAllPorts", true],
	["HostConfig.ReadonlyRootfs", true],
	["HostConfig.UTSMode", "host"],
	["HostConfig.UsernsMode", "host"],
	["HostConfig.Runtime", "runsc"],
	["HostConfig.Runtime", "nvidia"],
	["HostConfig.Isolation", "hyperv"],
	["HostConfig.CpuShares", 262144],
	["HostConfig.NanoCpus", 4e9],
	["HostConfig.CgroupParent", "/"],
	["HostConfig.BlkioWeight", 1000],
	["HostConfig.BlkioWeightDevice", [{ Path: "/dev/sda", Weight: 10 }]],
	["HostConfig.BlkioDeviceReadBps", [{ Path: "/dev/sda", Rate: 1 }]],
	["HostConfig.BlkioDeviceWriteBps", [{ Path: "/dev/sda", Rate: 1 }]],
	["HostConfig.BlkioDeviceReadIOps", [{ Path: "/dev/sda", Rate: 1 }]],
	["HostConfig.BlkioDeviceWriteIOps", [{ Path: "/dev/sda", Rate: 1 }]],
	["HostConfig.CpuRealtimePeriod", 1_000_000],
	["HostConfig.CpuRealtimeRuntime", 950_000],
	["HostConfig.CpusetCpus", "0-3"],
	["HostConfig.CpusetMems", "0"],
	["HostConfig.Devices", [{ PathOnHost: "/dev/mem", PathInContainer: "/dev/mem", CgroupPermissions: "rwm" }]],
	["HostConfig.DeviceCgroupRules", ["c *:* rmw"]],
	["HostConfig.DeviceRequests", [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }]],
	["HostConfig.MemoryReservation", MIB],
	["HostConfig.MemorySwappiness", 100],
	["HostConfig.OomKillDisable", true],
	["HostConfig.CpuCount", 2],
	["HostConfig.CpuPercent", 50],
	["HostConfig.IOMaximumIOps", 1],
	["HostConfig.IOMaximumBandwidth", 1],
	["HostConfig.Sysctls", { "net.ipv4.ip_unprivileged_port_start": "0" }],
	["HostConfig.Init", true],
	["HostConfig.StorageOpt", { size: "1G" }],
	["HostConfig.Annotations", { "io.example": "x" }],
	["HostConfig.KernelMemory", MIB],
	["HostConfig.KernelMemoryTCP", MIB],
	["HostConfig.MaskedPaths", []],
	["HostConfig.MaskedPaths", null],
	["HostConfig.MaskedPaths", ["/proc/acpi"]],
	["HostConfig.ReadonlyPaths", []],
	["HostConfig.ReadonlyPaths", ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sysrq-trigger"]],
	["HostConfig.Mounts", [{ Type: "bind", Source: "/data/computerd", Target: "/opt/agentrun/computerd", ReadOnly: false }]],
	["HostConfig.Mounts", [{ Type: "bind", Source: "/data/computerd", Target: "/opt/agentrun/computerd", ReadOnly: true, BindOptions: { Propagation: "rshared" } }]],
	["HostConfig.Mounts", [{ Type: "bind", Source: "/data/computerd", Target: "/opt/agentrun/computerd", ReadOnly: true }, { Type: "volume", Source: "shared", Target: "/data" }]],
	["HostConfig.Mounts", null],
	["HostConfig.FutureIsolation", "off"],
	["Config.Volumes", { "/var/lib/data": {} }],
	["Config.Image", "alpine:3.20"],
	["Config.WorkingDir", "/"],
	["Config.Env", ["PATH=/bin"]],
	["Config.Env", ["HOME=/work", "HOME=/"]],
	["Config.FutureField", { on: true }],
	["AppArmorProfile", "unconfined"],
	["AppArmorProfile", "docker-default"],
	["ProcessLabel", "system_u:system_r:spc_t:s0"],
];

test("the closed check: every field create does not ask for is Docker's default, and each bad value is named", () => {
	for (const [path, value] of BAD) {
		const field = path.split(".").at(-1);
		one(after((i) => set(i, path, value)), new RegExp(`\\b${field}\\b`));
	}
});

test("SecurityOpt is exactly what create asks: no-new-privileges, and nothing that unconfines the computer", () => {
	for (const extra of ["seccomp=unconfined", "apparmor=unconfined", "label=disable", "systempaths=unconfined", "seccomp=x", "label=type:spc_t"]) {
		one(after((i) => (i.HostConfig.SecurityOpt = ["no-new-privileges", extra])), new RegExp(`SecurityOpt.*${extra}`));
	}
	one(after((i) => (i.HostConfig.SecurityOpt = ["no-new-privileges:true"])), /SecurityOpt/);
	one(after((i) => (i.HostConfig.SecurityOpt = ["no-new-privileges", "no-new-privileges"])), /SecurityOpt/);
});

test("Mounts: the daemon's read-only bind and nothing else, an image's VOLUME included", () => {
	one(after((i) => i.Mounts.push({ Type: "volume", Name: "shared", Source: "/data/volumes/shared/_data", Destination: "/data", Driver: "local", RW: true })), /mount.*shared/);
	one(after((i) => i.Mounts.push({ Type: "volume", Name: "a".repeat(64), Source: "", Destination: "/var/lib/data", Driver: "local", RW: true })), /mount.*\/var\/lib\/data/);
	one(after((i) => i.Mounts.push({ Type: "tmpfs", Source: "", Destination: "/opt/agentrun", RW: true })), /mount.*\/opt\/agentrun"/);
	one(after((i) => (i.Mounts[0].Propagation = "rshared")), /daemon mount/);
});

test("the tmpfs mounts are exactly /work and /run/agentrun: another is drift", () => {
	one(after((i) => (i.HostConfig.Tmpfs["/tmp"] = "rw")), /tmpfs \/tmp/);
	one(after((i) => (i.HostConfig.Tmpfs["/opt/agentrun"] = "rw,exec")), /tmpfs \/opt\/agentrun/);
});

test("AppArmor and SELinux: the profile and label the host's Docker gives every container, when the host has them", () => {
	const armored = { ...EXPECTED, apparmor: true };
	assert.deepEqual(after((i) => (i.AppArmorProfile = "docker-default"), { expected: armored }), []);
	one(after((i) => (i.AppArmorProfile = ""), { expected: armored }), /AppArmorProfile/);
	one(after((i) => (i.AppArmorProfile = "unconfined"), { expected: armored }), /AppArmorProfile.*unconfined/);
	const labelled = { ...EXPECTED, selinux: true };
	assert.deepEqual(after((i) => (i.ProcessLabel = "system_u:system_r:container_t:s0:c12,c34"), { expected: labelled }), []);
	one(after((i) => (i.ProcessLabel = ""), { expected: labelled }), /ProcessLabel/);
	one(after((i) => (i.ProcessLabel = "system_u:system_r:spc_t:s0"), { expected: labelled }), /ProcessLabel.*spc_t/);
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

/** What docker info reports of a host that enforces every limit, with seccomp and AppArmor. */
const INFO = {
	Architecture: "x86_64",
	SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
	MemoryLimit: true,
	SwapLimit: true,
	PidsLimit: true,
	CPUCfsQuota: true,
	CPUCfsPeriod: true,
};

test("hostOf: the host's architecture in Go's names, its security modules, and nothing missing", () => {
	assert.deepEqual(hostOf(INFO), { arch: "amd64", apparmor: true, selinux: false, problems: [] });
	assert.deepEqual(hostOf({ ...INFO, Architecture: "aarch64", SecurityOptions: ["name=seccomp,profile=default", "name=selinux"] }), {
		arch: "arm64",
		apparmor: false,
		selinux: true,
		problems: [],
	});
	assert.deepEqual(hostOf({ ...INFO, SecurityOptions: ["name=seccomp,profile=/etc/docker/seccomp.json", "name=rootless"] }).problems, [], "a custom seccomp profile");
});

test("hostOf: a host that does not enforce a limit, or has no seccomp, is a problem in words", () => {
	const problems = (info) => hostOf({ ...INFO, ...info }).problems;
	one(problems({ MemoryLimit: false }), /^this Docker host does not enforce memory limits, so a computer's memory size is only configuration$/);
	one(problems({ SwapLimit: false }), /does not enforce swap limits/);
	one(problems({ PidsLimit: false }), /does not enforce pids limits/);
	one(problems({ CPUCfsQuota: false }), /does not enforce CPU quotas/);
	one(problems({ CPUCfsPeriod: false }), /does not enforce CPU periods/);
	one(problems({ MemoryLimit: undefined }), /memory limits/);
	one(problems({ SecurityOptions: ["name=apparmor"] }), /has no seccomp/);
	one(problems({ SecurityOptions: null }), /has no seccomp/);
	one(problems({ SecurityOptions: ["name=seccomp,profile=unconfined"] }), /seccomp profile is unconfined/);
	assert.equal(hostOf({}).problems.length, 6, JSON.stringify(hostOf({})));
	assert.equal(hostOf(null).problems.length, 6);
});
