import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
			expect(programsOf(box.id).length).toBeGreaterThan(0);
			await box.destroy(context);
			expect(programsOf(box.id)).toEqual([]);
		}));

	it("destroy ends a program that left its process group", () =>
		withProvider(async (provider) => {
			const box = await create(provider);
			await output(box, ["sh", "-c", "setsid sleep 300 >/dev/null 2>&1 &"]);
			expect(programsOf(box.id).length).toBeGreaterThan(0);
			await box.destroy(context);
			expect(programsOf(box.id)).toEqual([]);
		}));

	it("destroy leaves no watchdog behind", () =>
		withProvider(async (provider) => {
			const box = await create(provider);
			expect(watchdogsOf(box.id).length).toBeGreaterThan(0);
			await box.destroy(context);
			expect(watchdogsOf(box.id)).toEqual([]);
		}));

	it("the watchdog ends an expired box that nobody asks about", () =>
		withProvider(async (provider, root) => {
			const box = await create(provider, 1_000);
			await output(box, ["sh", "-c", "sleep 300 >/dev/null 2>&1 &"]);
			expect(programsOf(box.id).length).toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 3_500));
			expect(existsSync(join(root, box.id))).toBe(false);
			expect(programsOf(box.id)).toEqual([]);
			expect(watchdogsOf(box.id)).toEqual([]);
		}));
});
