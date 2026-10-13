import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { probeAcknowledgedWrites } from "../src/testing/index.ts";
import { sh } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;

async function withLocalBox(use: (box: Box) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-probe-"));
	const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
	try {
		await use(box);
	} finally {
		await box.destroy(context);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

describe("probeAcknowledgedWrites", () => {
	it("finds every acknowledged write on a local box and removes its file", async () => {
		await withLocalBox(async (box) => {
			const found = getOrThrow(await probeAcknowledgedWrites(box, undefined, context));
			expect(found).toEqual({ acknowledged: 10, kept: 10 });
			expect((await sh(box, "ls -a | grep pi-transport-probe | wc -l")).text.trim()).toBe("0");
		});
	});

	it("takes a count and a path", async () => {
		await withLocalBox(async (box) => {
			const found = getOrThrow(await probeAcknowledgedWrites(box, { count: 3, path: "probe/records.log" }, context));
			expect(found).toEqual({ acknowledged: 3, kept: 3 });
		});
	});

	it("kills only the writer: the box stays up and the writer is gone", async () => {
		await withLocalBox(async (box) => {
			getOrThrow(await probeAcknowledgedWrites(box, { count: 2 }, context));
			expect(getOrThrow(await box.status(context)).state).toBe("running");
		});
	});

	it("reports a mismatch as a result when the file holds fewer records than were acknowledged", async () => {
		await withLocalBox(async (box) => {
			// A box whose read of the file loses the last record, as a runtime that acknowledges early would.
			const lossy: Box = {
				id: box.id,
				facts: () => box.facts(),
				exec: async (command, options, ctx) => {
					const script = command.join(" ");
					if (script.includes("cat --")) {
						return box.exec(
							["sh", "-c", 'cat -- "$1" | head -n -1; rm -f -- "$1"', "sh", command.at(-1) ?? ""],
							options,
							ctx,
						);
					}
					return box.exec(command, options, ctx);
				},
				upload: (files, ctx) => box.upload(files, ctx),
				download: (paths, ctx) => box.download(paths, ctx),
				status: (ctx) => box.status(ctx),
				destroy: (ctx) => box.destroy(ctx),
			};
			expect(getOrThrow(await probeAcknowledgedWrites(lossy, { count: 4 }, context))).toEqual({
				acknowledged: 4,
				kept: 3,
			});
		});
	});

	it("refuses a count that is not a positive integer", async () => {
		await withLocalBox(async (box) => {
			for (const count of [0, -1, 1.5]) {
				const result = await probeAcknowledgedWrites(box, { count }, context);
				expect(result.ok ? "ok" : result.error.code).toBe("invalid");
			}
		});
	});

	it("gives up with a timeout error when the writer is too slow", async () => {
		await withLocalBox(async (box) => {
			const result = await probeAcknowledgedWrites(box, { count: 1_000_000, timeoutMs: 800 }, context);
			expect(result.ok ? "ok" : result.error.code).toBe("timeout");
		});
	});
});
