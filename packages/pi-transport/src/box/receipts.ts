import type { Context } from "@earendil-works/chord";
import { ok } from "@earendil-works/pi-durable/env";
import type { Box, BoxFacts, BoxProvider } from "./box.ts";

/**
 * A published list price for one provider's kind of box, as the host read it: `source` is the page it was read from
 * and `priced` the ISO date it was read. The host passes its prices; this package holds no price table.
 */
export type BoxPrice = {
	readonly provider: string;
	readonly kind: string;
	readonly usdPerSecond: number;
	readonly source: string;
	readonly priced: string;
};

/**
 * What one box cost at list price, written once when the box ends: the `data` of a live line with source `transport`
 * and kind `box.receipt` (RECORDING.md). `box` is a label (`box-1`, `box-2`, ... by first appearance), never the
 * provider's id. `from` and `to` are ISO times. `cost_usd` is an ESTIMATE, `seconds` times the published price per
 * second: not the provider's invoice, which bills by its own rounding, minimums and discounts.
 */
export type BoxReceipt = {
	readonly box: string;
	readonly provider: string;
	readonly kind: string;
	readonly from: string;
	readonly to: string;
	readonly seconds: number;
	readonly usd_per_second: number;
	readonly cost_usd: number;
	readonly source: string;
	readonly priced: string;
};

export type BoxReceiptsOptions = {
	readonly prices: readonly BoxPrice[];
	/**
	 * Called once for each box that ends, with its receipt; the host writes it as a live line, source `transport`, kind
	 * `box.receipt`. A box with no price is never written: its cost stays unknown, never 0.
	 */
	readonly write: (receipt: BoxReceipt) => void;
	/**
	 * The kind a box's price is found under, from its facts. Default: `gpu:<gpu>` for a box with a GPU, else its
	 * isolation (`none`, `container`, `gvisor`, `vm`).
	 */
	readonly kindOf?: (facts: BoxFacts) => string;
	/** The label of a box, by first appearance. Default `box-<n>`; a host that labels boxes of its own passes its labeler. */
	readonly label?: () => string;
	readonly now?: () => number;
};

/** A ledger of the boxes its providers make, with a receipt for each when it ends. */
export type BoxReceipts = {
	/**
	 * `provider` with every box it makes on the ledger. The box ends when it is destroyed through it, when its `status`
	 * says it ended, or when `attach` finds it gone (a box ended by its lifetime, under the run): a sweep that ends a
	 * leaked box through it is the third. Hand the wrapped providers to everything that makes boxes (a box place, the
	 * transport's hands pools through `TransportHost.providers`).
	 */
	wrap(provider: BoxProvider): BoxProvider;
};

function defaultKind(facts: BoxFacts): string {
	return facts.gpu !== null ? `gpu:${facts.gpu}` : facts.isolation;
}

/** Keep a receipt for each box the wrapped providers make, written once when it ends. */
export function boxReceipts(options: BoxReceiptsOptions): BoxReceipts {
	const now = options.now ?? Date.now;
	const kindOf = options.kindOf ?? defaultKind;
	let count = 0;
	const label =
		options.label ??
		(() => {
			count += 1;
			return `box-${count}`;
		});
	// The boxes made and not yet ended, by provider and id.
	const open = new Map<
		string,
		{ readonly provider: string; readonly kind: string; readonly from: number; readonly box: string }
	>();

	const end = (key: string) => {
		const made = open.get(key);
		if (made === undefined) return;
		open.delete(key);
		const price = options.prices.find((one) => one.provider === made.provider && one.kind === made.kind);
		if (price === undefined) return;
		const to = Math.max(made.from, now());
		const seconds = (to - made.from) / 1000;
		options.write({
			box: made.box,
			provider: made.provider,
			kind: made.kind,
			from: new Date(made.from).toISOString(),
			to: new Date(to).toISOString(),
			seconds,
			usd_per_second: price.usdPerSecond,
			cost_usd: seconds * price.usdPerSecond,
			source: price.source,
			priced: price.priced,
		});
	};

	const onLedger = (key: string, box: Box): Box =>
		new Proxy(box, {
			get(target, property) {
				if (property === "destroy") {
					return async (context: Context) => {
						const destroyed = await target.destroy(context);
						if (destroyed.ok) end(key);
						return destroyed;
					};
				}
				if (property === "status") {
					return async (context: Context) => {
						const read = await target.status(context);
						if (read.ok && read.value.state === "ended") end(key);
						return read;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

	return {
		wrap(inner) {
			const keyOf = (id: string) => `${inner.name}\u0000${id}`;
			return {
				name: inner.name,
				async create(spec, context) {
					const made = await inner.create(spec, context);
					if (!made.ok) return made;
					const key = keyOf(made.value.id);
					open.set(key, { provider: inner.name, kind: kindOf(made.value.facts()), from: now(), box: label() });
					return ok(onLedger(key, made.value));
				},
				async attach(id, context) {
					const found = await inner.attach(id, context);
					if (!found.ok) return found;
					const key = keyOf(id);
					if (found.value === undefined) {
						end(key);
						return found;
					}
					// A box another process or host made is its maker's to receipt.
					return open.has(key) ? ok(onLedger(key, found.value)) : found;
				},
				list: (labels, context) => inner.list(labels, context),
			};
		},
	};
}
