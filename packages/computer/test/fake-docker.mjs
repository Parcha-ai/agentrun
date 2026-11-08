// A fake docker program under a temp dir, for DockerProvider's unit tests: it records each call's argv, keeps its
// containers in a JSON file, and answers run, inspect, ps, stop, rm, info and exec (with the daemon's hello) as the
// docker CLI does. An inspect --format renders each {{json .Path}} in it. No Docker and no daemon binary are needed.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
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
	tmpfs, ipc = "private", cgroupns = "private", daemonPath = "@daemon", apparmor = false, masked, readonly, binds = [], volumes = [],
}) {
	// Each further --mount, after the daemon's, as Docker 29 reports it: a bind, or a named volume; ReadOnly only when it is.
	const hostBinds = [
		...binds.map((b) => ({ Type: "bind", Source: b.src, Target: b.dst, ...(b.readonly ? { ReadOnly: true } : {}) })),
		...volumes.map((v) => ({ Type: "volume", Source: v.src, Target: v.dst, ...(v.readonly ? { ReadOnly: true } : {}) })),
	];
	const mountBinds = [
		...binds.map((b) => ({ Type: "bind", Source: b.src, Destination: b.dst, Mode: "", RW: !b.readonly, Propagation: "rprivate" })),
		...volumes.map((v) => ({ Type: "volume", Name: v.src, Source: `/var/lib/docker/volumes/${v.src}/_data`, Destination: v.dst, Driver: "local", Mode: "z", RW: !v.readonly, Propagation: "" })),
	];
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
			Mounts: [{ Type: "bind", Source: daemonPath, Target: "/opt/agentrun/computerd", ReadOnly: true }, ...hostBinds],
			MaskedPaths: masked ?? ["/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list", "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware"],
			ReadonlyPaths: readonly ?? ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
		},
		Mounts: [{ Type: "bind", Source: daemonPath, Destination: "/opt/agentrun/computerd", Mode: "", RW: false, Propagation: "rprivate" }, ...mountBinds],
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
 * What Docker 29 inspect reports for a computer's egress proxy container, made as DockerProvider.create makes one.
 * Self-contained: the fake docker program runs a copy of it for each docker run of a proxy.
 */
export function proxyReport({
	id, name, image = "node:22.23.4-bookworm-slim", labels = {}, entrypoint = ["node"], cmd, user = "1000:1000", running = true, exitCode = 0, network = "bridge", capDrop = ["ALL"], securityOpt = ["no-new-privileges"],
	readonlyRootfs = true, privileged = false, mounts = [], logs = "", memory = 256 * 1024 * 1024, swap = memory, pids = 64, ipc = "private", cgroupns = "private",
	logConfig = { Type: "json-file", Config: { "max-file": "2", "max-size": "1m" } }, period = 100_000, quota = 50_000, ulimits = [{ Name: "nofile", Hard: 1024, Soft: 1024 }],
	created = "2026-01-01T00:00:00.000000000Z",
}) {
	return {
		Id: id,
		Name: `/${name}`,
		Created: created,
		State: { Running: running, Status: running ? "running" : "exited", ExitCode: running ? 0 : exitCode, Error: "" },
		Config: { User: user, Image: image, Entrypoint: entrypoint, Cmd: cmd, Labels: labels, Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "NODE_VERSION=22.23.4"] },
		HostConfig: {
			NetworkMode: network, CapDrop: capDrop, CapAdd: null, Privileged: privileged, SecurityOpt: securityOpt, ReadonlyRootfs: readonlyRootfs, PortBindings: {}, PublishAllPorts: false,
			Binds: null, VolumesFrom: null, Devices: [], PidMode: "", UsernsMode: "", IpcMode: ipc, CgroupnsMode: cgroupns, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
			Memory: memory, MemorySwap: swap, PidsLimit: pids, LogConfig: logConfig, CpuPeriod: period, CpuQuota: quota, Ulimits: ulimits,
			Mounts: mounts.map((m) => ({ Type: m.type, Source: m.src, Target: m.dst, ...(m.readonly ? { ReadOnly: true } : {}) })),
		},
		Mounts: mounts.map((m) =>
			m.type === "volume"
				? { Type: "volume", Name: m.src, Source: `/var/lib/docker/volumes/${m.src}/_data`, Destination: m.dst, Driver: "local", Mode: "z", RW: !m.readonly, Propagation: "" }
				: { Type: "bind", Source: m.src, Destination: m.dst, Mode: "", RW: !m.readonly, Propagation: "rprivate" },
		),
		NetworkSettings: { Networks: { [network]: {} } },
		Logs: logs,
	};
}

