// A home tool call that is not replay-safe runs once, even across a box loss. The box loss is simulated by a preloaded
// shim (pi-durable-disk's test/fixtures/fsync-snapshot) that keeps each store file as it stood at its last sync; the
// store is put back to that state before the next open. Where the sync sits decides the outcome: after the call's
// intent is committed (the home's tool wrap) the resumed call is reported interrupted; before it (a beforeTool hook)
// the call resumes from before its intent and pays again.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FIXTURE = fileURLToPath(new URL("home-tool-barrier.fixture.ts", import.meta.url));
const SHIM = fileURLToPath(new URL("../../pi-durable-disk/test/fixtures/fsync-snapshot/shim.c", import.meta.url));
const linux = process.platform === "linux";
let built: string | undefined;
let shimDir: string | undefined;

beforeAll(() => {
	if (!linux) return;
	shimDir = mkdtempSync(join(tmpdir(), "home-shim-"));
	const out = join(shimDir, "shim.so");
	const made = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", out, SHIM, "-ldl"], { encoding: "utf8" });
	if (made.status === 0) built = out;
	else if (process.env.CI)
		throw new Error(`the fsync-snapshot shim did not build: ${made.error?.message ?? made.stderr}`);
});
afterAll(() => {
	if (shimDir) rmSync(shimDir, { recursive: true, force: true });
});

/** Start the run with the shim preloaded; once `pay` has paid, SIGKILL the writer: the box is gone. */
async function payThenLoseTheBox(store: string, effects: string, variant: string): Promise<void> {
	const child = spawn(process.execPath, [FIXTURE, store, effects, variant, "first"], {
		env: { ...process.env, LD_PRELOAD: built!, FSYNC_SNAPSHOT_DIR: join(store, "..") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	let err = "";
	child.stdout.on("data", (chunk) => {
		out += chunk;
	});
	child.stderr.on("data", (chunk) => {
		err += chunk;
	});
	const deadline = Date.now() + 30_000;
	while (!out.includes("paid\n")) {
		if (Date.now() > deadline || child.exitCode !== null) {
			child.kill("SIGKILL");
			throw new Error(`the first run never paid: ${err}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("exit", resolve));
	for (const each of [store, `${store}-wal`]) {
		if (existsSync(`${each}.synced`)) renameSync(`${each}.synced`, each);
		else rmSync(each, { force: true });
	}
	const dir = join(store, "..");
	for (const name of readdirSync(dir))
		if (/\.(synced|syncing)$/.test(name) || name.endsWith("-shm")) rmSync(join(dir, name));
}

function resume(store: string, effects: string, variant: string): string {
	const run = spawnSync(process.execPath, [FIXTURE, store, effects, variant, "resume"], {
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(run.status, run.stderr).toBe(0);
	return run.stdout;
}

const payments = (effects: string) => readFileSync(effects, "utf8").trim().split("\n");

describe.skipIf(!linux)("a home tool call across a box loss", () => {
	for (const [variant, expected, what] of [
		[
			"wrap",
			["first"],
			"synced after its intent (the home's tool wrap): paid once, the resume reports it interrupted",
		],
		["beforeTool", ["first", "resume"], "synced before its intent (a beforeTool hook): the resume pays again"],
	] as const) {
		it(what, async () => {
			if (!built) return expect(process.env.CI).toBeFalsy();
			const dir = mkdtempSync(join(tmpdir(), "home-barrier-"));
			try {
				const store = join(dir, "store", "run.sqlite");
				const effects = join(dir, "effects.log");
				await payThenLoseTheBox(store, effects, variant);
				expect(payments(effects)).toEqual(["first"]);
				expect(resume(store, effects, variant)).toContain("resumed with the conversation");
				expect(payments(effects)).toEqual(expected);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});
