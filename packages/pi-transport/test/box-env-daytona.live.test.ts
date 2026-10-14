import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Box } from "../src/box/box.ts";
import { daytonaBoxes } from "../src/box/daytona.ts";
import { boxEnv } from "../src/hands/box-env.ts";
import { normalize, random, randomOperation } from "./box-env-support.ts";

const SEEDS = Number(process.env.PI_TRANSPORT_LIVE_SEEDS ?? 20);
const STEPS = 25;
const SAMPLES = 20;
const MAX_LIFETIME_MS = 29 * 60_000;
const TEST_TIMEOUT_MS = 300_000;
const DIFFERENTIAL_TIMEOUT_MS = 28 * 60_000;

const context = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `a=b,c=d` as labels. */
function parseLabels(text: string): Record<string, string> {
	return Object.fromEntries(
		text
			.split(",")
			.filter((pair) => pair.includes("="))
			.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
	);
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

function p50(samples: number[]): number {
	return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? Number.NaN;
}

// Needs a Daytona organization, so it runs only when asked: `PI_TRANSPORT_LIVE_DAYTONA=1 npm run test:live`. The
// caller sets DAYTONA_API_KEY, DAYTONA_API_URL and DAYTONA_TARGET; PI_TRANSPORT_LIVE_NAME_PREFIX,
// PI_TRANSPORT_LIVE_LABELS and PI_TRANSPORT_DAYTONA_SNAPSHOT are as in box-daytona.live.test.ts, and
// PI_TRANSPORT_LIVE_SEEDS sets the random runs.
if (process.env.PI_TRANSPORT_LIVE_DAYTONA === "1") {
	vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });
	const provider = daytonaBoxes({
		apiKey: process.env.DAYTONA_API_KEY ?? "",
		...(process.env.DAYTONA_API_URL === undefined ? {} : { apiUrl: process.env.DAYTONA_API_URL }),
		...(process.env.DAYTONA_TARGET === undefined ? {} : { target: process.env.DAYTONA_TARGET }),
		snapshot: process.env.PI_TRANSPORT_DAYTONA_SNAPSHOT ?? "daytona-small",
		namePrefix: process.env.PI_TRANSPORT_LIVE_NAME_PREFIX ?? "pi-transport-live-",
	});
	// Every box of this run carries the labels, so the last test can count what the run left behind.
	const labels = {
		...parseLabels(process.env.PI_TRANSPORT_LIVE_LABELS ?? "pi-transport-live=1"),
		"pi-transport-live-run": `box-env-${process.pid}-${Date.now()}`,
	};

	async function withBox(use: (box: Box) => Promise<void>): Promise<void> {
		const box = getOrThrow(await provider.create({ maxLifetimeMs: MAX_LIFETIME_MS, labels }, context));
		try {
			await use(box);
		} finally {
			await box.destroy(context);
		}
	}

	const started = Date.now();
	registerEnvConformance({ describe, expect, it }, "boxEnv on a Daytona box", (use) =>
		withBox(async (box) => {
			const env = boxEnv(box, { watchIntervalMs: 100 });
			try {
				await use(env);
			} finally {
				await env.cleanup(context);
			}
		}),
	);

	describe("boxEnv on a Daytona box", () => {
		const dirs: string[] = [];
		afterAll(() => {
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
			console.log(`box env suite wall time: ${Math.round((Date.now() - started) / 1000)} s`);
		});

		// A directory's `size` is whatever its filesystem says: 4096 on this machine's, 6 on a Daytona box's.
		const withoutDirectorySize = (value: unknown): unknown =>
			JSON.parse(JSON.stringify(value), (_key, field: unknown) => {
				const entry = field as { kind?: unknown; size?: unknown } | null;
				if (entry !== null && typeof entry === "object" && entry.kind === "directory") return { ...entry, size: 0 };
				return field;
			});

		const sequences = () => async () => {
			const same = withoutDirectorySize;
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
						const expected = same(normalize(await operation.run(node), nodeRoot));
						const actual = same(normalize(await operation.run(env), boxRoot));
						expect(actual, `seed ${seed} step ${step} ${operation.label}`).toEqual(expected);
					}
				}
			});
		};

		it(
			"gives the same results as NodeExecutionEnv for random operation sequences, directory sizes aside",
			sequences(),
			DIFFERENTIAL_TIMEOUT_MS,
		);

		it("kills the command's whole process group in the box on an abort and on a timeout", async () => {
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
					if (tries > 100) throw new Error("the command did not start");
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
		});

		it("sends long output to the box whole", async () => {
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
		});

		it("fails every call with the reason once the box is gone", async () => {
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
		});

		it("measures what one file operation and one short command cost", async () => {
			await withBox(async (box) => {
				const env = boxEnv(box);
				const timed = async (run: () => Promise<unknown>) => {
					const samples: number[] = [];
					for (let index = 0; index < SAMPLES; index++) {
						const at = performance.now();
						await run();
						samples.push(performance.now() - at);
					}
					return Math.round(p50(samples));
				};
				getOrThrow(await env.writeFile("cost.txt", "x".repeat(1024), context));
				const cost = {
					samples: SAMPLES,
					writeFile1KiBp50Ms: await timed(async () =>
						getOrThrow(await env.writeFile("cost.txt", "x".repeat(1024), context)),
					),
					readTextFile1KiBp50Ms: await timed(async () => getOrThrow(await env.readTextFile("cost.txt", context))),
					fileInfop50Ms: await timed(async () => getOrThrow(await env.fileInfo("cost.txt", context))),
					execTrueP50Ms: await timed(async () => getOrThrow(await env.exec(["true"], undefined, context))),
					execEchoShellP50Ms: await timed(async () => getOrThrow(await env.exec("echo hi", undefined, context))),
					boxExecTrueP50Ms: await timed(async () => {
						const process = getOrThrow(await box.exec(["true"], undefined, context));
						await process.stdin.close();
						await process.wait();
					}),
				};
				console.log(`box env cost: ${JSON.stringify(cost)}`);
			});
		});

		// Runs last: by now every box this file started must be gone.
		it("leaves no box behind", async () => {
			let count = Number.POSITIVE_INFINITY;
			for (const deadline = Date.now() + 30_000; count > 0 && Date.now() < deadline; ) {
				count = getOrThrow(await provider.list(labels, context)).length;
				if (count > 0) await sleep(1000);
			}
			console.log(`daytona boxes left by label: ${count}`);
			expect(count).toBe(0);
		});
	});
} else {
	describe.skip("boxEnv on a Daytona box (set PI_TRANSPORT_LIVE_DAYTONA=1)", () => {
		it("runs pi's environment conformance suite in Daytona boxes", () => {});
	});
}
