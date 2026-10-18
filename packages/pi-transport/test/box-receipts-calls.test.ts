import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { archilExecBoxes } from "../src/box/archil-exec.ts";
import type { Box } from "../src/box/box.ts";
import { finish, readStream } from "../src/box/files.ts";
import { type BoxPrice, type BoxReceipt, boxReceipts } from "../src/box/receipts.ts";
import { FakeArchil } from "./archil-fake.ts";

const context = BACKGROUND_CONTEXT;
const PER_CALL: BoxPrice = {
	provider: "archil-exec",
	kind: "vm",
	usdPerCall: 0.00005,
	source: "https://prices.example/archil",
	priced: "2026-10-18",
};

/** An archil-exec provider on a fake disk, under a ledger with a clock the test moves. */
function ledgerOf(prices: readonly BoxPrice[]) {
	const fake = new FakeArchil();
	let clock = Date.parse("2026-10-18T00:00:00.000Z");
	const written: BoxReceipt[] = [];
	const ledger = boxReceipts({ prices, write: (receipt) => written.push(receipt), now: () => clock });
	const provider = ledger.wrap(archilExecBoxes({ client: fake.client, disk: fake.disk }));
	return {
		fake,
		provider,
		written,
		tick: (ms: number) => {
			clock += ms;
		},
	};
}

async function call(box: Box, argv: readonly string[]) {
	const done = getOrThrow(await finish(getOrThrow(await box.exec(argv, undefined, context))));
	return done.exitCode;
}

describe("a box billed per call", () => {
	it("gets one receipt with calls and usd_per_call in place of usd_per_second, counting every call it started", async () => {
		const { fake, provider, written, tick } = ledgerOf([PER_CALL]);
		try {
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
			expect(await call(box, ["true"])).toBe(0);
			expect(await call(box, ["sh", "-c", "exit 3"])).toBe(3);
			// A call the caller gave up on ran, and is billed.
			const cancel = withCancel(context);
			const started = getOrThrow(await box.exec(["sleep", "5"], undefined, cancel.context));
			void readStream(started.stdout).catch(() => {});
			void readStream(started.stderr).catch(() => {});
			setTimeout(() => cancel.cancel(), 50);
			expect((await started.wait()).ok).toBe(false);
			// A call refused before it is made is not.
			const refused = await box.exec(["true"], { timeoutMs: 400_000 }, context);
			expect(refused.ok).toBe(false);
			tick(42_000);
			getOrThrow(await box.destroy(context));
			expect(written).toHaveLength(1);
			const receipt = written[0] as BoxReceipt;
			expect(receipt).toEqual({
				box: "box-1",
				provider: "archil-exec",
				kind: "vm",
				from: "2026-10-18T00:00:00.000Z",
				to: "2026-10-18T00:00:42.000Z",
				seconds: 42,
				calls: 3,
				usd_per_call: 0.00005,
				cost_usd: 0.00015,
				source: "https://prices.example/archil",
				priced: "2026-10-18",
			});
			expect("usd_per_second" in receipt).toBe(false);
		} finally {
			fake.close();
		}
	});

	it("rounds the cost to 9 decimals, so a validator's check of price times calls holds", async () => {
		const { fake, provider, written } = ledgerOf([{ ...PER_CALL, usdPerCall: 0.1 }]);
		try {
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
			for (let n = 0; n < 3; n += 1) await call(box, ["true"]);
			getOrThrow(await box.destroy(context));
			// 3 * 0.1 is 0.30000000000000004 in floating point.
			expect((written[0] as { cost_usd: number }).cost_usd).toBe(0.3);
		} finally {
			fake.close();
		}
	});

	it("writes a receipt with no calls for a box that was never used, at zero cost and not unknown", async () => {
		const { fake, provider, written } = ledgerOf([PER_CALL]);
		try {
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
			getOrThrow(await box.destroy(context));
			expect(written[0]).toMatchObject({ calls: 0, usd_per_call: 0.00005, cost_usd: 0 });
		} finally {
			fake.close();
		}
	});

	it("writes no receipt for a box with no price, so its cost stays unknown", async () => {
		const { fake, provider, written } = ledgerOf([]);
		try {
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 600_000 }, context));
			await call(box, ["true"]);
			getOrThrow(await box.destroy(context));
			expect(written).toEqual([]);
		} finally {
			fake.close();
		}
	});
});
