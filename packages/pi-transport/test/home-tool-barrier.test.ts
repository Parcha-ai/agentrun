// A home tool call that is not replay-safe runs once, even across a box loss. The box loss is simulated by a preloaded
// shim (pi-durable-disk's test/fixtures/fsync-snapshot) that keeps each store file as it stood at its last sync; the
// store is put back to that state before the next open. Where the sync sits decides the outcome: after the call's
// intent is committed (the home's tool wrap) the resumed call is reported interrupted; before it (a beforeTool hook)
// the call resumes from before its intent and pays again.
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
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

/** Start the run with the shim preloaded; once `pay` has paid, SIGKILL the writer: the box is gone. `real`: the file the
 *  store's path resolves to, beside which SQLite keeps its WAL. */
async function payThenLoseTheBox(
	store: string,
	effects: string,
	variant: string,
	reader: string,
	real = store,
): Promise<void> {
	const child = spawn(process.execPath, [FIXTURE, store, effects, variant, "first", reader], {
		env: { ...process.env, LD_PRELOAD: built!, FSYNC_SNAPSHOT_DIR: join(real, "..") },
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
	for (const each of [real, `${real}-wal`]) {
		if (existsSync(`${each}.synced`)) renameSync(`${each}.synced`, each);
		else rmSync(each, { force: true });
	}
	const dir = join(real, "..");
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
	for (const [variant, reader, expected, kept, what] of [
		[
			"wrap",
			"",
			["first"],
			"with",
			"the WAL synced after its intent (the home's tool wrap): paid once, the resume reports it interrupted",
		],
		["wrap", "reader", ["first"], "with", "the same, with a reader holding a snapshot during the barrier: paid once"],
		[
			"beforeTool",
			"",
			["first", "resume"],
			"with",
			"the WAL synced before its intent (a beforeTool hook): the resume pays again",
		],
		[
			"checkpoint",
			"reader",
			["first"],
			"without",
			"a passive checkpoint as the barrier, with a reader holding the log: it syncs nothing, and the store comes back without the run (the payment it made is not even recorded)",
		],
	] as const) {
		it(what, async () => {
			if (!built) return expect(process.env.CI).toBeFalsy();
			const dir = mkdtempSync(join(tmpdir(), "home-barrier-"));
			try {
				const store = join(dir, "store", "run.sqlite");
				const effects = join(dir, "effects.log");
				await payThenLoseTheBox(store, effects, variant, reader);
				expect(payments(effects)).toEqual(["first"]);
				expect(resume(store, effects, variant)).toContain(`resumed ${kept} the conversation`);
				expect(payments(effects)).toEqual(expected);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}
});

describe.skipIf(!linux)("the home's barrier on a store reached through a symbolic link", () => {
	it("syncs the WAL beside the file the link resolves to, and a path with no WAL is an error, not a silent pass", async () => {
		if (!built) return expect(process.env.CI).toBeFalsy();
		const dir = mkdtempSync(join(tmpdir(), "home-barrier-link-"));
		try {
			const real = join(dir, "disk", "run.sqlite");
			const store = join(dir, "store", "run.sqlite");
			mkdirSync(join(dir, "disk"));
			mkdirSync(join(dir, "store"));
			symlinkSync(real, store);
			const effects = join(dir, "effects.log");
			await payThenLoseTheBox(store, effects, "wrap", "", real);
			expect(payments(effects)).toEqual(["first"]);
			expect(resume(store, effects, "wrap")).toContain("resumed with the conversation");
			expect(payments(effects)).toEqual(["first"]);
			const { syncNow, walFileOf } = await import("../src/home/sync-now.ts");
			expect(await walFileOf(store)).toBe(`${realpathSync(real)}-wal`);
			await expect(syncNow({ walFile: `${store}-wal` }, "homeToolIntent")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
