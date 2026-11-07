// A fake docker program under a temp dir, for DockerProvider's unit tests: it records each call's argv, keeps its
// containers in a JSON file, and answers run, inspect, ps, stop, rm, info and exec (with the daemon's hello) as the
// docker CLI does. An inspect --format renders each {{json .Path}} in it. No Docker and no daemon binary are needed.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { DockerProvider } from "../dist/index.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const HELLO = { version: VERSION, os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] };

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export const idOf = (name) => createHash("sha256").update(name).digest("hex");

/** The paths Docker 29 masks and makes read-only in a container that is not privileged. */
export const MASKED_PATHS = ["/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list", "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware"];
export const READONLY_PATHS = ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"];
/** Stands for the provider's daemon path in a seeded container; fakeDocker puts the real path in. */
export const DAEMON = "@daemon";

/**
 * What Docker 29 inspect reports for a container made as DockerProvider.create makes one. Self-contained: the fake
 * docker program runs a copy of it for each docker run.
 */
export function report({
	id, name, image = "debian:bookworm-slim", labels = {}, cmd, user = "1000:1000", workdir = "/work", env = ["HOME=/work"], network = "none", running = true,
	capDrop = ["ALL"], securityOpt = ["no-new-privileges"], pids = 1024, memory = 4096 * 1024 * 1024, swap = memory, period = 100_000, quota = 200_000,
	tmpfs, ipc = "private", cgroupns = "private", daemonPath = "@daemon", apparmor = false, masked, readonly,
}) {
	const [uid, gid] = user.split(":");
	return {
		Id: id,
		Name: `/${name}`,
		State: { Running: running, Status: running ? "running" : "exited", ExitCode: 0, Error: "" },
		AppArmorProfile: apparmor ? "docker-default" : "",
		ProcessLabel: "",
		MountLabel: "",
		Config: {
			Hostname: id.slice(0, 12), Domainname: "", User: user, AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, OpenStdin: false, StdinOnce: false,
			Env: [...env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], Cmd: cmd, Image: image, Volumes: null, WorkingDir: workdir,
			Entrypoint: ["/opt/agentrun/computerd"], Labels: labels,
		},
		HostConfig: {
			Binds: null, ContainerIDFile: "", LogConfig: { Type: "json-file", Config: {} }, NetworkMode: network, PortBindings: {}, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
			AutoRemove: false, VolumeDriver: "", VolumesFrom: null, ConsoleSize: [0, 0], CapAdd: null, CapDrop: capDrop, CgroupnsMode: cgroupns, Dns: null, DnsOptions: [], DnsSearch: [],
			ExtraHosts: null, GroupAdd: null, IpcMode: ipc, Cgroup: "", Links: null, OomScoreAdj: 0, PidMode: "", Privileged: false, PublishAllPorts: false, ReadonlyRootfs: false,
			SecurityOpt: securityOpt,
			Tmpfs: tmpfs ?? {
				"/run/agentrun": `rw,noexec,nosuid,nodev,uid=${uid},gid=${gid},mode=0700,size=1m`,
				"/work": `rw,nosuid,nodev,exec,uid=${uid},gid=${gid},mode=0700,size=${Math.floor(memory / 1024 / 1024 / 2)}m`,
			},
			UTSMode: "", UsernsMode: "", ShmSize: 67108864, Runtime: "runc", Isolation: "", CpuShares: 0, Memory: memory, NanoCpus: 0, CgroupParent: "", BlkioWeight: 0,
			BlkioWeightDevice: [], BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [], BlkioDeviceReadIOps: [], BlkioDeviceWriteIOps: [], CpuPeriod: period, CpuQuota: quota,
			CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: "", CpusetMems: "", Devices: [], DeviceCgroupRules: null, DeviceRequests: null, MemoryReservation: 0,
			MemorySwap: swap, MemorySwappiness: null, OomKillDisable: null, PidsLimit: pids, Ulimits: [], CpuCount: 0, CpuPercent: 0, IOMaximumIOps: 0, IOMaximumBandwidth: 0,
			Mounts: [{ Type: "bind", Source: daemonPath, Target: "/opt/agentrun/computerd", ReadOnly: true }],
			MaskedPaths: masked ?? ["/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list", "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware"],
			ReadonlyPaths: readonly ?? ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
		},
		Mounts: [{ Type: "bind", Source: daemonPath, Destination: "/opt/agentrun/computerd", Mode: "", RW: false, Propagation: "rprivate" }],
		NetworkSettings: { Networks: { [network]: {} } },
	};
}

