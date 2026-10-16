import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box, BoxProvider } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { type BoxMade, type BoxPrice, type BoxReceipt, boxReceipts } from "../src/box/receipts.ts";
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

/** Two providers' prices, made up for the tests. */
const TWO_PRICES: readonly BoxPrice[] = [
	{
		provider: "slow",
		kind: "none",
		usdPerSecond: 0.0002,
		source: "https://prices.example/slow",
		priced: "2026-10-16",
	},
	{
		provider: "fast",
		kind: "none",
		usdPerSecond: 0.0001,
		source: "https://prices.example/fast",
		priced: "2026-10-16",
	},
];

/** `inner` under another name, each box it is asked for made only when the test lets the next one through. */
function held(name: string, inner: BoxProvider) {
	const waiting: (() => void)[] = [];
	const provider: BoxProvider = {
		name,
		async create(spec, context) {
			await new Promise<void>((resolve) => waiting.push(resolve));
			return inner.create(spec, context);
		},
		attach: (id, context) => inner.attach(id, context),
		list: (labels, context) => inner.list(labels, context),
	};
	return { provider, next: () => waiting.shift()?.() };
}

/** Two providers over local boxes that answer when the test says, a ledger over both, and what it wrote. */
function twoOf(label?: (made: BoxMade) => string) {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-receipts-two-"));
	let clock = Date.parse("2026-10-16T00:00:00.000Z");
	const written: BoxReceipt[] = [];
	const ledger = boxReceipts({
		prices: TWO_PRICES,
		write: (receipt) => written.push(receipt),
		now: () => clock,
		...(label === undefined ? {} : { label }),
	});
	const slow = held("slow", localBoxes({ root: join(root, "slow") }));
	const fast = held("fast", localBoxes({ root: join(root, "fast") }));
	return {
		slow: { ...slow, provider: ledger.wrap(slow.provider) },
		fast: { ...fast, provider: ledger.wrap(fast.provider) },
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

	it("names each box it made by its label, keeps a provider wrapped twice on the ledger once, and names no other box", async () => {
		const made = ledgerOf();
		try {
			const ledger = boxReceipts({ prices: PRICES, write: (receipt) => made.written.push(receipt) });
			const once = ledger.wrap(made.raw);
			expect(ledger.wrap(once)).toBe(once);
			const box = getOrThrow(await ledger.wrap(once).create({ maxLifetimeMs: 60_000 }, context));
			const foreign = getOrThrow(await made.raw.create({ maxLifetimeMs: 60_000 }, context));
			expect(ledger.labelOf(made.raw.name, box.id)).toBe("box-1");
			expect(ledger.labelOf(made.raw.name, foreign.id)).toBeUndefined();
			getOrThrow(await box.destroy(context));
			getOrThrow(await foreign.destroy(context));
			// One receipt for the box, and its label kept after it ended.
			expect(made.written.map(({ box: label }) => label)).toEqual(["box-1"]);
			expect(ledger.labelOf(made.raw.name, box.id)).toBe("box-1");
		} finally {
			made.remove();
		}
	});

	it("labels the boxes of a slower and a faster provider as they are made, each receipt with its own box's provider and price", async () => {
		const two = twoOf();
		try {
			// The slow provider's box is asked for first and made last.
			const askedFirst = two.slow.provider.create({ maxLifetimeMs: 60_000 }, context);
			const askedSecond = two.fast.provider.create({ maxLifetimeMs: 60_000 }, context);
			two.fast.next();
			const fast = getOrThrow(await askedSecond);
			two.tick(1_000);
			two.slow.next();
			const slow = getOrThrow(await askedFirst);
			two.tick(2_000);
			getOrThrow(await slow.destroy(context));
			getOrThrow(await fast.destroy(context));
			expect(
				two.written.map(({ box, provider, seconds, usd_per_second }) => ({
					box,
					provider,
					seconds,
					usd_per_second,
				})),
			).toEqual([
				{ box: "box-2", provider: "slow", seconds: 2, usd_per_second: 0.0002 },
				{ box: "box-1", provider: "fast", seconds: 3, usd_per_second: 0.0001 },
			]);
		} finally {
			two.remove();
		}
	});

	it("shows the host's labeler each box's own request and facts when it is made, so its labels follow the boxes", async () => {
		const shown: BoxMade[] = [];
		const two = twoOf((made) => {
			shown.push(made);
			return `${made.spec.labels?.role}`;
		});
		try {
			const home = two.slow.provider.create({ maxLifetimeMs: 60_000, labels: { role: "home" } }, context);
			const hands = two.fast.provider.create({ maxLifetimeMs: 60_000, labels: { role: "hands-1" } }, context);
			expect(shown).toEqual([]);
			two.fast.next();
			const handsBox = getOrThrow(await hands);
			two.slow.next();
			const homeBox = getOrThrow(await home);
			getOrThrow(await handsBox.destroy(context));
			getOrThrow(await homeBox.destroy(context));
			expect(
				shown.map(({ provider, kind, spec, facts }) => [provider, kind, spec.labels?.role, facts.isolation]),
			).toEqual([
				["fast", "none", "hands-1", "none"],
				["slow", "none", "home", "none"],
			]);
			expect(shown.every((made) => !("id" in made))).toBe(true);
			expect(two.written.map(({ box, provider }) => ({ box, provider }))).toEqual([
				{ box: "hands-1", provider: "fast" },
				{ box: "home", provider: "slow" },
			]);
		} finally {
			two.remove();
		}
	});

	it("after a restart numbers on past the recording's labels and receipts no box the killed process made or was making", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-receipts-restart-"));
		const raw = localBoxes({ root: join(root, "boxes") });
		let clock = Date.parse("2026-10-16T00:00:00.000Z");
		const written: BoxReceipt[] = [];
		const write = (receipt: BoxReceipt) => written.push(receipt);
		try {
			// Before the restart: box-1 is left open, box-2 is ended (the recording's one receipt), and the process is
			// killed while its provider makes a third box, before it hears back.
			const before = boxReceipts({ prices: PRICES, write, now: () => clock });
			let madeUnheard!: (box: Box) => void;
			const unheard = new Promise<Box>((resolve) => {
				madeUnheard = resolve;
			});
			const dying = before.wrap({
				name: raw.name,
				async create(spec, context) {
					const made = await raw.create(spec, context);
					if (made.ok && spec.labels?.killed === "while making") {
						madeUnheard(made.value);
						return new Promise(() => {});
					}
					return made;
				},
				attach: (id, context) => raw.attach(id, context),
				list: (labels, context) => raw.list(labels, context),
			});
			const left = getOrThrow(await dying.create({ maxLifetimeMs: 60_000 }, context));
			getOrThrow(await getOrThrow(await dying.create({ maxLifetimeMs: 60_000 }, context)).destroy(context));
			void dying.create({ maxLifetimeMs: 60_000, labels: { killed: "while making" } }, context);
			const leaked = await unheard;
			expect(written.map(({ box }) => box)).toEqual(["box-2"]);

			const after = boxReceipts({ prices: PRICES, write, now: () => clock, taken: written.map(({ box }) => box) });
			const boxes = after.wrap(raw);
			// The restarted host sweeps what the killed one left: neither box is its to receipt.
			for (const id of [left.id, leaked.id])
				getOrThrow(await found(boxes, id).then((there) => there.destroy(context)));
			const own = getOrThrow(await boxes.create({ maxLifetimeMs: 60_000 }, context));
			clock += 4_000;
			getOrThrow(await own.destroy(context));
			expect(written.map(({ box, seconds }) => ({ box, seconds }))).toEqual([
				{ box: "box-2", seconds: 0 },
				{ box: "box-3", seconds: 4 },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
