import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import type { BoxSpec } from "../src/box/box.ts";
import { type DockerBoxesOptions, dockerBoxes } from "../src/box/docker.ts";

const context = BACKGROUND_CONTEXT;
// A program that does not exist: a spec that is refused must be refused before Docker is asked for anything.
const provider = dockerBoxes({ docker: "/nonexistent/pi-transport-docker" });

async function refusal(fields: Partial<BoxSpec>): Promise<string> {
	const refused = await provider.create({ maxLifetimeMs: 60_000, ...fields }, context);
	if (refused.ok) throw new Error("the spec was accepted");
	return refused.error.code;
}

describe("docker boxes: what is refused before Docker is asked", () => {
	it("refuses a snapshot, a region and an isolation a container cannot give", async () => {
		expect(await refusal({ snapshot: "s" })).toBe("unsupported");
		expect(await refusal({ region: "us" })).toBe("unsupported");
		expect(await refusal({ isolation: "vm" })).toBe("unsupported");
		expect(await refusal({ isolation: "gvisor" })).toBe("unsupported");
	});

	it("refuses an allowlist, a port and a capability as unsupported, and a malformed network or port as invalid", async () => {
		expect(await refusal({ network: { allow: ["example.com"] } })).toBe("unsupported");
		expect(await refusal({ ports: [8080] })).toBe("unsupported");
		expect(await refusal({ capabilities: ["fuse"] })).toBe("unsupported");
		expect(await refusal({ network: { allow: [] } })).toBe("invalid");
		expect(await refusal({ ports: [0] })).toBe("invalid");
	});

	it("passes network none to Docker as --network none, and an open network as nothing, and says so in the facts", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-docker-args-"));
		try {
			const log = join(directory, "args.log");
			const script = join(directory, "docker");
			writeFileSync(
				script,
				`#!/bin/sh\necho "$@" >> ${log}\necho 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n`,
				{ mode: 0o755 },
			);
			const fake = dockerBoxes({ docker: script });
			const none = await fake.create({ maxLifetimeMs: 60_000, network: "none" }, context);
			const open = await fake.create({ maxLifetimeMs: 60_000 }, context);
			const [first, second] = readFileSync(log, "utf8").trim().split("\n");
			expect(first).toContain("--network none");
			expect(second).not.toContain("--network");
			expect(none.ok && none.value.facts()).toMatchObject({
				network: "none",
				ports: [],
			});
			// What a docker box does not report stays absent, which a caller reads as unknown (see readFacts).
			for (const key of ["fuse", "ptraceScope", "diskGb"])
				expect(none.ok && none.value.facts()).not.toHaveProperty(key);
			expect(open.ok && open.value.facts().network).toBe("open");
			expect(open.ok && open.value.facts().startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses a label in the providers' own namespace, which would replace the box's stored facts", async () => {
		expect(await refusal({ labels: { "pi-transport.facts": '{"provider":"docker"}' } })).toBe("invalid");
		expect(await refusal({ labels: { "pi-transport.box": "0" } })).toBe("invalid");
		expect(await refusal({ labels: { "pi-transport": "1" } })).toBe("invalid");
	});

	it("refuses a lifetime that is not positive", async () => {
		expect(await refusal({ maxLifetimeMs: 0 })).toBe("invalid");
	});

	it("reports a docker program that cannot start as a spawn error, not a throw", async () => {
		const created = await provider.create({ maxLifetimeMs: 60_000 }, context);
		expect(created.ok).toBe(false);
		if (!created.ok) expect(created.error.code).toBe("spawn");
		const attached = await provider.attach("0123456789ab", context);
		expect(attached.ok).toBe(false);
	});
});

/**
 * A docker program that records its arguments, one a line, and answers `run` with a container id: nothing reaches a daemon. The
 * directory is canonical, as a mount's source must be.
 */
/** A scripted docker that logs each call's arguments, one per line, and answers as `docker run` does; `env` set in
 *  process.env while the provider is made (its daemon check reads it there), then put back. */
async function scripted(
	options: Omit<Parameters<typeof dockerBoxes>[0] & object, "docker">,
	env: Record<string, string | undefined>,
	use: (provider: ReturnType<typeof dockerBoxes>, directory: string, calls: () => string[][]) => Promise<void>,
): Promise<void> {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-transport-docker-caps-")));
	const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
	try {
		const log = join(directory, "args.log");
		const script = join(directory, "docker");
		writeFileSync(
			script,
			`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> ${log}\necho >> ${log}\necho 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n`,
			{ mode: 0o755 },
		);
		const calls = () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n\n")
						.filter((call) => call.trim() !== "")
						.map((call) => call.split("\n").filter((arg) => arg !== ""))
				: [];
		setEnv(env);
		const provider = dockerBoxes({ docker: script, ...options });
		setEnv(saved);
		await use(provider, directory, calls);
	} finally {
		setEnv(saved);
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Each of `env` set in process.env, or removed where undefined. */
function setEnv(env: Record<string, string | undefined>): void {
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

// No DOCKER_HOST, no DOCKER_CONTEXT, and a config directory with nothing in it: this machine's own daemon.
const LOCAL = {
	DOCKER_HOST: undefined,
	DOCKER_CONTEXT: undefined,
	DOCKER_CONFIG: "/nonexistent/pi-transport-docker-config",
};

describe("docker boxes: privileges", () => {
	it("with dropCapabilities, every box drops every capability and gains no privilege: --cap-drop ALL and no-new-privileges", () =>
		scripted({ dropCapabilities: true, user: "0:0" }, LOCAL, async (provider, _directory, calls) => {
			expect((await provider.create({ maxLifetimeMs: 60_000, network: "none" }, context)).ok).toBe(true);
			const [run] = calls();
			const at = (flag: string) => run!.flatMap((arg, i) => (arg === flag ? [run![i + 1]] : []));
			expect(at("--cap-drop")).toEqual(["ALL"]);
			expect(at("--security-opt")).toEqual(["no-new-privileges"]);
			expect(run!.indexOf("--cap-drop")).toBeLessThan(run!.indexOf("--entrypoint"));
		}));

	it("with dropCapabilities, attach ends a box made without it (an older version's) and finds none; it takes a hardened one, and without the option any", async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-transport-docker-attach-")));
		try {
			const log = join(directory, "args.log");
			const script = join(directory, "docker");
			// inspect answers the container in inspect.json; every call's arguments go to the log, one call a line.
			writeFileSync(
				script,
				`#!/bin/sh\necho "$@" >> ${log}\ncase "$1" in inspect) cat ${join(directory, "inspect.json")} ;; *) echo ok ;; esac\n`,
				{ mode: 0o755 },
			);
			const id = "f".repeat(64);
			const container = (hostConfig: object) =>
				writeFileSync(
					join(directory, "inspect.json"),
					JSON.stringify({
						Id: id,
						State: { Running: true, ExitCode: 0 },
						Config: {
							Labels: {
								"pi-transport.box": "1",
								"pi-transport.facts": JSON.stringify({ provider: "docker", workspace: "/work" }),
							},
						},
						HostConfig: hostConfig,
					}),
				);
			const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
			const hardenedBoxes = dockerBoxes({ docker: script, dropCapabilities: true });
			container({ NetworkMode: "none" });
			const old = await hardenedBoxes.attach(id, context);
			expect(old.ok && old.value).toBe(undefined);
			expect(calls().at(-1)).toBe(`rm --force --volumes ${id}`);
			container({ NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] });
			const current = await hardenedBoxes.attach(id, context);
			expect(current.ok && current.value?.id).toBe(id);
			expect(calls().filter((call) => call.startsWith("rm "))).toHaveLength(1);
			container({ NetworkMode: "none" });
			const plain = await dockerBoxes({ docker: script }).attach(id, context);
			expect(plain.ok && plain.value?.id, "without the option, a box is taken as it is").toBe(id);
			expect(calls().filter((call) => call.startsWith("rm "))).toHaveLength(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("without it, a box keeps Docker's default capabilities, as a box whose programs change user needs", () =>
		scripted({}, LOCAL, async (provider, _directory, calls) => {
			expect((await provider.create({ maxLifetimeMs: 60_000 }, context)).ok).toBe(true);
			expect(calls()[0]).not.toContain("--cap-drop");
			expect(calls()[0]).not.toContain("--security-opt");
		}));
});

describe("docker boxes: a daemon on another machine binds none of this machine's directories", () => {
	it("no DOCKER_HOST, or a unix socket, is this machine: mounts are bound", async () => {
		for (const host of [undefined, "", "unix:///var/run/docker.sock", "unix:///run/user/1000/docker.sock"]) {
			await scripted({}, { ...LOCAL, DOCKER_HOST: host }, async (provider) => {
				expect(provider.mounts, String(host)).toBe(true);
			});
		}
	});

	it("tcp://, ssh:// and any other DOCKER_HOST is another machine: mounts false, and a spec with mounts is refused before Docker is asked", async () => {
		for (const host of ["tcp://docker.example:2376", "ssh://builder@docker.example", "http://docker.example:2375"]) {
			await scripted({}, { ...LOCAL, DOCKER_HOST: host }, async (provider, directory, calls) => {
				expect(provider.mounts, host).toBe(false);
				const refused = await provider.create(
					{ maxLifetimeMs: 60_000, mounts: [{ source: directory, target: "/work" }] },
					context,
				);
				expect(refused.ok).toBe(false);
				expect(!refused.ok && refused.error.code).toBe("unsupported");
				expect(!refused.ok && refused.error.message).toBe(
					`the Docker daemon is not on this machine (DOCKER_HOST=${host}), so it cannot bind this machine's ${directory}: unset DOCKER_HOST to run boxes on this machine's Docker`,
				);
				expect(calls()).toEqual([]);
				// A spec with no mounts still runs there.
				expect((await provider.create({ maxLifetimeMs: 60_000 }, context)).ok).toBe(true);
			});
		}
	});

	it("a docker context other than default is read from its own record: a unix endpoint is this machine, any other or none it can read is not", async () => {
		const config = realpathSync(mkdtempSync(join(tmpdir(), "pi-transport-docker-config-")));
		try {
			const record = (name: string, host: string) => {
				const dir = join(config, "contexts", "meta", createHash("sha256").update(name).digest("hex"));
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "meta.json"),
					JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }),
				);
			};
			record("desktop", "unix:///run/user/1000/docker.sock");
			record("builder", "tcp://docker.example:2376");
			const mounts = async (env: Record<string, string | undefined>) => {
				const bound: (boolean | undefined)[] = [];
				await scripted({}, { ...LOCAL, DOCKER_CONFIG: config, ...env }, async (provider) => {
					bound.push(provider.mounts);
				});
				return bound[0];
			};
			expect(await mounts({ DOCKER_CONTEXT: "default" })).toBe(true);
			expect(await mounts({ DOCKER_CONTEXT: "desktop" })).toBe(true);
			expect(await mounts({ DOCKER_CONTEXT: "builder" })).toBe(false);
			expect(await mounts({ DOCKER_CONTEXT: "unknown" })).toBe(false);
			// The config's current context, when DOCKER_CONTEXT names none; DOCKER_HOST, set, wins over either.
			writeFileSync(join(config, "config.json"), JSON.stringify({ currentContext: "builder" }));
			expect(await mounts({})).toBe(false);
			expect(await mounts({ DOCKER_HOST: "unix:///var/run/docker.sock" })).toBe(true);
			writeFileSync(join(config, "config.json"), JSON.stringify({ currentContext: "desktop" }));
			expect(await mounts({})).toBe(true);
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});

	it("DOCKER_HOST and DOCKER_CONTEXT both set must both be this machine, whichever the CLI's version takes", async () => {
		const config = realpathSync(mkdtempSync(join(tmpdir(), "pi-transport-docker-config-")));
		try {
			for (const [name, host] of [
				["desktop", "unix:///run/user/1000/docker.sock"],
				["builder", "tcp://docker.example:2376"],
			]) {
				const dir = join(config, "contexts", "meta", createHash("sha256").update(name).digest("hex"));
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "meta.json"),
					JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }),
				);
			}
			const mounts = async (env: Record<string, string | undefined>) => {
				const bound: (boolean | undefined)[] = [];
				await scripted({}, { ...LOCAL, DOCKER_CONFIG: config, ...env }, async (provider) => {
					bound.push(provider.mounts);
				});
				return bound[0];
			};
			expect(await mounts({ DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "builder" })).toBe(false);
			expect(await mounts({ DOCKER_HOST: "tcp://docker.example:2376", DOCKER_CONTEXT: "desktop" })).toBe(false);
			expect(await mounts({ DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "desktop" })).toBe(true);
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});

	it("a daemon moved to another machine after the provider was made refuses the next spec with mounts, before Docker is asked", () =>
		scripted({}, LOCAL, async (provider, directory, calls) => {
			expect(provider.mounts).toBe(true);
			const saved = process.env.DOCKER_HOST;
			process.env.DOCKER_HOST = "ssh://builder@docker.example";
			try {
				const refused = await provider.create(
					{ maxLifetimeMs: 60_000, mounts: [{ source: directory, target: "/work" }] },
					context,
				);
				expect(!refused.ok && refused.error.code).toBe("unsupported");
				expect(!refused.ok && refused.error.message).toMatch(
					/^the Docker daemon is not on this machine \(DOCKER_HOST=ssh:\/\/builder@docker\.example\)/,
				);
				expect(calls()).toEqual([]);
			} finally {
				if (saved === undefined) delete process.env.DOCKER_HOST;
				else process.env.DOCKER_HOST = saved;
			}
		}));
});

