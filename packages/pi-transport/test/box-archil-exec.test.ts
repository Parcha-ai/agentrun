import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import { archilExecBoxes } from "../src/box/archil-exec.ts";
import type { Box, BoxSpec } from "../src/box/box.ts";
import { finish, readStream } from "../src/box/files.ts";
import { localVault } from "../src/home/checkpoint.ts";
import { dirStore } from "../src/home/dir-store.ts";
import { leaseIn } from "../src/home/ownership.ts";
import { boxPlace } from "../src/place/box-place.ts";
import { registerBoxConformance } from "../src/testing/index.ts";
import { FakeArchil, FakeArchilError } from "./archil-fake.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";
const context = BACKGROUND_CONTEXT;
const SPEC: BoxSpec = { maxLifetimeMs: 60_000, labels: { run: "a" } };
const WHY = "an exec is one request that answers when the command ends";
const decoder = new TextDecoder();

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

/** A fake disk and the provider over it; `close` kills what a test abandoned. */
function rig(options: { queueMs?: number; destroyWaitMs?: number } = {}) {
	const fake = new FakeArchil();
	const provider = archilExecBoxes({ client: fake.client, disk: fake.disk, ...options });
	return { fake, provider, close: () => fake.close() };
}

async function run(box: Box, argv: readonly string[], timeoutMs?: number) {
	const started = unwrap(await box.exec(argv, timeoutMs === undefined ? undefined : { timeoutMs }, context));
	const done = unwrap(await finish(started));
	return { exitCode: done.exitCode, stdout: decoder.decode(done.stdout), stderr: done.stderr };
}

registerBoxConformance(
	{ describe, expect, it },
	"archil exec boxes over a fake SDK",
	async (use) => {
		const { provider, close } = rig();
		try {
			await use(provider);
		} finally {
			close();
		}
	},
	{ absentEnv: [CANARY], withoutLiveProcesses: WHY },
);

