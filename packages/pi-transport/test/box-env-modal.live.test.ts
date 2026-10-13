import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Box } from "../src/box/box.ts";
import { modalBoxes } from "../src/box/modal.ts";
import { boxEnv } from "../src/hands/box-env.ts";
import { normalize, random, randomOperation } from "./box-env-support.ts";
import { APP_NAME, kindSpec, LABELS, loadClient, wantedKinds } from "./modal-live-support.ts";

const SEEDS = 20;
const STEPS = 25;
const SAMPLES = 20;
// The long cases keep one box for up to this long. The shared limit for a test box is 30 minutes.
const MAX_LIFETIME_MS = 30 * 60_000;
const CASE_TIMEOUT_MS = 600_000;
const DIFFERENTIAL_TIMEOUT_MS = 1_800_000;

const context = BACKGROUND_CONTEXT;

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

// Needs Modal credentials in the environment and the SDK (`npm install --no-save modal@0.11.0`), and spends money, so
// it runs only when asked: `npm run test:live:modal`. The GPU kind runs the conformance suite only.
if (process.env.PI_TRANSPORT_LIVE_MODAL === "1") {
	vi.setConfig({ testTimeout: CASE_TIMEOUT_MS, hookTimeout: CASE_TIMEOUT_MS });
	const client = await loadClient();
	for (const kind of wantedKinds()) {
		const provider = modalBoxes(client, { appName: APP_NAME });
		const base = kindSpec(kind);
		const withBox = async (use: (box: Box) => Promise<void>): Promise<void> => {
			const box = getOrThrow(await provider.create({ ...base, maxLifetimeMs: MAX_LIFETIME_MS }, context));
			try {
				await use(box);
			} finally {
				await box.destroy(context);
			}
		};

		describe(`boxEnv on a Modal ${kind.name} box`, () => {
			const started = Date.now();
			registerEnvConformance({ describe, expect, it }, `boxEnv on a Modal ${kind.name} box`, (use) =>
				withBox(async (box) => {
					const env = boxEnv(box, { watchIntervalMs: 100 });
					try {
						await use(env);
					} finally {
						await env.cleanup(context);
					}
				}),
			);

			if (kind.gpu === undefined) {
				const dirs: string[] = [];
				afterAll(() => {
					for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
				});

				it(
					"gives the same results as NodeExecutionEnv for random operation sequences",
					async () => {
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
					},
					DIFFERENTIAL_TIMEOUT_MS,
				);

				it("measures one file operation and one short command through boxEnv", async () => {
					await withBox(async (box) => {
						const env = boxEnv(box);
						const timed = async (call: () => Promise<unknown>): Promise<number[]> => {
							const samples: number[] = [];
							for (let index = 0; index < SAMPLES; index++) {
								const before = performance.now();
								await call();
								samples.push(performance.now() - before);
							}
							return samples;
						};
						getOrThrow(await env.writeFile("probe.txt", "hello", context));
						const read = await timed(async () => getOrThrow(await env.readTextFile("probe.txt", context)));
						const write = await timed(async () => getOrThrow(await env.writeFile("probe.txt", "hello", context)));
						const command = await timed(async () =>
							getOrThrow(await env.exec(["echo", "hi"], undefined, context)),
						);
						console.log(
							`boxEnv on modal ${kind.name}: p50 of ${SAMPLES}: readTextFile ${Math.round(median(read))} ms, writeFile ${Math.round(median(write))} ms, exec echo ${Math.round(median(command))} ms`,
						);
					});
				});
			}

			// Runs last: by now every box this file started must be gone.
			it("leaves no box behind", async () => {
				const left = getOrThrow(await provider.list(LABELS, context));
				for (const ref of left) {
					const box = getOrThrow(await provider.attach(ref.id, context));
					if (box !== undefined) await box.destroy(context);
				}
				console.log(
					`boxEnv on modal ${kind.name}: suite wall time ${Math.round((Date.now() - started) / 1000)} s, boxes left ${left.length}`,
				);
				expect(left).toEqual([]);
			});
		});
	}
} else {
	describe.skip("boxEnv on a Modal box (set PI_TRANSPORT_LIVE_MODAL=1)", () => {
		it("runs pi's environment conformance suite on Modal boxes", () => {});
	});
}
