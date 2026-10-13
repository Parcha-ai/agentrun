import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Runs an example as its own header says, from the package's directory. */
function example(...args: string[]) {
	const flags = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
	return spawnSync(process.execPath, [...flags, ...args], { cwd: root, encoding: "utf8", timeout: 50_000 });
}

describe("examples/01-hands.ts", () => {
	it("runs the message's command in a box when the config names one, and ends the box", () => {
		const run = example("examples/01-hands.ts", "examples/hands.local.json", "echo hello; pwd");
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toMatch(/^hello\n\/.*\/boxes\/local-[0-9a-f]+\/workspace\n/);
		expect(run.stdout).toMatch(/the tools ran in:\n {2}sandbox: box local-[0-9a-f]+\n$/);
	}, 60_000);

	it("runs it on this machine when the config names no hands", () => {
		const run = example("examples/01-hands.ts", "examples/hands.host.json", "pwd");
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toBe(`${root.replace(/\/$/, "")}\nthe tools ran on this machine, in no box\n`);
	}, 60_000);

	it("writes what it measured with --log, and finds no credential's name in the box", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-example-"));
		try {
			const logPath = join(directory, "run.json");
			const run = example("examples/01-hands.ts", "examples/hands.local.json", "echo measured", "--log", logPath);
			expect(run.status, run.stderr).toBe(0);
			const log = JSON.parse(readFileSync(logPath, "utf8"));
			expect(log).toMatchObject({
				example: "01-hands",
				hands: "sandbox",
				model: { scripted: true },
				message: "echo measured",
				requests: [],
				toolCalls: [{ name: "bash", isError: false }],
				left: { local: 0 },
			});
			expect(log.boxes).toHaveLength(1);
			expect(log.boxes[0]).toMatchObject({ provider: "local", secretNames: [] });
			expect(log.boxes[0].execMs.length).toBeGreaterThan(0);
			expect(log.boxes[0].destroyMs).toBeGreaterThanOrEqual(0);
			expect(log.firstToolStartMs).toBeLessThanOrEqual(log.turnMs);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	it("continues one conversation from a store, with its tools somewhere else when the config says so", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-example-"));
		try {
			const store = join(directory, "session.db");
			const first = example("examples/01-hands.ts", "examples/hands.local.json", "echo one; pwd", "--store", store);
			expect(first.status, first.stderr).toBe(0);
			expect(first.stdout).toMatch(/^one\n\/.*\/boxes\/local-[0-9a-f]+\/workspace\n/);
			const logPath = join(directory, "second.json");
			const second = example(
				"examples/01-hands.ts",
				"examples/hands.host.json",
				"pwd",
				"--store",
				store,
				"--log",
				logPath,
			);
			expect(second.status, second.stderr).toBe(0);
			expect(second.stdout).toBe(`${root.replace(/\/$/, "")}\nthe tools ran on this machine, in no box\n`);
			// The second turn's own tool call only, though the conversation holds both.
			expect(JSON.parse(readFileSync(logPath, "utf8")).toolCalls).toHaveLength(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	it("says what is wrong with a config and runs nothing", () => {
		const run = example("examples/01-hands.ts", "package.json", "pwd");
		expect(run.status).toBe(2);
		expect(run.stderr).toMatch(/^\/: must have required properties environments\n/);
		expect(run.stdout).toBe("");
	}, 60_000);
});