/** The proxy code's two binds, as the provider makes them: this package's dist/docker and its package.json. */
export const CODE_DIR = fileURLToPath(new URL("../dist/docker", import.meta.url));
export const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

/**
 * A computer with network allow as DockerProvider.create makes one, seeded: the computer, its proxy container and its
 * volume. `proxy` is merged over the proxy's report fields (to make it drift), or null leaves the proxy out.
 */
export function allowed({ name, allow, deadline = new Date(Date.now() + 600_000).toISOString(), labels = {}, user = "1000:1000", running = true, proxy = {}, local = [] }) {
	const volume = `${name}-egress`;
	const computer = container({
		name, labels, deadline, user, running, cmd: ["init", "--deadline", deadline, "--egress", "/opt/agentrun/egress/egress.sock"],
		volumes: [{ src: volume, dst: "/opt/agentrun/egress", readonly: true }],
	});
	const cmd = ["/code/docker/egress-main.js", "--socket", "/egress/egress.sock", "--deadline", deadline, "--allow", allow.join(","), ...(local.length ? ["--local", local.join(",")] : [])];
	const made = proxy === null ? [] : [proxyReport({
		id: idOf(volume), name: volume, user, running, cmd, labels: { ...labels, "agentrun.computer.egress": name, "agentrun.computer.deadline": deadline },
		mounts: [{ type: "volume", src: volume, dst: "/egress" }, { type: "bind", src: CODE_DIR, dst: "/code/docker", readonly: true }, { type: "bind", src: PACKAGE_JSON, dst: "/code/package.json", readonly: true }],
		...proxy,
	})];
	return { containers: [computer, ...made], volumes: [egressVolume({ computer: name, deadline, labels })] };
}

/** A computer's egress volume as `docker volume inspect` reports it: its labels (the computer's, its deadline, the
 *  spec's) and when it was made. */
export function egressVolume({ computer, deadline = new Date(Date.now() + 600_000).toISOString(), labels = {}, created = "2026-01-01T00:00:00Z" }) {
	return { Name: `${computer}-egress`, Labels: { ...labels, "agentrun.computer.egress": computer, "agentrun.computer.deadline": deadline }, CreatedAt: created, Driver: "local" };
}

/**
 * Options: `running` is what a new container's inspect reports; `gone` makes stop and rm answer "No such container";
 * `containers` are there from the start; `patch` is merged over each new container (to make drift); `hello` over the
 * daemon's hello; `arch` is the architecture docker info reports, and `info` is merged over the rest of what it reports
 * (every limit enforced, seccomp builtin, no AppArmor); `vanish` names are listed by ps but gone by inspect; `noDaemon`
 * makes exec fail as when the daemon is missing; `user` is the provider's user option; `hold` names steps ("inspect",
 * "info", "hello", "logs") that wait, once called, until `proceed(step)`. `desktop` is the provider's desktop option; `display`
 * is what the daemon's display does once process.start runs its X server: "up" (hello reports kind desktop and the
 * display's groups from then on), "exits" (the server ends at once, saying why on stderr), "never", or "stalls" (the
 * daemon answers nothing once the server is started, as one stuck in the X connection setup, or stopped, does).
 * `binds` is merged over each bind docker run makes after the daemon's ({ src } binds another folder, { readonly: true }
 * binds it read-only), or "drop" makes none: a Docker that does not bind what it was asked to.
 * `volumes` are there from the start ({ Name, Labels }); `egress` is what a new egress proxy does: "ready" (it logs its
 * ready line), "never" (it runs and never says it is ready) or "exits" (it ends at once, saying why); `proxyPatch` is
 * merged over each new proxy's report; `egressOptions` is the provider's egress option. `endpoint` is the daemon
 * `docker context inspect` names (a local unix socket by default), or null when it fails.
 */
