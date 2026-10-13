import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { dockerBoxes } from "../src/box/docker.ts";
import { registerHandsCases } from "./hands-support.ts";

const context = BACKGROUND_CONTEXT;
// Every container of this run carries the label, so the last test can count what the run left behind.
const labels = { "pi-transport.test": `hands-${process.pid}-${Date.now()}` };

// Needs a Docker daemon and an image, so it runs only when asked: `npm run test:live:docker`.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	registerHandsCases(
		"hands on Docker boxes",
		async (use) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-transport-hands-"));
			try {
				await use({
					provider: () => dockerBoxes(),
					environment: { provider: "docker", maxLifetime: "10m" },
					directory,
					labels,
				});
			} finally {
				rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
			}
		},
		120_000,
	);

	describe("hands on Docker boxes", () => {
		it("runs the example's command in a container when the config says docker", () => {
			const root = fileURLToPath(new URL("..", import.meta.url));
			const args = [
				"--experimental-strip-types",
				"examples/01-hands.ts",
				"examples/hands.docker.json",
				"pwd; ls /.dockerenv",
			];
			const run = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 100_000 });
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toContain("/workspace\n/.dockerenv");
			expect(run.stdout).toMatch(/sandbox: box [0-9a-f]{12}/);
		}, 120_000);

		// Runs last: by now every container this file started must be gone.
		it("leaves no container behind", async () => {
			expect(getOrThrow(await dockerBoxes().list(labels, context))).toEqual([]);
			expect(getOrThrow(await dockerBoxes().list({ example: "01-hands" }, context))).toEqual([]);
		});
	});
} else {
	describe.skip("hands on Docker boxes (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs a session's tools in Docker containers", () => {});
	});
}
