// A fake docker program under a temp dir, for DockerProvider's unit tests: it records each call's argv, keeps its
// containers in a JSON file, and answers run, inspect, ps, stop, rm, info and exec (with the daemon's hello) as the
// docker CLI does. No Docker and no daemon binary are needed.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { DockerProvider } from "../dist/index.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const HELLO = { version: VERSION, os: "linux", arch: "amd64", capabilities: ["exec", "files", "processes"] };

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export const idOf = (name) => createHash("sha256").update(name).digest("hex");

/** A container as docker inspect reports it, made the way DockerProvider.create makes one; a null deadline is no label. */
export function container({ name, labels = {}, network = "none", running = true, deadline = new Date(Date.now() + 600_000).toISOString(), computer = true }) {
	const all = { ...labels };
	if (computer) all["agentrun.computer"] = "1";
	if (computer && deadline !== null) all["agentrun.computer.deadline"] = deadline;
	return {
		Id: idOf(name),
		Name: `/${name}`,
		State: { Running: running, Status: running ? "running" : "exited", ExitCode: 0, Error: "" },
		Config: { User: "1000:1000", Entrypoint: ["/opt/agentrun/computerd"], Cmd: ["init", "--deadline", deadline ?? ""], Labels: all },
		HostConfig: {
			NetworkMode: network, CapDrop: ["ALL"], CapAdd: null, Privileged: false, SecurityOpt: ["no-new-privileges"], PidsLimit: 1024,
			Memory: 4096 * 1024 * 1024, MemorySwap: 4096 * 1024 * 1024, CpuPeriod: 100_000, CpuQuota: 200_000,
			Tmpfs: { "/work": "rw,nosuid,nodev,exec,uid=1000,gid=1000,mode=0700", "/run/agentrun": "rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700" },
		},
		Mounts: [{ Type: "bind", Source: "/data/computerd", Destination: "/opt/agentrun/computerd", RW: false }],
		NetworkSettings: { Networks: { [network]: {} } },
	};
}

/**
 * Options: `running` is what a new container's inspect reports; `gone` makes stop and rm answer "No such container";
 * `containers` are there from the start; `patch` is merged over each new container (to make drift); `hello` over the
 * daemon's hello; `arch` is what docker info reports; `vanish` names are listed by ps but gone by inspect; `noDaemon`
 * makes exec fail as when the daemon is missing; `user` is the provider's user option.
 */
export function fakeDocker({ running = true, gone = false, containers = [], patch = {}, hello = {}, arch = "x86_64", vanish = [], noDaemon = false, user } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "computer-fake-docker-"));
	dirs.push(dir);
	const log = join(dir, "calls.jsonl");
	const state = join(dir, "containers.json");
	writeFileSync(state, JSON.stringify(containers));
	const daemonPath = join(dir, "computerd");
	writeFileSync(daemonPath, "not a real daemon");
	chmodSync(daemonPath, 0o755);
	const program = join(dir, "docker");
	const config = JSON.stringify({ log, state, running, gone, patch, hello: { ...HELLO, ...hello }, arch, vanish, noDaemon });
	writeFileSync(
		program,
		`#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const config = ${config};
const args = process.argv.slice(2);
appendFileSync(config.log, JSON.stringify(args) + "\\n");
const load = () => JSON.parse(readFileSync(config.state, "utf8"));
const save = (all) => writeFileSync(config.state, JSON.stringify(all));
const find = (all, key) => all.find((c) => c.Name === "/" + key) ?? all.find((c) => /^[0-9a-f]{12,64}$/.test(key) && c.Id.startsWith(key));
const noSuch = (key) => { process.stderr.write("Error response from daemon: No such container: " + key + "\\n"); process.exit(1); };
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
		const made = {
			Id: createHash("sha256").update(name).digest("hex"),
			Name: "/" + name,
			State: { Running: config.running, Status: config.running ? "running" : "exited", ExitCode: config.running ? 0 : 127, Error: config.running ? "" : "exec format error" },
			Config: { User: flags["--user"]?.[0] ?? "", Entrypoint: flags["--entrypoint"], Cmd: args.slice(i + 1), Labels: labels },
			HostConfig: {
				NetworkMode: network, CapDrop: flags["--cap-drop"], CapAdd: null, Privileged: false, SecurityOpt: flags["--security-opt"],
				PidsLimit: Number(flags["--pids-limit"][0]), Memory: memory, MemorySwap: swap, NanoCpus: flags["--cpus"] ? Math.round(Number(flags["--cpus"][0]) * 1e9) : 0,
				CpuPeriod: Number(flags["--cpu-period"]?.[0] ?? 0), CpuQuota: Number(flags["--cpu-quota"]?.[0] ?? 0),
				Tmpfs: Object.fromEntries((flags["--tmpfs"] ?? []).map((t) => [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)])),
			},
			Mounts: [{ Type: mount.type, Source: mount.src, Destination: mount.dst, RW: !("readonly" in mount) }],
			NetworkSettings: { Networks: { [network]: {} } },
		};
		save([...load(), merge(made, config.patch)]);
		process.stdout.write(made.Id + "\\n");
		break;
	}
	case "inspect": {
		const all = load();
		let missing;
		for (const key of args.slice(5)) {
			const found = config.vanish.includes(key) ? undefined : find(all, key);
			if (found) process.stdout.write(JSON.stringify(found) + "\\n");
			else missing = key;
		}
		if (missing) noSuch(missing);
		break;
	}
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
	case "info": process.stdout.write(config.arch + "\\n"); break;
	case "exec": {
		if (config.noDaemon) { process.stderr.write("OCI runtime exec failed: no such file or directory\\n"); process.exit(126); }
		let buffered = "";
		process.stdin.on("data", (chunk) => {
			buffered += chunk;
			let at;
			while ((at = buffered.indexOf("\\n")) >= 0) {
				const request = JSON.parse(buffered.slice(0, at));
				buffered = buffered.slice(at + 1);
				if (request.method === "hello") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: config.hello }) + "\\n");
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
	return { provider: new DockerProvider({ daemonPath, docker: program, ...(user === undefined ? {} : { user }) }), calls, names, daemonPath };
}

/** The value after each occurrence of a flag. */
export const valuesOf = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
