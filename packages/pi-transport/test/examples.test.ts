import { spawnSync } from "node:child_process";
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

	it("says what is wrong with a config and runs nothing", () => {
		const run = example("examples/01-hands.ts", "package.json", "pwd");
		expect(run.status).toBe(2);
		expect(run.stderr).toMatch(/^\/: must have required properties environments\n/);
		expect(run.stdout).toBe("");
	}, 60_000);
});