async function withScriptedDocker(
	use: (provider: ReturnType<typeof dockerBoxes>, directory: string, calls: () => string[][]) => Promise<void>,
	options: Omit<DockerBoxesOptions, "docker"> = {},
): Promise<void> {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-transport-docker-mounts-")));
	try {
		const log = join(directory, "args.log");
		const script = join(directory, "docker");
		writeFileSync(
			script,
			`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> ${log}\necho >> ${log}\necho 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n`,
			{ mode: 0o755 },
		);
		const calls = () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n\n")
						.filter((call) => call.trim() !== "")
						.map((call) => call.split("\n").filter((arg) => arg !== ""))
				: [];
		await use(dockerBoxes({ ...options, docker: script }), directory, calls);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("docker boxes: mounts", () => {
	it("say the provider takes them", () => {
		expect(dockerBoxes({ docker: "/nonexistent/pi-transport-docker" }).mounts).toBe(true);
	});

	it("become --mount type=bind, read-only where asked, before the image, never -v", () =>
		withScriptedDocker(async (provider, directory, calls) => {
			const run = join(directory, "run");
			const learning = join(directory, "learning");
			mkdirSync(run);
			mkdirSync(learning);
			const made = await provider.create(
				{
					maxLifetimeMs: 60_000,
					mounts: [
						{ source: run, target: "/workspace/run" },
						{ source: learning, target: "/workspace/home/learning", readOnly: true },
					],
				},
				context,
			);
			if (!made.ok) throw made.error;
			const [args = []] = calls();
			expect(args[0]).toBe("run");
			const mounts = args.flatMap((arg, n) => (args[n - 1] === "--mount" ? [arg] : []));
			expect(mounts).toEqual([
				`type=bind,source=${run},target=/workspace/run`,
				`type=bind,source=${learning},target=/workspace/home/learning,readonly`,
			]);
			expect(args.lastIndexOf("--mount")).toBeLessThan(args.indexOf("--entrypoint"));
			for (const flag of ["-v", "--volume", "--volumes-from"]) expect(args).not.toContain(flag);
		}));

	it("are refused before docker run: a missing source, a relative path, a .. segment, a target of / and a repeated target", () =>
		withScriptedDocker(async (provider, directory, calls) => {
			const refusal = async (mounts: NonNullable<BoxSpec["mounts"]>) => {
				const refused = await provider.create({ maxLifetimeMs: 60_000, mounts }, context);
				if (refused.ok) throw new Error("the spec was accepted");
				return refused.error;
			};
			const missing = await refusal([{ source: join(directory, "absent"), target: "/workspace/run" }]);
			expect(missing.code).toBe("not_found");
			expect(missing.message).toBe(`the mount source ${join(directory, "absent")} does not exist on this machine`);
			const beneathAFile = join(directory, "args.txt");
			writeFileSync(beneathAFile, "");
			expect((await refusal([{ source: join(beneathAFile, "run"), target: "/workspace/run" }])).code).toBe(
				"not_found",
			);
			expect((await refusal([{ source: "data/run", target: "/workspace/run" }])).code).toBe("invalid");
			expect((await refusal([{ source: directory, target: "workspace/run" }])).code).toBe("invalid");
			expect((await refusal([{ source: `${directory}/../run`, target: "/workspace/run" }])).code).toBe("invalid");
			expect((await refusal([{ source: directory, target: "/workspace/../etc" }])).code).toBe("invalid");
			expect((await refusal([{ source: directory, target: "/" }])).code).toBe("invalid");
			expect(
				(
					await refusal([
						{ source: directory, target: "/workspace/run" },
						{ source: directory, target: "/workspace/run", readOnly: true },
					])
				).code,
			).toBe("invalid");
			expect(
				(await refusal(Array.from({ length: 9 }, (_, n) => ({ source: directory, target: `/workspace/${n}` }))))
					.code,
			).toBe("invalid");
			expect(calls()).toEqual([]);
		}));
});

describe("docker boxes: named volumes", () => {
	it("become --mount type=volume after the binds, read-only where asked, on every box", () =>
		withScriptedDocker(
			async (provider, directory, calls) => {
				const run = join(directory, "run");
				mkdirSync(run);
				const made = await provider.create(
					{ maxLifetimeMs: 60_000, network: "none", mounts: [{ source: run, target: "/workspace/run" }] },
					context,
				);
				if (!made.ok) throw made.error;
				const bare = await provider.create({ maxLifetimeMs: 60_000 }, context);
				if (!bare.ok) throw bare.error;
				for (const args of calls()) {
					const mounts = args.flatMap((arg, n) => (args[n - 1] === "--mount" ? [arg] : []));
					expect(mounts.at(-1)).toBe(
						"type=volume,source=agentrun-egress-0123456789ab,target=/run/agentrun/egress,readonly",
					);
					expect(args.lastIndexOf("--mount")).toBeLessThan(args.indexOf("--entrypoint"));
					for (const flag of ["-v", "--volume", "--volumes-from"]) expect(args).not.toContain(flag);
				}
				const [first = []] = calls();
				expect(first.flatMap((arg, n) => (first[n - 1] === "--mount" ? [arg] : []))[0]).toBe(
					`type=bind,source=${run},target=/workspace/run`,
				);
				expect(first[first.indexOf("--network") + 1]).toBe("none");
			},
			{ volumes: [{ name: "agentrun-egress-0123456789ab", target: "/run/agentrun/egress", readOnly: true }] },
		));

	it("refuse a name or target Docker's --mount cannot carry, at once, and a spec's bind on a volume's target", async () => {
		for (const name of ["", "-x", "a,b", "a/b", "a b", "a=b"]) {
			expect(() =>
				dockerBoxes({ docker: "/nonexistent/pi-transport-docker", volumes: [{ name, target: "/x" }] }),
			).toThrow(/^the docker volume name /);
		}
		for (const target of ["x", "/", "/a/../b", "/a,b", "/a/"]) {
			expect(() =>
				dockerBoxes({ docker: "/nonexistent/pi-transport-docker", volumes: [{ name: "v", target }] }),
			).toThrow(/^the docker volume v's target /);
		}
		await withScriptedDocker(
			async (provider, directory, calls) => {
				const refused = await provider.create(
					{ maxLifetimeMs: 60_000, mounts: [{ source: directory, target: "/x" }] },
					context,
				);
				expect(!refused.ok && [refused.error.code, refused.error.message]).toEqual([
					"invalid",
					"the mount target /x is a volume's",
				]);
				expect(calls()).toEqual([]);
			},
			{ volumes: [{ name: "v", target: "/x" }] },
		);
	});
});

/** Each resource flag of `args` with its value, in order: `--cpus`, `--memory`, `--memory-swap`, `--pids-limit` and any other. */
const limits = (args: readonly string[]) =>
	args.flatMap((arg, n) => (/^--(cpu|memory|pids)/.test(arg) ? [[arg, args[n + 1]]] : []));

describe("docker boxes: resource limits", () => {
	it("map cpus, memory and pidsLimit to the CFS quota --cpus sets, --memory and --memory-swap the same (so swap adds nothing) and --pids-limit, before the image, and say them in the facts", () =>
		withScriptedDocker(
			async (provider, _directory, calls) => {
				const made = await provider.create({ maxLifetimeMs: 60_000 }, context);
				if (!made.ok) throw made.error;
				const [args = []] = calls();
				// A quota, never --cpus: Docker checks --cpus against its own CPU count (a VM's), and a quota it does not.
				expect(limits(args)).toEqual([
					["--cpu-period", "100000"],
					["--cpu-quota", "150000"],
					["--memory", "4g"],
					["--memory-swap", "4g"],
					["--pids-limit", "512"],
				]);
				expect(args.indexOf("--pids-limit")).toBeLessThan(args.indexOf("--entrypoint"));
				expect(made.value.facts()).toMatchObject({ cpus: 1.5, memoryMb: 4096 });
			},
			{ cpus: 1.5, memory: "4g", pidsLimit: 512 },
		));

	it("give a quota of each CPU's 100 ms: 2 is 200000 µs, 1.5 is 150000, 0.01 (the least) is 1000", async () => {
		for (const [cpus, quota] of [
			[2, "200000"],
			[1.5, "150000"],
			[0.01, "1000"],
		] as const)
			await withScriptedDocker(
				async (provider, _directory, calls) => {
					const made = await provider.create({ maxLifetimeMs: 60_000 }, context);
					if (!made.ok) throw made.error;
					expect(limits(calls()[0] ?? [])).toEqual([
						["--cpu-period", "100000"],
						["--cpu-quota", quota],
					]);
					expect(calls()[0]).not.toContain("--cpus");
				},
				{ cpus },
			);
	});

	it("take memory as bytes too, and give Docker the same bytes", () =>
		withScriptedDocker(
			async (provider, _directory, calls) => {
				const made = await provider.create({ maxLifetimeMs: 60_000 }, context);
				if (!made.ok) throw made.error;
				expect(limits(calls()[0] ?? [])).toEqual([
					["--memory", "1073741824"],
					["--memory-swap", "1073741824"],
				]);
				expect(made.value.facts()).toMatchObject({ cpus: null, memoryMb: 1024 });
			},
			{ memory: 2 ** 30 },
		));

	it("refuse a spec's cpus too small for a quota as invalid, before Docker is asked: a quota of 0 would be no limit", () =>
		withScriptedDocker(async (provider, _directory, calls) => {
			for (const cpus of [0.000001, 0.005]) {
				const refused = await provider.create({ maxLifetimeMs: 60_000, cpus }, context);
				expect(refused.ok).toBe(false);
				if (!refused.ok) expect(refused.error.code).toBe("invalid");
			}
			expect(calls()).toEqual([]);
		}));

	it("give way to a spec's cpus and memoryMb, whose memory is then the swap's bound too; pidsLimit stays", () =>
		withScriptedDocker(
			async (provider, _directory, calls) => {
				const made = await provider.create({ maxLifetimeMs: 60_000, cpus: 1, memoryMb: 512 }, context);
				if (!made.ok) throw made.error;
				expect(limits(calls()[0] ?? [])).toEqual([
					["--cpu-period", "100000"],
					["--cpu-quota", "100000"],
					["--memory", "512m"],
					["--memory-swap", "512m"],
					["--pids-limit", "64"],
				]);
				expect(made.value.facts()).toMatchObject({ cpus: 1, memoryMb: 512 });
			},
			{ cpus: 2, memory: "4g", pidsLimit: 64 },
		));

	it("are none when no option or spec field names one", () =>
		withScriptedDocker(async (provider, _directory, calls) => {
			const made = await provider.create({ maxLifetimeMs: 60_000 }, context);
			if (!made.ok) throw made.error;
			expect(limits(calls()[0] ?? [])).toEqual([]);
			expect(made.value.facts()).toMatchObject({ cpus: null, memoryMb: null });
		}));

	it("refuse a value that is not positive, not a number or not a size, naming it, before any box", () => {
		const make = (options: Omit<DockerBoxesOptions, "docker">) => () =>
			dockerBoxes({ docker: "/nonexistent/pi-transport-docker", ...options });
		// A string as JSON, so an empty one shows; a number as JavaScript writes it (NaN, Infinity).
		const shown = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : String(value));
		// 0.01 is the least: a quota is at least 1 ms of each 100 ms period.
		for (const cpus of [0, -1, 0.001, 1e300, Number.NaN, Number.POSITIVE_INFINITY, "2" as unknown as number])
			expect(make({ cpus })).toThrow(`the docker cpus ${shown(cpus)} is not a number of CPUs of at least 0.01`);
		for (const memory of [0, -1, 1.5, Number.NaN, "", "0g", "-1g", "4x", "g", "4 g", "1e9"])
			expect(make({ memory })).toThrow(
				`the docker memory ${shown(memory)} is not a positive whole number of bytes, nor a size such as 512m or 4g`,
			);
		for (const pidsLimit of [0, -1, 1.5, Number.NaN, 4_194_305])
			expect(make({ pidsLimit })).toThrow(
				`the docker pidsLimit ${shown(pidsLimit)} is not a whole number from 1 to 4194304`,
			);
		expect(make({ cpus: 0.01, memory: "512M", pidsLimit: 1 })).not.toThrow();
		expect(make({ pidsLimit: 4_194_304 })).not.toThrow();
	});
});