/** A container as docker inspect reports it, made the way DockerProvider.create makes one; a null deadline is no label. */
export function container({ name, labels = {}, network = "none", running = true, deadline = new Date(Date.now() + 600_000).toISOString(), computer = true, ...rest }) {
	const all = { ...labels };
	if (computer) all["agentrun.computer"] = "1";
	if (computer && deadline !== null) all["agentrun.computer.deadline"] = deadline;
	return report({ id: idOf(name), name, labels: all, network, running, cmd: ["init", "--deadline", deadline ?? ""], ...rest });
}

/**
 * Options: `running` is what a new container's inspect reports; `gone` makes stop and rm answer "No such container";
 * `containers` are there from the start; `patch` is merged over each new container (to make drift); `hello` over the
 * daemon's hello; `arch` is the architecture docker info reports, and `info` is merged over the rest of what it reports
 * (every limit enforced, seccomp builtin, no AppArmor); `vanish` names are listed by ps but gone by inspect; `noDaemon`
 * makes exec fail as when the daemon is missing; `user` is the provider's user option; `hold` names steps ("inspect",
 * "info", "hello") that wait, once called, until `proceed(step)`.
 */
export function fakeDocker({ running = true, gone = false, containers = [], patch = {}, hello = {}, arch = "x86_64", info = {}, vanish = [], noDaemon = false, user, hold = [] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "computer-fake-docker-"));
	dirs.push(dir);
	const log = join(dir, "calls.jsonl");
	const state = join(dir, "containers.json");
	const daemonPath = join(dir, "computerd");
	writeFileSync(state, JSON.stringify(containers).replaceAll(JSON.stringify(DAEMON), JSON.stringify(daemonPath)));
	writeFileSync(daemonPath, "not a real daemon");
	chmodSync(daemonPath, 0o755);
	const program = join(dir, "docker");
	const config = JSON.stringify({ dir, log, state, running, gone, patch, hello: { ...HELLO, ...hello },
		info: { Architecture: arch, SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"], MemoryLimit: true, SwapLimit: true, PidsLimit: true, CPUCfsQuota: true, CPUCfsPeriod: true, ...info },
		vanish, noDaemon, hold });
	writeFileSync(
		program,
		`#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const config = ${config};
const report = ${report.toString()};
const args = process.argv.slice(2);
appendFileSync(config.log, JSON.stringify(args) + "\\n");
const load = () => JSON.parse(readFileSync(config.state, "utf8"));
const save = (all) => writeFileSync(config.state, JSON.stringify(all));
const find = (all, key) => all.find((c) => c.Name === "/" + key) ?? all.find((c) => /^[0-9a-f]{12,64}$/.test(key) && c.Id.startsWith(key));
const noSuch = (key) => { process.stderr.write("Error response from daemon: No such container: " + key + "\\n"); process.exit(1); };
// A held step waits for its proceed file, at most a minute.
const held = (step, then) => {
	if (!config.hold.includes(step)) return then();
	const bound = Date.now() + 60_000;
	const timer = setInterval(() => {
		if (!existsSync(config.dir + "/proceed-" + step) && Date.now() < bound) return;
		clearInterval(timer);
		then();
	}, 20);
};
const pick = (value, path) => path.split(".").filter(Boolean).reduce((at, key) => (at == null ? undefined : at[key]), value);
const render = (format, found) =>
	format.replace(/\\{\\{(json )?([.A-Za-z]+)\\}\\}/g, (_, json, path) => (json ? JSON.stringify(pick(found, path) ?? null) : String(pick(found, path) ?? "")));
const merge = (base, over) => {
	for (const [key, value] of Object.entries(over)) {
		base[key] = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" ? merge(base[key], value) : value;
	}
	return base;
};
switch (args[0]) {
	case "run": {
		const flags = {};
		let i = 1;
		for (; i < args.length && args[i].startsWith("--"); i += args[i] === "--detach" ? 1 : 2) (flags[args[i]] ??= []).push(args[i + 1]);
		const name = flags["--name"][0];
		const labels = Object.fromEntries(flags["--label"].map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
		const mount = Object.fromEntries(flags["--mount"][0].split(",").map((p) => p.split("=")));
		const network = flags["--network"][0];
		const memory = flags["--memory"] ? Number.parseInt(flags["--memory"][0], 10) * 1024 * 1024 : 0;
		const swap = flags["--memory-swap"] ? Number.parseInt(flags["--memory-swap"][0], 10) * 1024 * 1024 : 0;
		const made = report({
			id: createHash("sha256").update(name).digest("hex"), name, image: args[i], labels, cmd: args.slice(i + 1), user: flags["--user"]?.[0] ?? "", workdir: flags["--workdir"]?.[0] ?? "",
			env: flags["--env"] ?? [], network, running: config.running, capDrop: flags["--cap-drop"], securityOpt: flags["--security-opt"], pids: Number(flags["--pids-limit"][0]),
			memory, swap, period: Number(flags["--cpu-period"]?.[0] ?? 0), quota: Number(flags["--cpu-quota"]?.[0] ?? 0),
			tmpfs: Object.fromEntries((flags["--tmpfs"] ?? []).map((t) => [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)])),
			ipc: flags["--ipc"]?.[0] ?? "private", cgroupns: flags["--cgroupns"]?.[0] ?? "private", daemonPath: mount.src,
			apparmor: config.info.SecurityOptions.some((option) => option.startsWith("name=apparmor")),
		});
		made.HostConfig.Mounts[0].ReadOnly = "readonly" in mount;
		made.Mounts[0].RW = !("readonly" in mount);
		if (!config.running) Object.assign(made.State, { ExitCode: 127, Error: "exec format error" });
		if (flags["--cpus"]) made.HostConfig.NanoCpus = Math.round(Number(flags["--cpus"][0]) * 1e9);
		save([...load(), merge(made, config.patch)]);
		process.stdout.write(made.Id + "\\n");
		break;
	}
	case "inspect": held("inspect", () => {
		const all = load();
		let missing;
		for (const key of args.slice(5)) {
			const found = config.vanish.includes(key) ? undefined : find(all, key);
			if (found) process.stdout.write(render(args[4], found) + "\\n");
			else missing = key;
		}
		if (missing) noSuch(missing);
	}); break;
	case "ps": {
		const filters = args.flatMap((arg, i) => (arg === "--filter" ? [args[i + 1].slice("label=".length)] : []));
		for (const c of load()) {
			const has = filters.every((f) => c.Config.Labels[f.slice(0, f.indexOf("="))] === f.slice(f.indexOf("=") + 1));
			if (has) process.stdout.write((config.vanish.includes(c.Name.slice(1)) ? c.Name.slice(1) : c.Id) + "\\n");
		}
		break;
	}
	case "stop": case "rm": {
		if (config.gone) noSuch(args.at(-1));
		const all = load();
		const found = find(all, args.at(-1));
		if (args[0] === "rm") save(all.filter((c) => c !== found));
		else if (found) { found.State.Running = false; save(all); }
		process.stdout.write(args.at(-1) + "\\n");
		break;
	}
	case "info": held("info", () => process.stdout.write(args[1] === "--format" ? render(args[2], config.info) + "\\n" : JSON.stringify(config.info) + "\\n")); break;
	case "exec": {
		if (config.noDaemon) { process.stderr.write("OCI runtime exec failed: no such file or directory\\n"); process.exit(126); }
		let buffered = "";
		process.stdin.on("data", (chunk) => {
			buffered += chunk;
			let at;
			while ((at = buffered.indexOf("\\n")) >= 0) {
				const request = JSON.parse(buffered.slice(0, at));
				buffered = buffered.slice(at + 1);
				if (request.method === "hello") held("hello", () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: config.hello }) + "\\n"));
				if (request.method === "ping") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
			}
		});
		process.stdin.on("end", () => process.exit(0));
		break;
	}
	default: process.stderr.write("unexpected docker call\\n"); process.exit(2);
}
`,
		{ mode: 0o755 },
	);
	const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
	const names = () => JSON.parse(readFileSync(state, "utf8")).map((c) => c.Name.slice(1));
	const proceed = (step) => writeFileSync(join(dir, `proceed-${step}`), "");
	return { provider: new DockerProvider({ daemonPath, docker: program, ...(user === undefined ? {} : { user }) }), calls, names, daemonPath, proceed };
}

/** The value after each occurrence of a flag. */
export const valuesOf = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
