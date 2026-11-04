import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { dockerBoxes } from "../src/box/docker.ts";
import { finish } from "../src/box/files.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";
const context = BACKGROUND_CONTEXT;

/** Whether Docker itself still knows a container with this id, running or not. */
function containerExists(id: string): boolean {
	return (
		execFileSync("docker", ["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${id}`], {
			encoding: "utf8",
		}).trim() !== ""
	);
}

// Needs a Docker daemon and an image, so it runs only when asked: `npm run test:live:docker`.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	registerBoxConformance({ describe, expect, it }, "docker boxes", (use) => use(dockerBoxes()), {
		absentEnv: [CANARY],
		lifetime: { maxLifetimeMs: 3_000, graceMs: 20_000, ended: async (box) => !containerExists(box.id) },
	});

	describe("docker boxes: an image with an entrypoint of its own", () => {
		it("still ends at its lifetime and still runs programs", async () => {
			// The image's entrypoint is `docker-entrypoint.sh`, which would run `node` and ignore a trailing `sleep`.
			const provider = dockerBoxes({ image: "node:22-slim" });
			const created = await provider.create({ maxLifetimeMs: 4_000 }, context);
			if (!created.ok) throw created.error;
			const box = created.value;
			try {
				const started = await box.exec(["sh", "-c", "cat /proc/1/cmdline | tr '\\0' ' '"], undefined, context);
				if (!started.ok) throw started.error;
				const finished = await finish(started.value);
				if (!finished.ok) throw finished.error;
				expect(new TextDecoder().decode(finished.value.stdout)).toContain("sleep 4");
				await new Promise((resolve) => setTimeout(resolve, 4_000));
				const deadline = Date.now() + 20_000;
				while (containerExists(box.id) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				expect(containerExists(box.id)).toBe(false);
			} finally {
				await box.destroy(context);
			}
		}, 60_000);
	});

	describe("docker boxes: a box as root, with and without dropCapabilities", () => {
		/** What `mknod work/x c 10 130` (the watchdog's numbers) answers in a box run as 0:0 that binds a fresh directory. */
		async function mknodAsRoot(
			dropCapabilities: boolean,
		): Promise<{ exitCode: number; stderr: string; made: boolean }> {
			const work = mkdtempSync(join(tmpdir(), "pi-transport-caps-"));
			const provider = dockerBoxes({ user: "0:0", ...(dropCapabilities ? { dropCapabilities } : {}) });
			const created = await provider.create(
				{
					maxLifetimeMs: 60_000,
					network: "none",
					workspace: "/work",
					mounts: [{ source: realpathSync(work), target: "/work" }],
				},
				context,
			);
			if (!created.ok) throw created.error;
			const box = created.value;
			try {
				const started = await box.exec(["sh", "-c", "mknod /work/x c 10 130"], undefined, context);
				if (!started.ok) throw started.error;
				const finished = await finish(started.value);
				if (!finished.ok) throw finished.error;
				const made = lstatSync(join(work, "x"), { throwIfNoEntry: false })?.isCharacterDevice() === true;
				return { exitCode: finished.value.exitCode, stderr: finished.value.stderr, made };
			} finally {
				// The node is removed in the box, as root made it; it is never opened, here or there.
				await box
					.exec(["rm", "-f", "/work/x"], undefined, context)
					.then((started) => (started.ok ? finish(started.value) : undefined));
				await box.destroy(context);
				rmSync(work, { recursive: true, force: true });
			}
		}

		it("with Docker's default capabilities, root in the box can make a device node in the bound directory", async () => {
			const kept = await mknodAsRoot(false);
			expect([kept.exitCode, kept.made]).toEqual([0, true]);
		}, 60_000);

		it("with dropCapabilities, it cannot: mknod is refused (EPERM) and no node is made", async () => {
			const dropped = await mknodAsRoot(true);
			expect(dropped.exitCode).not.toBe(0);
			expect(dropped.stderr).toMatch(/Operation not permitted/);
			expect(dropped.made).toBe(false);
		}, 60_000);
	});
} else {
	describe.skip("docker boxes (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs the box conformance suite on a Docker daemon", () => {});
	});
}
