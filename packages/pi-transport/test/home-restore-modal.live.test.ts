import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Box } from "../src/box/box.ts";
import { modalBoxes } from "../src/box/modal.ts";
import type { Place } from "../src/home/move.ts";
import { registerRestoreConformance } from "../src/testing/move-conformance.ts";
import { APP_NAME, loadClient, SPEC_LABELS } from "./modal-live-support.ts";

const context = BACKGROUND_CONTEXT;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "home-move-runner.fixture.ts");
const LIFETIME_MS = 30 * 60_000;
/** An image with Node in it: the runner is one file, and the box runs it with its own node. */
const IMAGE = "node:22-slim";
const WANTED =
	process.env.PI_TRANSPORT_LIVE_RESTORE_CASE ?? "rebuilds a session whose box was destroyed after a checkpoint";

// Spends money and needs Modal credentials, so it runs only when asked: PI_TRANSPORT_LIVE_HOME_RESTORE=1. It kills a real
// Modal sandbox after a checkpoint (the provider's terminate) and rebuilds the session in a second one. Two boxes alive at
// most: `b` is `c` (the basic case moves nothing). The timeline of the boxes' calls is printed with the case.
if (process.env.PI_TRANSPORT_LIVE_HOME_RESTORE === "1") {
	vi.setConfig({ testTimeout: 900_000, hookTimeout: 600_000 });
	const directory = mkdtempSync(join(tmpdir(), "pi-transport-restore-modal-"));
	const bundle = join(directory, "runner.mjs");
	const boxes: Box[] = [];
	let t0 = performance.now();
	const stamp = (text: string) => console.log(`${(performance.now() - t0).toFixed(0).padStart(8)} ms  ${text}`);
	const logged = (name: string, box: Box): Box =>
		new Proxy(box, {
			get(target, key) {
				const value = Reflect.get(target, key) as unknown;
				if (typeof value !== "function" || key === "facts")
					return typeof value === "function" ? value.bind(target) : value;
				return async (...args: unknown[]) => {
					const started = performance.now();
					if (key === "exec") stamp(`${name} exec ${(args[0] as string[]).join(" ").slice(0, 80)}`);
					const out = await (value as (...a: unknown[]) => unknown).apply(target, args);
					if (key !== "exec") stamp(`${name} ${String(key)} took ${(performance.now() - started).toFixed(0)} ms`);
					return out;
				};
			},
		});
	beforeAll(async () => {
		await build({
			entryPoints: [FIXTURE],
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			outfile: bundle,
			logLevel: "warning",
		});
	}, 60_000);
	afterAll(async () => {
		for (const box of boxes) {
			const destroyed = await box.destroy(context);
			stamp(
				`cleanup destroy ${box.id}: ${destroyed.ok ? "ok" : `${destroyed.error.code} ${destroyed.error.message}`}`,
			);
		}
		rmSync(directory, { recursive: true, force: true });
	}, 300_000);

	const provider = modalBoxes(await loadClient(), { appName: APP_NAME });
	registerRestoreConformance(
		{
			describe,
			expect,
			it: ((name: string, fn: () => Promise<void>, timeout?: number) =>
				(name.includes(WANTED) ? it : it.skip)(
					name,
					async () => {
						t0 = performance.now();
						stamp("CASE START");
						await fn();
						stamp("CASE END");
					},
					timeout,
				)) as typeof it,
		},
		"killing a real Modal sandbox and rebuilding the session in another",
		async (use) => {
			const place = async (environment: string): Promise<Place> => {
				const raw = getOrThrow(
					await provider.create(
						{ cpus: 2, labels: SPEC_LABELS, image: IMAGE, maxLifetimeMs: LIFETIME_MS },
						context,
					),
				);
				boxes.push(raw);
				stamp(`created ${environment}: ${raw.id}`);
				const box = logged(environment, raw);
				return {
					environment,
					provider: "modal",
					box,
					workspace: box.facts().workspace,
					store: "/tmp/session/run.sqlite",
				};
			};
			const a = await place("a");
			const c = await place("c");
			await use({ a, b: c, c, program: { file: bundle } });
		},
		{ timeoutMs: 600_000 },
	);
} else {
	describe.skip("killing a real Modal sandbox (set PI_TRANSPORT_LIVE_HOME_RESTORE=1)", () => {
		it("rebuilds the session in another sandbox", () => {});
	});
}
