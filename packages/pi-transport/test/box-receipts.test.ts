import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box, BoxProvider } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { type BoxPrice, type BoxReceipt, boxReceipts } from "../src/box/receipts.ts";
import { registerHandsCases } from "./hands-support.ts";

const context = BACKGROUND_CONTEXT;

/** A host's price table, made up for the tests: this package holds none. */
const PRICES: readonly BoxPrice[] = [
	{
		provider: "local",
		kind: "none",
		usdPerSecond: 0.0001,
		source: "https://prices.example/local",
		priced: "2026-10-16",
	},
];

/** A ledger over local boxes with a clock the test moves, what it wrote, and the same boxes without the ledger. */
function ledgerOf(prices: readonly BoxPrice[] = PRICES, kindOf?: () => string) {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-receipts-"));
	let clock = Date.parse("2026-10-16T00:00:00.000Z");
	const written: BoxReceipt[] = [];
	const ledger = boxReceipts({
		prices,
		write: (receipt) => written.push(receipt),
		now: () => clock,
		...(kindOf === undefined ? {} : { kindOf }),
	});
	return {
		provider: ledger.wrap(localBoxes({ root: join(root, "boxes") })),
		raw: localBoxes({ root: join(root, "boxes") }),
		written,
		tick: (ms: number) => {
			clock += ms;
		},
		remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
	};
}

/** The box with this id, which must be there. */
async function found(provider: BoxProvider, id: string): Promise<Box> {
	const box = getOrThrow(await provider.attach(id, context));
	if (box === undefined) throw new Error(`no box ${id}`);
	return box;
}

describe("box receipts", () => {
	it("writes one receipt at list price when a box is destroyed, with a label and never the provider's id", async () => {
		const made = ledgerOf();
		try {
			const box = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			made.tick(12_500);
			getOrThrow(await box.destroy(context));
			getOrThrow(await box.destroy(context));
			expect(made.written).toEqual([
				{
					box: "box-1",
					provider: "local",
					kind: "none",
					from: "2026-10-16T00:00:00.000Z",
					to: "2026-10-16T00:00:12.500Z",
					seconds: 12.5,
					usd_per_second: 0.0001,
					cost_usd: 12.5 * 0.0001,
					source: "https://prices.example/local",
					priced: "2026-10-16",
				},
			]);
			expect(JSON.stringify(made.written)).not.toContain(box.id);
		} finally {
			made.remove();
		}
	});

	it("writes no receipt for a box with no price, so its cost stays unknown, and labels follow the boxes", async () => {
		let n = 0;
		const made = ledgerOf(PRICES, () => {
			n += 1;
			return n === 1 ? "a kind with no price" : "none";
		});
		try {
			const unpriced = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			const priced = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			made.tick(1_000);
			getOrThrow(await unpriced.destroy(context));
			getOrThrow(await priced.destroy(context));
			expect(made.written.map(({ box, kind, cost_usd }) => ({ box, kind, cost_usd }))).toEqual([
				{ box: "box-2", kind: "none", cost_usd: 0.0001 },
			]);
		} finally {
			made.remove();
		}
	});

	it("writes the receipt of a box found ended or gone under the run, and none for a box it did not make", async () => {
		const made = ledgerOf();
		try {
			const ended = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			const gone = getOrThrow(await made.provider.create({ maxLifetimeMs: 60_000 }, context));
			const foreign = getOrThrow(await made.raw.create({ maxLifetimeMs: 60_000 }, context));
			made.tick(3_000);
			// Ended behind the ledger's back, as a lifetime or another host's sweep ends them.
			for (const box of [ended, gone])
				getOrThrow(await found(made.raw, box.id).then((there) => there.destroy(context)));
			expect(getOrThrow(await ended.status(context)).state).toBe("ended");
			expect(getOrThrow(await made.provider.attach(gone.id, context))).toBeUndefined();
			getOrThrow(await found(made.provider, foreign.id).then((there) => there.destroy(context)));
			expect(made.written.map(({ box, seconds }) => ({ box, seconds }))).toEqual([
				{ box: "box-1", seconds: 3 },
				{ box: "box-2", seconds: 3 },
			]);
		} finally {
			made.remove();
		}
	});
});

// The hands pools: the transport makes its tool boxes through the providers the host hands it, so a wrapped provider
// receipts every box a pool makes and ends.
const handsWritten: BoxReceipt[] = [];
registerHandsCases(
	"hands on local boxes, every box on a receipts ledger",
	async (use) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-receipts-hands-"));
		const ledger = boxReceipts({ prices: PRICES, write: (receipt) => handsWritten.push(receipt) });
		try {
			await use({
				provider: () => ledger.wrap(localBoxes({ root: join(directory, "boxes") })),
				environment: { provider: "local" },
				directory,
			});
		} finally {
			rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	},
	60_000,
);
afterAll(() => {
	expect(handsWritten.length).toBeGreaterThan(0);
	for (const receipt of handsWritten) {
		expect(receipt).toMatchObject({ provider: "local", kind: "none", usd_per_second: 0.0001 });
		expect(receipt.box).toMatch(/^box-\d+$/);
		expect(receipt.cost_usd).toBeCloseTo(receipt.seconds * 0.0001, 12);
	}
});
