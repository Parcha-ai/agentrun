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
		for (const cpus of [0, -1, 0.001, Number.NaN, Number.POSITIVE_INFINITY, "2" as unknown as number])
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
