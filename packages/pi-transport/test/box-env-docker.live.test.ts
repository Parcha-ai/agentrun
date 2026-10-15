import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { dockerBoxes } from "../src/box/docker.ts";
import { boxEnv } from "../src/hands/box-env.ts";
import { normalize, random, randomOperation } from "./box-env-support.ts";

const SEEDS = 20;
const STEPS = 25;
const MAX_LIFETIME_MS = 10 * 60_000;

const context = BACKGROUND_CONTEXT;
const provider = dockerBoxes();
// Every container of this run carries the label, so the last test can count what the run left behind.
const labels = { "test-run": `box-env-${process.pid}-${Date.now()}` };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withBox(use: (box: Box) => Promise<void>): Promise<void> {
	const box = getOrThrow(await provider.create({ maxLifetimeMs: MAX_LIFETIME_MS, labels }, context));
	try {
		await use(box);
	} finally {
		await box.destroy(context);
	}
}

/** Whether a process in the box still carries the tag in its command line. The tag is passed in two halves. */
async function running(env: ExecutionEnv, tag: readonly [string, string]): Promise<boolean> {
	const script =
		'for p in /proc/[0-9]*; do tr "\\0" " " < "$p/cmdline" 2>/dev/null | grep -q -- "$1$2" && echo "$p"; done';
	let found = "";
	const collect = (text: string) => {
		found += text;
	};
	getOrThrow(await env.exec(["sh", "-c", script, "sh", ...tag], { onOutput: collect }, context));
	return found.trim() !== "";
}

// Needs a Docker daemon and an image, so it runs only when asked: `npm run test:live:docker`.
if (process.env.PI_TRANSPORT_LIVE_DOCKER === "1") {
	registerEnvConformance({ describe, expect, it }, "boxEnv on a Docker box", (use) =>
		withBox(async (box) => {
			const env = boxEnv(box, { watchIntervalMs: 100 });
			try {
				await use(env);
			} finally {
				await env.cleanup(context);
			}
		}),
	);

	describe("boxEnv on a Docker box", () => {
		const dirs: string[] = [];
		afterAll(() => {
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
		});

		it("gives the same results as NodeExecutionEnv for random operation sequences", async () => {
			await withBox(async (box) => {
				for (let seed = 1; seed <= SEEDS; seed++) {
					const next = random(seed);
					const nodeRoot = mkdtempSync(join(tmpdir(), "pi-transport-diff-node-"));
					dirs.push(nodeRoot);
					const boxRoot = `${box.facts().workspace}/seed-${seed}`;
					getOrThrow(await boxEnv(box).createDir(boxRoot, undefined, context));
					const node = new NodeExecutionEnv({ cwd: nodeRoot });
					const env = boxEnv(box, { cwd: boxRoot });
					for (let step = 0; step < STEPS; step++) {
						const operation = randomOperation(next);
						const expected = normalize(await operation.run(node), nodeRoot);
						const actual = normalize(await operation.run(env), boxRoot);
						expect(actual, `seed ${seed} step ${step} ${operation.label}`).toEqual(expected);
					}
				}
			});
		}, 900_000);

		it("kills the command's whole process group in the container on an abort and on a timeout", async () => {
			await withBox(async (box) => {
				const env = boxEnv(box);
				const aborted: [string, string] = ["pi-transport-abort-", `${Date.now()}`];
				const controller = new AbortController();
				const pending = env.exec(
					`sleep 300 & sleep 300 # ${aborted.join("")}\nwait`,
					undefined,
					withAbortSignal(controller.signal, context),
				);
				for (let tries = 0; !(await running(env, aborted)); tries++) {
					if (tries > 300) throw new Error("the command did not start");
					await sleep(100);
				}
				controller.abort();
				const result = await pending;
				expect(result.ok ? "" : result.error.code).toBe("aborted");
				expect(await running(env, aborted)).toBe(false);

				const timed: [string, string] = ["pi-transport-timeout-", `${Date.now()}`];
				const slow = await env.exec(`sleep 300 & sleep 300 # ${timed.join("")}\nwait`, { timeout: 1 }, context);
				expect(slow.ok ? "" : slow.error.code).toBe("timeout");
				expect(await running(env, timed)).toBe(false);
			});
		}, 60_000);

		it("sends long output to the container whole", async () => {
			await withBox(async (box) => {
				const env = boxEnv(box);
				const result = await env.exec(
					"head -c 3000000 /dev/zero | tr '\\0' 'x'; echo",
					{ spill: { afterBytes: 1000, afterLines: 100 } },
					context,
				);
				const spillPath = getOrThrow(result).spillPath ?? "";
				expect(getOrThrow(await env.fileInfo(spillPath, context)).size).toBe(3_000_001);
			});
		}, 60_000);

		it("fails every call with the reason once the container is gone", async () => {
			await withBox(async (box) => {
				const env = boxEnv(box);
				getOrThrow(await env.writeFile("a.txt", "hi", context));
				getOrThrow(await box.destroy(context));
				const read = await env.readTextFile("a.txt", context);
				expect(read.ok ? "" : read.error.message).toMatch(/is gone \(it ended/);
				const ran = await env.exec(["true"], undefined, context);
				expect(ran.ok ? "" : ran.error.code).toBe("unknown");
				expect(ran.ok ? "" : ran.error.message).toMatch(/is gone/);
			});
		}, 60_000);

		// Runs last: by now every container this file started must be gone.
		it("leaves no container behind", async () => {
			expect(getOrThrow(await provider.list(labels, context))).toEqual([]);
		});
	});
} else {
	describe.skip("boxEnv on a Docker box (set PI_TRANSPORT_LIVE_DOCKER=1)", () => {
		it("runs pi's environment conformance suite in Docker containers", () => {});
	});
}