describe("archil exec boxes", () => {
	it("reports facts: a vm, one request per exec, no live program, a 300 s limit, a directory of the work disk", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			expect(box.facts()).toMatchObject({
				provider: "archil-exec",
				isolation: "vm",
				liveProcesses: false,
				maxExecMs: 300_000,
				snapshot: null,
				bulk: "files",
				maxLifetimeMs: 60_000,
			});
			expect(box.facts().workspace).toBe(`/mnt/archil/work/boxes/${box.id}`);
			expect(existsSync(join(fake.root, "boxes", box.id))).toBe(true);
		} finally {
			close();
		}
	});

	it("never touches anything outside boxes/ and boxes.records/ on the disk, and never under runs/", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			await run(box, ["sh", "-c", "echo hi > a.txt"]);
			unwrap(await box.upload([{ path: "deep/b.txt", bytes: new Uint8Array([1]) }], context));
			unwrap(await box.destroy(context));
			expect(readdirSync(fake.root).sort()).toEqual(["boxes", "boxes.records"]);
		} finally {
			close();
		}
	});

	it("runs every exec with the box directory checked out and a queue, so a second process waits and loses nothing", async () => {
		const { fake, provider, close } = rig({ queueMs: 20_000 });
		try {
			const box = unwrap(await provider.create(SPEC, context));
			await run(box, ["true"]);
			const call = fake.calls.at(-1);
			expect(call?.mount).toBe("work");
			expect(call?.spec).toMatchObject({
				disk: fake.disk.id,
				checkoutPaths: [`boxes/${box.id}`],
				queueMs: 20_000,
			});
			// A second host that attached the same box, running at the same time.
			const other = archilExecBoxes({ client: fake.client, disk: fake.disk, queueMs: 20_000 });
			const attached = unwrap(await other.attach(box.id, context));
			const both = await Promise.all([
				run(box, ["sh", "-c", "sleep 0.4; echo one >> shared.txt"]),
				run(attached as Box, ["sh", "-c", "echo two >> shared.txt"]),
			]);
			expect(both.map((result) => result.exitCode)).toEqual([0, 0]);
			const lines = readFileSync(join(fake.root, "boxes", box.id, "shared.txt"), "utf8")
				.trim()
				.split("\n");
			expect(lines.sort()).toEqual(["one", "two"]);
			expect(fake.maxOverlap).toBe(1);
		} finally {
			close();
		}
	});

	it("runs the execs of one box one at a time, in the order they were asked, and a second box in parallel", async () => {
		const { fake, provider, close } = rig();
		try {
			const one = unwrap(await provider.create(SPEC, context));
			const two = unwrap(await provider.create(SPEC, context));
			const started = [0, 1, 2, 3, 4].map((n) => run(one, ["sh", "-c", `sleep 0.1; echo ${n} >> order.txt`]));
			await Promise.all(started);
			expect(fake.maxOverlap).toBe(1);
			expect(
				readFileSync(join(fake.root, "boxes", one.id, "order.txt"), "utf8")
					.trim()
					.split("\n"),
			).toEqual(["0", "1", "2", "3", "4"]);
			const parallel = await Promise.all([
				run(one, ["sleep", "0.5"]),
				run(two, ["sleep", "0.5"]),
				run(unwrap(await provider.create(SPEC, context)), ["sleep", "0.5"]),
			]);
			expect(parallel.map((result) => result.exitCode)).toEqual([0, 0, 0]);
			expect(fake.maxOverlap).toBeGreaterThan(1);
		} finally {
			close();
		}
	});

	it("puts the argv in single quotes, the box's env in front and a deadline of the command's own in the container", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create({ ...SPEC, env: { GREETING: "it's here", PLAIN: "x" } }, context));
			const result = await run(box, ["sh", "-c", 'printf "%s|%s|%s" "$GREETING" "$PLAIN" "$1"', "sh", "a'b"], 5_000);
			expect(result).toMatchObject({ exitCode: 0, stdout: "it's here|x|a'b" });
			const command = fake.calls.at(-1)?.command ?? "";
			expect(command).toContain("timeout");
			expect(command).toContain("'a'\\''b'");
			expect(command).not.toContain("a'b'");
		} finally {
			close();
		}
	});

	it("refuses a timeout over 300 s before any call, and ends every command at the platform's limit by itself", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const before = fake.calls.length;
			const refused = await box.exec(["true"], { timeoutMs: 300_001 }, context);
			expect(refused.ok).toBe(false);
			if (!refused.ok) expect(refused.error.code).toBe("invalid");
			expect(fake.calls.length).toBe(before);
			await run(box, ["true"]);
			// No timeout asked: the command still carries a deadline under the 300 s the platform cuts a call at.
			expect(fake.calls.at(-1)?.command).toMatch(/timeout[^;&]* 29\d(\.\d+)?s?\b/);
		} finally {
			close();
		}
	});

	it("orders its own execs itself when the service ignores the checkout", async () => {
		const { fake, provider, close } = rig();
		try {
			fake.enforceCheckout = false;
			const box = unwrap(await provider.create(SPEC, context));
			await Promise.all([0, 1, 2, 3].map((n) => run(box, ["sh", "-c", `sleep 0.1; echo ${n} >> order.txt`])));
			expect(fake.maxOverlap).toBe(1);
			expect(
				readFileSync(join(fake.root, "boxes", box.id, "order.txt"), "utf8")
					.trim()
					.split("\n"),
			).toEqual(["0", "1", "2", "3"]);
		} finally {
			close();
		}
	});

	it("is gone for a process whose box another process destroyed", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const other = archilExecBoxes({ client: fake.client, disk: fake.disk });
			const there = unwrap(await other.attach(box.id, context)) as Box;
			unwrap(await there.destroy(context));
			const started = unwrap(await box.exec(["true"], undefined, context));
			void readStream(started.stdout).catch(() => {});
			void readStream(started.stderr).catch(() => {});
			const exit = await started.wait();
			expect(exit.ok).toBe(false);
			if (!exit.ok) expect(exit.error.code).toBe("gone");
			expect(unwrap(await box.status(context)).state).toBe("ended");
		} finally {
			close();
		}
	});

	it("removes a directory through its parent: a directory cannot be removed while it is itself checked out", async () => {
		const { fake, provider, close } = rig({ destroyWaitMs: 1_234 });
		try {
			const box = unwrap(await provider.create(SPEC, context));
			unwrap(await box.destroy(context));
			const call = fake.calls.at(-1);
			expect(call?.command).toContain("rm -rf");
			expect(call?.spec).toMatchObject({ checkoutPaths: ["boxes"], queueMs: 1_234 });
			expect(existsSync(join(fake.root, "boxes", box.id))).toBe(false);
		} finally {
			close();
		}
	});

	it("ends a box at once even while a command holds its directory, and the next list removes what was left", async () => {
		const { fake, provider, close } = rig({ destroyWaitMs: 100 });
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const held = run(box, ["sleep", "1"]);
			await new Promise((resolve) => setTimeout(resolve, 200));
			unwrap(await box.destroy(context));
			expect(unwrap(await provider.attach(box.id, context))).toBeUndefined();
			expect(unwrap(await provider.list({}, context))).toEqual([]);
			await held;
			expect(existsSync(join(fake.root, "boxes", box.id))).toBe(true);
			expect(unwrap(await provider.list({}, context))).toEqual([]);
			expect(existsSync(join(fake.root, "boxes", box.id))).toBe(false);
		} finally {
			close();
		}
	});

	it("is gone for a second process that runs after the box was ended, though a command kept its directory", async () => {
		const { fake, provider, close } = rig({ destroyWaitMs: 50 });
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const other = archilExecBoxes({ client: fake.client, disk: fake.disk, destroyWaitMs: 50 });
			const there = unwrap(await other.attach(box.id, context)) as Box;
			const held = run(box, ["sleep", "0.6"]);
			await new Promise((resolve) => setTimeout(resolve, 150));
			unwrap(await box.destroy(context));
			expect(existsSync(join(fake.root, "boxes", box.id))).toBe(true);
			const started = unwrap(await there.exec(["sh", "-c", "echo ran > ran.txt"], undefined, context));
			void readStream(started.stdout).catch(() => {});
			void readStream(started.stderr).catch(() => {});
			const exit = await started.wait();
			expect(exit.ok).toBe(false);
			if (!exit.ok) expect(exit.error.code).toBe("gone");
			await held;
			expect(existsSync(join(fake.root, "boxes", box.id, "ran.txt"))).toBe(false);
		} finally {
			close();
		}
	});

	it("refuses stdin with an unsupported error and carries output after the call", async () => {
		const { provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const started = unwrap(await box.exec(["sh", "-c", "echo out; echo err >&2; exit 3"], undefined, context));
			await expect(started.stdin.write(new Uint8Array([1]))).rejects.toMatchObject({ code: "unsupported" });
			await started.stdin.close();
			expect(decoder.decode(await readStream(started.stdout))).toBe("out\n");
			expect(decoder.decode(await readStream(started.stderr))).toBe("err\n");
			expect(unwrap(await started.wait())).toBe(3);
		} finally {
			close();
		}
	});

	it("ends the wait at once when the context aborts, while the command's own deadline bounds it in the container", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const cancel = withCancel(context);
			const started = unwrap(await box.exec(["sleep", "30"], undefined, cancel.context));
			void readStream(started.stdout).catch(() => {});
			void readStream(started.stderr).catch(() => {});
			const began = Date.now();
			setTimeout(() => cancel.cancel(), 100);
			const exit = await started.wait();
			expect(exit.ok).toBe(false);
			if (!exit.ok) expect(exit.error.code).toBe("aborted");
			expect(Date.now() - began).toBeLessThan(5_000);
			expect(fake.calls.at(-1)?.command).toContain("timeout");
		} finally {
			close();
		}
	});

	it("maps what the SDK throws to typed errors", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const codeOf = async (error: Error) => {
				fake.failNext = error;
				const started = unwrap(await box.exec(["true"], undefined, context));
				void readStream(started.stdout).catch(() => {});
				void readStream(started.stderr).catch(() => {});
				const exit = await started.wait();
				return exit.ok ? "ok" : exit.error.code;
			};
			expect(await codeOf(new FakeArchilError("ArchilApiError", "Unauthorized", 401))).toBe("unauthorized");
			expect(await codeOf(new FakeArchilError("ArchilApiError", "Forbidden", 403))).toBe("unauthorized");
			expect(await codeOf(new FakeArchilError("ArchilApiError", "slow down", 429))).toBe("capacity");
			expect(await codeOf(new FakeArchilError("ArchilApiError", "boom", 500))).toBe("unknown");
			expect(
				await codeOf(
					new FakeArchilError(
						"ArchilApiError",
						"Exec failed: Delegation checkout conflicts with another client",
						400,
					),
				),
			).toBe("unknown");
			expect(await codeOf(new TypeError("fetch failed"))).toBe("timeout");
		} finally {
			close();
		}
	});

	it("keeps labels, env and facts on the disk, so attach and list find the box after a restart", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(
				await provider.create({ ...SPEC, env: { MODE: "kept" }, labels: { run: "r1", team: "t" } }, context),
			);
			const after = archilExecBoxes({ client: fake.client, disk: fake.disk });
			const found = unwrap(await after.attach(box.id, context));
			expect(found?.facts()).toEqual(box.facts());
			expect((await run(found as Box, ["sh", "-c", 'printf %s "$MODE"'])).stdout).toBe("kept");
			expect(unwrap(await after.list({ run: "r1" }, context))).toEqual([
				{ id: box.id, labels: { run: "r1", team: "t" } },
			]);
			expect(unwrap(await after.list({ run: "r2" }, context))).toEqual([]);
			mkdirSync(join(fake.root, "boxes", "not-a-box"), { recursive: true });
			expect(unwrap(await after.list({}, context)).map((ref) => ref.id)).toEqual([box.id]);
		} finally {
			close();
		}
	});

	it("ends a box at its lifetime on the next call that touches it, and removes its directory", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create({ ...SPEC, maxLifetimeMs: 200 }, context));
			const kept = unwrap(await provider.create(SPEC, context));
			await new Promise((resolve) => setTimeout(resolve, 350));
			expect(unwrap(await provider.list({}, context)).map((ref) => ref.id)).toEqual([kept.id]);
			expect(existsSync(join(fake.root, "boxes", box.id))).toBe(false);
			const started = await box.exec(["true"], undefined, context);
			expect(started.ok).toBe(false);
			if (!started.ok) expect(started.error.code).toBe("gone");
			expect(unwrap(await box.status(context)).state).toBe("ended");
		} finally {
			close();
		}
	});

	it("refuses what a work-disk directory cannot be, before a directory exists", async () => {
		const { fake, provider, close } = rig();
		try {
			const refuse = async (spec: Partial<BoxSpec>, code: string) => {
				const made = await provider.create({ ...SPEC, ...spec }, context);
				expect(made.ok, JSON.stringify(spec)).toBe(false);
				if (!made.ok) expect(made.error.code).toBe(code);
			};
			await refuse({ gpu: "T4" }, "unsupported");
			await refuse({ snapshot: "s" }, "unsupported");
			await refuse({ workspace: "/work" }, "unsupported");
			await refuse({ isolation: "container" }, "unsupported");
			await refuse({ isolation: "none" }, "unsupported");
			await refuse({ cpus: 64 }, "unsupported");
			await refuse({ maxLifetimeMs: 0 }, "invalid");
			await refuse({ labels: { "pi-transport.x": "1" } }, "invalid");
			expect(existsSync(join(fake.root, "boxes"))).toBe(false);
		} finally {
			close();
		}
	});

	it("moves files through the object API: bytes, mode, nested directories, absolute paths inside the workspace only", async () => {
		const { fake, provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
			unwrap(await box.upload([{ path: "a/b/c.bin", bytes, mode: 0o640 }], context));
			const [read] = unwrap(await box.download([`${box.facts().workspace}/a/b/c.bin`], context));
			expect(Array.from(read?.bytes ?? [])).toEqual(Array.from(bytes));
			expect((await run(box, ["stat", "-c", "%a", "a/b/c.bin"])).stdout.trim()).toBe("640");
			expect(fake.calls.every((call) => !call.command.includes("c.bin") || call.command.includes("stat"))).toBe(
				true,
			);
			for (const path of ["../other/x", `${box.facts().workspace}/../x`, "/etc/passwd"]) {
				const refused = await box.download([path], context);
				expect(refused.ok, path).toBe(false);
				if (!refused.ok) expect(refused.error.code).toBe("invalid");
				const wrote = await box.upload([{ path, bytes }], context);
				expect(wrote.ok, path).toBe(false);
			}
			const missing = await box.download(["nope.txt"], context);
			expect(missing.ok).toBe(false);
			if (!missing.ok) expect(missing.error.code).toBe("not_found");
		} finally {
			close();
		}
	});

	it("waits for a command that holds the directory before it writes a file there, instead of failing", async () => {
		const { fake, provider, close } = rig({ queueMs: 5_000 });
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const other = archilExecBoxes({ client: fake.client, disk: fake.disk, queueMs: 5_000 });
			const there = unwrap(await other.attach(box.id, context)) as Box;
			const held = run(there, ["sleep", "0.6"]);
			await new Promise((resolve) => setTimeout(resolve, 150));
			unwrap(await box.upload([{ path: "late.txt", bytes: new Uint8Array([7]) }], context));
			await held;
			expect(readFileSync(join(fake.root, "boxes", box.id, "late.txt"))[0]).toBe(7);
		} finally {
			close();
		}
	});

	it("carries a command's text to the caller as text: bytes that are not UTF-8 are replaced, so use files for bytes", async () => {
		const { provider, close } = rig();
		try {
			const box = unwrap(await provider.create(SPEC, context));
			const result = await run(box, ["sh", "-c", "printf '\\377abc'"]);
			expect(result.stdout).toBe("�abc");
		} finally {
			close();
		}
	});
});

describe("an archil exec box is never a home", () => {
	it("is refused by the box place with a typed error, and the box it made is destroyed", async () => {
		const { fake, provider, close } = rig();
		const root = mkdtempSync(join(tmpdir(), "pi-transport-archil-home-"));
		try {
			const lines: string[] = [];
			const placed = await boxPlace(
				{
					session: "run-1",
					provider,
					spec: SPEC,
					environment: "archil",
					ownership: leaseIn(dirStore(join(root, "lease"))),
					program: { argv: ["node", "-e", "0"] },
					models: createModels(),
					vault: localVault(join(root, "vault")),
					lines: (kind) => lines.push(kind),
				},
				context,
			);
			expect(placed.ok).toBe(false);
			if (!placed.ok) expect(placed.error.code).toBe("no_live_processes");
			expect(lines).toEqual([]);
			expect(readdirSync(join(fake.root, "boxes"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			close();
		}
	});
});