export function fakeDocker({ running = true, gone = false, containers = [], patch = {}, hello = {}, arch = "x86_64", info = {}, vanish = [], noDaemon = false, user, hold = [], desktop, display = "up", binds = {}, volumes = [], egress = "ready", proxyPatch = {}, egressOptions, endpoint = "unix:///var/run/docker.sock" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "computer-fake-docker-"));
	dirs.push(dir);
	const log = join(dir, "calls.jsonl");
	const state = join(dir, "containers.json");
	const volumeState = join(dir, "volumes.json");
	const daemonPath = join(dir, "computerd");
	writeFileSync(state, JSON.stringify(containers).replaceAll(JSON.stringify(DAEMON), JSON.stringify(daemonPath)));
	writeFileSync(volumeState, JSON.stringify(volumes));
	writeFileSync(daemonPath, "not a real daemon");
	chmodSync(daemonPath, 0o755);
	const program = join(dir, "docker");
	const config = JSON.stringify({ dir, log, state, volumeState, running, gone, patch, binds, egress, proxyPatch, endpoint, hello: { ...HELLO, ...hello },
		info: { Architecture: arch, SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"], MemoryLimit: true, SwapLimit: true, PidsLimit: true, CPUCfsQuota: true, CPUCfsPeriod: true, ...info },
		vanish, noDaemon, hold, display, desktopHello: { ...HELLO, ...hello, kind: "desktop", groups: [...HELLO.groups, "screen", "input.pointer", "input.keys"] } });
	writeFileSync(
		program,
		`#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const config = ${config};
const report = ${report.toString()};
const proxyReport = ${proxyReport.toString()};
const args = process.argv.slice(2);
appendFileSync(config.log, JSON.stringify(args) + "\\n");
const load = () => JSON.parse(readFileSync(config.state, "utf8"));
const save = (all) => writeFileSync(config.state, JSON.stringify(all));
const loadVolumes = () => JSON.parse(readFileSync(config.volumeState, "utf8"));
const saveVolumes = (all) => writeFileSync(config.volumeState, JSON.stringify(all));
const labelFilters = () => args.flatMap((arg, i) => (arg === "--filter" && args[i + 1].startsWith("label=") ? [args[i + 1].slice("label=".length)] : []));
// A filter of a label's name alone (label=k) asks only that the label is there.
const hasLabels = (labels) => labelFilters().every((f) => (f.includes("=") ? (labels ?? {})[f.slice(0, f.indexOf("="))] === f.slice(f.indexOf("=") + 1) : Object.hasOwn(labels ?? {}, f)));
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
		for (; i < args.length && args[i].startsWith("--"); i += args[i] === "--detach" || args[i] === "--read-only" ? 1 : 2) (flags[args[i]] ??= []).push(args[i + 1]);
		const name = flags["--name"][0];
		const labels = Object.fromEntries(flags["--label"].map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
		const parsed = flags["--mount"].map((m) => Object.fromEntries(m.split(",").map((p) => (p.includes("=") ? [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] : [p, ""]))));
		if (flags["--entrypoint"]?.[0] === "node") {
			// An egress proxy: config.egress says whether it says it is ready, never does, or ends at once.
			const ends = config.egress === "exits";
			const made = proxyReport({
				id: createHash("sha256").update(name).digest("hex"), name, image: args[i], labels, entrypoint: ["node"], cmd: args.slice(i + 1), user: flags["--user"]?.[0] ?? "",
				running: !ends, exitCode: ends ? 2 : 0, network: flags["--network"]?.[0] ?? "default", capDrop: flags["--cap-drop"], securityOpt: flags["--security-opt"], readonlyRootfs: "--read-only" in flags,
				mounts: parsed.map((m) => ({ type: m.type, src: m.src, dst: m.dst, readonly: "readonly" in m })),
				memory: Number.parseInt(flags["--memory"]?.[0] ?? "0", 10) * 1024 * 1024, swap: Number.parseInt(flags["--memory-swap"]?.[0] ?? "0", 10) * 1024 * 1024,
				pids: Number(flags["--pids-limit"]?.[0] ?? 0), ipc: flags["--ipc"]?.[0] ?? "", cgroupns: flags["--cgroupns"]?.[0] ?? "",
				logConfig: { Type: flags["--log-driver"]?.[0] ?? "json-file", Config: Object.fromEntries((flags["--log-opt"] ?? []).map((o) => [o.slice(0, o.indexOf("=")), o.slice(o.indexOf("=") + 1)])) },
				period: Number(flags["--cpu-period"]?.[0] ?? 0), quota: Number(flags["--cpu-quota"]?.[0] ?? 0), created: new Date().toISOString(),
				ulimits: (flags["--ulimit"] ?? []).map((u) => { const [n, limits] = u.split("="); const [soft, hard = soft] = limits.split(":").map(Number); return { Hard: hard, Name: n, Soft: soft }; }),
				logs: config.egress === "ready" ? "egress ready allow=" + args[args.indexOf("--allow") + 1] + "\\n" : ends ? "egress: no host list, so the proxy does not start\\n" : "",
			});
			save([...load(), merge(made, config.proxyPatch)]);
			process.stdout.write(made.Id + "\\n");
			break;
		}
		const [mount, ...more] = parsed;
		// config.binds is merged over each further bind as Docker made it, or "drop" leaves them out: a Docker that does
		// not bind what it was asked to.
		const binds = config.binds === "drop" ? [] : more.filter((m) => m.type === "bind").map((m) => ({ src: m.src, dst: m.dst, readonly: "readonly" in m, ...config.binds }));
		const volumes = more.filter((m) => m.type === "volume").map((m) => ({ src: m.src, dst: m.dst, readonly: "readonly" in m }));
		const network = flags["--network"][0];
		const memory = flags["--memory"] ? Number.parseInt(flags["--memory"][0], 10) * 1024 * 1024 : 0;
		const swap = flags["--memory-swap"] ? Number.parseInt(flags["--memory-swap"][0], 10) * 1024 * 1024 : 0;
		const made = report({
			id: createHash("sha256").update(name).digest("hex"), name, image: args[i], labels, cmd: args.slice(i + 1), user: flags["--user"]?.[0] ?? "", workdir: flags["--workdir"]?.[0] ?? "",
			env: flags["--env"] ?? [], network, running: config.running, capDrop: flags["--cap-drop"], securityOpt: flags["--security-opt"], pids: Number(flags["--pids-limit"][0]),
			memory, swap, period: Number(flags["--cpu-period"]?.[0] ?? 0), quota: Number(flags["--cpu-quota"]?.[0] ?? 0),
			tmpfs: Object.fromEntries((flags["--tmpfs"] ?? []).map((t) => [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)])),
			ipc: flags["--ipc"]?.[0] ?? "private", cgroupns: flags["--cgroupns"]?.[0] ?? "private", daemonPath: mount.src,
			apparmor: config.info.SecurityOptions.some((option) => option.startsWith("name=apparmor")), binds, volumes,
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
		const names = args.includes("{{.Names}}");
		for (const c of load()) {
			if (hasLabels(c.Config.Labels)) process.stdout.write((names || config.vanish.includes(c.Name.slice(1)) ? c.Name.slice(1) : c.Id) + "\\n");
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
	case "context": {
		if (args[1] !== "inspect") { process.stderr.write("unexpected docker context call\\n"); process.exit(2); }
		if (config.endpoint === null) { process.stderr.write("context \\"elsewhere\\": context not found\\n"); process.exit(1); }
		process.stdout.write(JSON.stringify(config.endpoint) + "\\n");
		break;
	}
	case "logs": held("logs", () => {
		const found = find(load(), args.at(-1));
		if (!found) noSuch(args.at(-1));
		process.stdout.write(found.Logs ?? "");
	}); break;
	case "volume": {
		const all = loadVolumes();
		if (args[1] === "create") {
			const name = args.at(-1);
			const labels = Object.fromEntries(args.flatMap((arg, i) => (arg === "--label" ? [args[i + 1]] : [])).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
			const options = args.flatMap((arg, i) => (arg === "--opt" ? [args[i + 1]] : []));
			if (!all.some((v) => v.Name === name)) saveVolumes([...all, { Name: name, Labels: labels, Options: options, CreatedAt: new Date().toISOString().replace(/\\.\\d+Z$/, "Z"), Driver: "local" }]);
			process.stdout.write(name + "\\n");
		} else if (args[1] === "inspect") {
			let missing;
			for (const name of args.slice(4)) {
				const found = all.find((v) => v.Name === name);
				if (found) process.stdout.write(JSON.stringify(found) + "\\n");
				else missing = name;
			}
			if (missing) { process.stderr.write("Error response from daemon: get " + missing + ": no such volume\\n"); process.exit(1); }
		} else if (args[1] === "ls") {
			for (const v of all) if (hasLabels(v.Labels)) process.stdout.write(v.Name + "\\n");
		} else if (args[1] === "rm") {
			const names = args.slice(2).filter((arg) => !arg.startsWith("--"));
			saveVolumes(all.filter((v) => !names.includes(v.Name)));
			for (const name of names) process.stdout.write(name + "\\n");
		} else { process.stderr.write("unexpected docker volume call\\n"); process.exit(2); }
		break;
	}
	case "exec": {
		if (config.noDaemon) { process.stderr.write("OCI runtime exec failed: no such file or directory\\n"); process.exit(126); }
		let buffered = "";
		process.stdin.on("data", (chunk) => {
			buffered += chunk;
			let at;
			while ((at = buffered.indexOf("\\n")) >= 0) {
				const request = JSON.parse(buffered.slice(0, at));
				buffered = buffered.slice(at + 1);
				const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
				if (config.display === "stalls" && existsSync(config.dir + "/started.jsonl")) continue;
				const up = existsSync(config.dir + "/display-up");
				if (request.method === "hello") held("hello", () => answer(up ? config.desktopHello : config.hello));
				if (request.method === "ping") answer({});
				// The X server: process.start records its argv; the display is up from then on when config.display is "up".
				if (request.method === "process.start") {
					appendFileSync(config.dir + "/started.jsonl", JSON.stringify(request.params) + "\\n");
					if (config.display === "up") writeFileSync(config.dir + "/display-up", "");
					answer({ id: "p1", pid: 42 });
				}
				const exited = config.display === "exits";
				if (request.method === "process.wait") answer({ running: !exited, exitCode: exited ? 1 : null, signal: null });
				if (request.method === "process.read") {
					const data = exited && request.params.offset === 0 ? Buffer.from("(EE) Fatal server error:\\n(EE) no screens found\\n").toString("base64") : "";
					answer({ data, nextOffset: Buffer.from(data, "base64").length, dropped: 0, exited });
				}
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
	const started = () => (existsSync(join(dir, "started.jsonl")) ? readFileSync(join(dir, "started.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
	const volumeNames = () => JSON.parse(readFileSync(volumeState, "utf8")).map((v) => v.Name);
	/** Changes a container in the fake's state, by name: what Docker would do under the provider (a proxy that crashed). */
	const alter = (name, change) => {
		const all = JSON.parse(readFileSync(state, "utf8"));
		change(all.find((c) => c.Name === `/${name}`));
		writeFileSync(state, JSON.stringify(all));
	};
	// The host the provider looks at for a container's signs is a clean fake root, so these tests run the same inside a
	// container; egressOptions.hostRoot replaces it.
	const hostRoot = join(dir, "host-root");
	mkdirSync(hostRoot);
	const options = { daemonPath, docker: program, ...(user === undefined ? {} : { user }), ...(desktop === undefined ? {} : { desktop }), egress: { hostRoot, ...egressOptions } };
	return { provider: new DockerProvider(options), calls, names, volumeNames, alter, daemonPath, proceed, started };
}

/** The docker calls that delete computer `name` with nothing else of its own: rm it, then look for its egress proxy and
 *  its volume by their label, and find none. */
export const removal = (name) => [
	["rm", "--force", "--volumes", name],
	["ps", "-a", "--no-trunc", "--filter", `label=agentrun.computer.egress=${name}`, "--format", "{{.ID}}"],
	["volume", "ls", "--filter", `label=agentrun.computer.egress=${name}`, "--format", "{{.Name}}"],
];

/** The value after each occurrence of a flag. */
export const valuesOf = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
