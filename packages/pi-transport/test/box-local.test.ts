import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import type { Box, BoxProvider } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { localBoxes } from "../src/box/local.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";
const HAS_PROC = existsSync("/proc/self/environ");
const context = BACKGROUND_CONTEXT;

/** Process ids whose environment holds this entry, read from the machine and not from the provider. */
function processesWith(entry: string): number[] {
	if (!HAS_PROC) return [];
	const found: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			if (readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(entry)) found.push(Number(name));
		} catch {
			// Another user's process, or one that ended.
		}
	}
	return found;
}

/**
 * Process ids whose working directory is `directory`, whatever their environment says. The kernel names a removed
 * directory with a ` (deleted)` suffix, and a program in it is still a program.
 */
function processesIn(directory: string): number[] {
	const found: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const cwd = readlinkSync(`/proc/${name}/cwd`);
			if (cwd === directory || cwd === `${directory} (deleted)`) found.push(Number(name));
		} catch {
			// Another user's process, or one that ended.
		}
	}
	return found;
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

/** The members of a process group that are alive: not gone, not zombies. */
function groupOf(pgid: number): number[] {
	const alive: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const fields = readFileSync(`/proc/${name}/stat`, "latin1").split(") ")[1]?.split(" ") ?? [];
			if (Number(fields[2]) === pgid && fields[0] !== "Z") alive.push(Number(name));
		} catch {
			// Gone.
		}
	}
	return alive;
}

const programsOf = (id: string) => processesWith(`PI_TRANSPORT_BOX=${id}`);
const watchdogsOf = (id: string) => processesWith(`PI_TRANSPORT_WATCHDOG=${id}`);

let conformanceRoot = "";

