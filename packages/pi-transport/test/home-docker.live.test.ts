import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dockerBoxes } from "../src/box/docker.ts";
import { localBoxes } from "../src/box/local.ts";
import { manifestOf, moveWorkspace } from "../src/home/index.ts";
import { populate } from "./home-support.ts";

const context = BACKGROUND_CONTEXT;
const MEBIBYTE = 1024 * 1024;
const SIZES = [
	{ label: "1 MB", files: 50, bytesEach: 20 * 1024 },
	{ label: "64 MB", files: 64, bytesEach: MEBIBYTE },
];

// Needs a Docker daemon and an image, so it runs only when asked: `npm run test:live:docker`.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	describe("moving a workspace to and between Docker boxes", () => {
		const run = `m4-${process.pid}-${Date.now()}`;
		const labels = { "m4-run": run };
		const docker = dockerBoxes();
		const root = mkdtempSync(join(tmpdir(), "pi-transport-home-docker-"));
		const local = localBoxes({ root });
		const boxes: Box[] = [];
		afterAll(async () => {
			for (const box of boxes) await box.destroy(context);
			rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
			const left = getOrThrow(await docker.list(labels, context));
			console.log(`containers left by label: ${left.length}`);
			if (left.length > 0) throw new Error(`${left.length} containers left`);
		});
		const make = async (kind: "local" | "docker") => {
			const box = getOrThrow(
				await (kind === "local" ? local : docker).create({ maxLifetimeMs: 1_800_000, labels }, context),
			);
			boxes.push(box);
			return box;
		};

		for (const [fromKind, toKind] of [
			["local", "docker"],
			["docker", "docker"],
		] as const) {
			for (const size of SIZES) {
				it(`moves ${size.label} from ${fromKind} to ${toKind}`, async () => {
					const from = await make(fromKind);
					const to = await make(toKind);
					const src = "/tmp/m4-tree";
					await populate(
						from,
						fromKind === "local" ? join(from.facts().workspace, "tree") : src,
						size.files,
						size.bytesEach,
						context,
					);
					const fromRoot = fromKind === "local" ? join(from.facts().workspace, "tree") : src;
					const receipt = getOrThrow(
						await moveWorkspace(from, to, { fromRoot, toRoot: "/tmp/m4-landed" }, context),
					);
					const landed = getOrThrow(await manifestOf(to, "/tmp/m4-landed", undefined, context));
					expect(landed.bytes).toBe(receipt.bytes);
					expect(receipt.bytes).toBe(size.files * size.bytesEach);
					console.log(
						`move ${size.label} ${fromKind}->${toKind}: ${JSON.stringify({ ...receipt, megabytesPerSecond: Number(receipt.megabytesPerSecond.toFixed(1)) })}`,
					);
				}, 900_000);
			}
		}
	});
} else {
	describe.skip("moving a workspace to and between Docker boxes (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("moves workspaces between local and Docker boxes", () => {});
	});
}
