import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type ArchilExecClient, type ArchilExecDisk, archilExecBoxes } from "../src/box/archil-exec.ts";
import type { Box, BoxSpec } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const context = BACKGROUND_CONTEXT;
const SDK_VERSION = "1.9.0";
const CASE_TIMEOUT_MS = 180_000;
const SPEC: BoxSpec = { maxLifetimeMs: 20 * 60_000, labels: { "live-suite": "archil-exec" } };

type DiskOwner = { delete(): Promise<void> };
type Sdk = {
	Archil: new (options: {
		apiKey: string;
		region: string;
	}) => ArchilExecClient & {
		disks: {
			create(request: { name: string }): Promise<{ disk: ArchilExecDisk & DiskOwner }>;
			list(): Promise<{ id: string; name: string }[]>;
		};
	};
};

// Needs the Archil API key in ARCHIL_API_KEY (the host's scratch key; run it through its secret wrapper, never print it)
// and the SDK, which is not a dependency of this package: `npm install --no-save disk@1.9.0`. It makes its own new work
// disk in aws-us-east-1, runs on it, deletes it at the end and checks that none is left. It spends cents, so it runs
// only when asked: `PI_TRANSPORT_LIVE_ARCHIL=1 npm run test:live -w @parcha/pi-transport`.
if (process.env.PI_TRANSPORT_LIVE_ARCHIL === "1") {
	vi.setConfig({ testTimeout: CASE_TIMEOUT_MS, hookTimeout: CASE_TIMEOUT_MS });
	const apiKey = process.env.ARCHIL_API_KEY;
	if (apiKey === undefined || apiKey === "") throw new Error("the live Archil suite needs ARCHIL_API_KEY");
	const region = "aws-us-east-1";
	const specifier = "disk";
	let sdk: Sdk;
	try {
		sdk = (await import(specifier)) as Sdk;
	} catch (cause) {
		throw new Error(
			`the live Archil suite needs the SDK: run \`npm install --no-save disk@${SDK_VERSION}\` (${String(cause)})`,
		);
	}
	const client = new sdk.Archil({ apiKey, region });
	const name = `pi-transport-live-${randomUUID().slice(0, 8)}`;
	const { disk } = await client.disks.create({ name });
	const provider = archilExecBoxes({ client, disk });

	afterAll(async () => {
		await disk.delete();
		let left = -1;
		for (let attempt = 0; attempt < 24 && left !== 0; attempt += 1) {
			left = (await client.disks.list()).filter((one) => one.name === name).length;
			if (left !== 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
		}
		expect(left, "the live disk was deleted").toBe(0);
	});

	describe("archil exec boxes, live (own new disk, aws-us-east-1)", () => {
		registerBoxConformance({ describe, expect, it }, "archil exec boxes live", (use) => use(provider), {
			spec: SPEC,
			withoutLiveProcesses: "an exec is one request that answers when the command ends",
		});

		it("runs boxes in parallel without losing a write, and two processes on one box wait for each other", async () => {
			const boxes: Box[] = [];
			for (let n = 0; n < 5; n += 1) {
				const made = await provider.create(SPEC, context);
				if (!made.ok) throw made.error;
				boxes.push(made.value);
			}
			try {
				const results = await Promise.all(
					boxes.map(async (box, n) => {
						const started = await box.exec(["sh", "-c", `echo w${n} >> p.txt && cat p.txt`], undefined, context);
						if (!started.ok) throw started.error;
						const done = await finish(started.value);
						if (!done.ok) throw done.error;
						return new TextDecoder().decode(done.value.stdout).trim();
					}),
				);
				expect(results).toEqual(["w0", "w1", "w2", "w3", "w4"]);

				const first = boxes[0] as Box;
				const other = archilExecBoxes({ client, disk });
				const attached = await other.attach(first.id, context);
				if (!attached.ok || attached.value === undefined) throw new Error("the second process could not attach");
				const second = attached.value;
				const both = await Promise.all(
					[first, second].map(async (box, n) => {
						const started = await box.exec(
							["sh", "-c", `sleep 1; echo from${n} >> shared.txt`],
							undefined,
							context,
						);
						if (!started.ok) throw started.error;
						const done = await finish(started.value);
						return done.ok ? done.value.exitCode : -1;
					}),
				);
				expect(both).toEqual([0, 0]);
				const read = await first.download(["shared.txt"], context);
				if (!read.ok) throw read.error;
				expect(new TextDecoder().decode(read.value[0]?.bytes).trim().split("\n").sort()).toEqual([
					"from0",
					"from1",
				]);
			} finally {
				for (const box of boxes) await box.destroy(context);
			}
			const left = await provider.list({ "live-suite": "archil-exec" }, context);
			if (!left.ok) throw left.error;
			expect(left.value, `left behind: ${JSON.stringify(left.value)}`).toEqual([]);
		});
	});
}