registerBoxConformance(
	{ describe, expect, it },
	"local boxes",
	async (use) => {
		conformanceRoot = mkdtempSync(join(tmpdir(), "pi-transport-local-"));
		try {
			await use(localBoxes({ root: conformanceRoot }));
		} finally {
			rmSync(conformanceRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	},
	{
		absentEnv: [CANARY],
		lifetime: {
			maxLifetimeMs: 1_500,
			graceMs: 5_000,
			ended: async (box) => !existsSync(join(conformanceRoot, box.id)) && programsOf(box.id).length === 0,
		},
	},
);

async function withProvider(
	use: (provider: BoxProvider, root: string) => Promise<void>,
	options: { path?: string } = {},
): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-local-"));
	try {
		await use(localBoxes({ root, ...options }), root);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

async function create(provider: BoxProvider, maxLifetimeMs = 60_000): Promise<Box> {
	const created = await provider.create({ maxLifetimeMs }, context);
	if (!created.ok) throw created.error;
	return created.value;
}

async function output(box: Box, command: readonly string[]): Promise<string> {
	const started = await box.exec(command, undefined, context);
	if (!started.ok) throw started.error;
	const finished = await finish(started.value);
	if (!finished.ok) throw finished.error;
	return new TextDecoder().decode(finished.value.stdout);
}

describe("local boxes: what a directory cannot give", () => {
	it("refuses a spec field it cannot honour, and names it", () =>
		withProvider(async (provider) => {
			const specs = [
				{ image: "debian" },
				{ snapshot: "s" },
				{ cpus: 2 },
				{ memoryMb: 512 },
				{ gpu: "T4" },
				{ region: "us" },
				{ isolation: "vm" as const },
			];
			for (const fields of specs) {
				const refused = await provider.create({ maxLifetimeMs: 60_000, ...fields }, context);
				expect(refused.ok).toBe(false);
				if (!refused.ok) {
					const [field, value] = Object.entries(fields)[0] ?? [];
					expect(refused.error.code).toBe("unsupported");
					expect(refused.error.message).toContain(field === "isolation" ? String(value) : field);
				}
			}
		}));

	it("refuses a label in the providers' own namespace", () =>
		withProvider(async (provider) => {
			const labels = { "pi-transport.facts": "x" };
			const refused = await provider.create({ maxLifetimeMs: 60_000, labels }, context);
			expect(refused.ok).toBe(false);
			if (!refused.ok) expect(refused.error.code).toBe("invalid");
		}));
});

describe.skipIf(!HAS_PROC)("local boxes: a program that locks the box's own directories", () => {
	// The program waits for its own record, so the lock always lands after the record was written.
	const lock = 'while [ ! -e "$HOME/../pids/$$" ]; do sleep 0.02; done; chmod 500 "$HOME/../pids" "$HOME/.."';

	it("cannot crash the host when it exits, and the box is still destroyed", () =>
		withProvider(async (provider, root) => {
			const box = await create(provider);
			expect(await output(box, ["sh", "-c", `${lock} && printf locked`])).toBe("locked");
			// The program's record could not be removed when it closed: its directory was locked by then.
			expect(readdirSync(join(root, box.id, "pids")).length).toBe(1);
			const destroyed = await box.destroy(context);
			expect(destroyed.ok).toBe(true);
			expect(existsSync(join(root, box.id))).toBe(false);
		}));

	it("is still ended by the watchdog", () =>
		withProvider(async (provider, root) => {
			const box = await create(provider, 1_000);
			await output(box, ["sh", "-c", lock]);
			await new Promise((resolve) => setTimeout(resolve, 3_500));
			expect(existsSync(join(root, box.id))).toBe(false);
		}));
});

describe("local boxes: a watchdog that cannot start", () => {
	it("fails the create with a spawn error and leaves no box behind", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-local-"));
		try {
			const provider = localBoxes({ root, shell: "/nonexistent/pi-transport-sh" });
			const created = await provider.create({ maxLifetimeMs: 60_000 }, context);
			expect(created.ok).toBe(false);
			if (!created.ok) expect(created.error.code).toBe("spawn");
			expect(readdirSync(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("local boxes: the environment of a program", () => {
	it("has a fixed PATH and never this process's own", async () => {
		const before = process.env.PATH;
		process.env.PATH = `/pi-transport/host/only:${before ?? ""}`;
		try {
			await withProvider(async (provider) => {
				const box = await create(provider);
				expect(await output(box, ["/bin/sh", "-c", 'printf %s "$PATH"'])).toBe("/usr/local/bin:/usr/bin:/bin");
				await box.destroy(context);
			});
		} finally {
			process.env.PATH = before;
		}
	});

	it("has the PATH the host chose for its boxes", () =>
		withProvider(
			async (provider) => {
				const box = await create(provider);
				expect(await output(box, ["/bin/sh", "-c", 'printf %s "$PATH"'])).toBe("/opt/tools/bin:/usr/bin:/bin");
				await box.destroy(context);
			},
			{ path: "/opt/tools/bin:/usr/bin:/bin" },
		));
});

describe.skipIf(!HAS_PROC)("local boxes: programs that outlive the program that started them", () => {
	it("destroy ends a background program whose starter has exited", () =>
		withProvider(async (provider) => {
			const box = await create(provider);
			await output(box, ["sh", "-c", "sleep 300 >/dev/null 2>&1 &"]);
			await until(() => programsOf(box.id).length > 0);
			expect(programsOf(box.id).length).toBeGreaterThan(0);
			await box.destroy(context);
			expect(programsOf(box.id)).toEqual([]);
		}));

	it("destroy ends a program that left its process group", () =>
		withProvider(async (provider) => {
			const box = await create(provider);
			await output(box, ["sh", "-c", "setsid sleep 300 >/dev/null 2>&1 &"]);
			await until(() => programsOf(box.id).length > 0);
			expect(programsOf(box.id).length).toBeGreaterThan(0);
			await box.destroy(context);
			expect(programsOf(box.id)).toEqual([]);
		}));

	it("destroy ends a program the box started that replaced its environment", () =>
		withProvider(async (provider) => {
			const box = await create(provider);
			const started = await box.exec(["env", "-i", "/bin/sleep", "300"], undefined, context);
			if (!started.ok) throw started.error;
			await until(() => processesIn(box.facts().workspace).length > 0);
			expect(programsOf(box.id)).toEqual([]);
			await box.destroy(context);
			await until(() => processesIn(box.facts().workspace).length === 0);
			expect(processesIn(box.facts().workspace)).toEqual([]);
		}));

	it("the watchdog ends such a program too", () =>
		withProvider(async (provider) => {
			const box = await create(provider, 4_000);
			const started = await box.exec(["env", "-i", "/bin/sleep", "300"], undefined, context);
			if (!started.ok) throw started.error;
			const workspace = box.facts().workspace;
			await until(() => processesIn(workspace).length > 0);
			await new Promise((resolve) => setTimeout(resolve, 6_500));
			await until(() => processesIn(workspace).length === 0);
			expect(processesIn(workspace)).toEqual([]);
		}));

	it("destroy leaves no watchdog behind", () =>
		withProvider(async (provider) => {
			const box = await create(provider);
			await until(() => watchdogsOf(box.id).length > 0);
			expect(watchdogsOf(box.id).length).toBeGreaterThan(0);
			await box.destroy(context);
			expect(watchdogsOf(box.id)).toEqual([]);
		}));

	// The member is slow to die only when it holds a lot of memory. That needs Python and 3 GB, so it is opt-in:
	// `PI_TRANSPORT_STRESS_GROUP=1`. Without it, the same test runs with a small member and checks the behavior, not the race.
	const stress = process.env.PI_TRANSPORT_STRESS_GROUP === "1";
	it(
		"destroy returns only once every member of a killed group is gone, also one that cleared its environment",
		() =>
			withProvider(async (provider, root) => {
				for (let round = 0; round < (stress ? 3 : 5); round++) {
					const box = await create(provider);
					const pgFile = join(root, `pgid-${round}`);
					// The program leads its group; its child clears its environment (so has no marker) and ignores TERM.
					const member = stress
						? `/usr/bin/python3 -c 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); b = bytearray(3000 * 1024 * 1024); b[::4096] = bytes(len(b[::4096])); time.sleep(30)'`
						: `sh -c 'trap "" TERM; sleep 30'`;
					const started = await box.exec(
						["sh", "-c", `echo $$ > ${pgFile}; env -i ${member} & wait`],
						undefined,
						context,
					);
					if (!started.ok) throw started.error;
					await until(() => existsSync(pgFile) && readFileSync(pgFile, "utf8").trim() !== "");
					const pgid = Number(readFileSync(pgFile, "utf8").trim());
					await until(() => groupOf(pgid).length > 1, 20_000);
					// With the large member: up once it has touched all its memory, which a kill then takes a while to tear down.
					if (stress) await new Promise((resolve) => setTimeout(resolve, 5_000));
					expect(groupOf(pgid).length, `round ${round}`).toBeGreaterThan(1);
					await box.destroy(context);
					expect(groupOf(pgid), `round ${round}`).toEqual([]);
				}
			}),
		90_000,
	);

	it(
		"destroy returns only once the watchdog it killed is gone or a zombie",
		() =>
			withProvider(async (provider) => {
				for (let round = 0; round < 5; round++) {
					const box = await create(provider);
					await until(() => watchdogsOf(box.id).length > 0);
					const pids = watchdogsOf(box.id);
					expect(pids.length).toBeGreaterThan(0);
					await box.destroy(context);
					const running = pids.filter((pid) => {
						try {
							const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
							return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
						} catch {
							return false;
						}
					});
					expect(running, `round ${round}`).toEqual([]);
				}
			}),
		60_000,
	);

	it("the watchdog ends an expired box that nobody asks about", () =>
		withProvider(async (provider, root) => {
			// Long enough that a loaded machine still sees the program start before the box expires.
			const box = await create(provider, 4_000);
			await output(box, ["sh", "-c", "sleep 300 >/dev/null 2>&1 &"]);
			await until(() => programsOf(box.id).length > 0);
			expect(programsOf(box.id).length).toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 6_500));
			await until(
				() =>
					!existsSync(join(root, box.id)) && programsOf(box.id).length === 0 && watchdogsOf(box.id).length === 0,
			);
			expect(existsSync(join(root, box.id))).toBe(false);
			expect(programsOf(box.id)).toEqual([]);
			expect(watchdogsOf(box.id)).toEqual([]);
		}));
});
