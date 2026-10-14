import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createExpectAssertions,
	type EnvConformanceAssertions,
	type StorageConformanceRunner,
} from "@earendil-works/pi-durable/testing";
import type { ConditionalStore } from "../home/ownership.ts";

const TAKERS = 50;
const ROUNDS = 20;
const READER_PASSES = 200;

/** Calls `use` once with a store that is empty and its own, then cleans up whatever the store needs. */
export type StoreConformanceProvider = (use: (store: ConditionalStore) => Promise<void>) => Promise<void>;

/** What `createStoreConformance` takes. */
export interface StoreConformanceOptions {
	readonly assertions: EnvConformanceAssertions;
	readonly withStore: StoreConformanceProvider;
	/**
	 * Starts a write of `value` to `key` that dies between the moment the value is written somewhere private and the
	 * moment it would be made the key's value, and resolves once the writer is dead. Without it the case that kills a
	 * writer is not run.
	 */
	readonly writeThatDies?: (
		store: ConditionalStore,
		key: string,
		value: Uint8Array,
		version: string | undefined,
	) => Promise<void>;
}

/** One case of the conformance suite. */
export interface StoreConformanceCase {
	readonly name: string;
	readonly timeoutMs?: number;
	run(): Promise<void>;
}

const context = BACKGROUND_CONTEXT;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

/** Runner-independent cases every `ConditionalStore` must pass before a lease is trusted on it. */
export function createStoreConformance(options: StoreConformanceOptions): StoreConformanceCase[] {
	const { assertions, withStore } = options;
	const text = (value: Uint8Array | undefined) => (value === undefined ? undefined : decoder.decode(value));
	const cases: StoreConformanceCase[] = [
		{
			name: "a key that was never written has no value",
			run: () =>
				withStore(async (store) => {
					assertions.strictEqual(unwrap(await store.get("nothing", context)), undefined);
				}),
		},
		{
			name: "an absent write makes the value, and a second absent write loses",
			run: () =>
				withStore(async (store) => {
					const first = unwrap(await store.put("k", encoder.encode("one"), { absent: true }, context));
					const got = unwrap(await store.get("k", context));
					assertions.strictEqual(text(got?.value), "one");
					assertions.strictEqual(got?.version, first.version);
					const second = await store.put("k", encoder.encode("two"), { absent: true }, context);
					assertions.strictEqual(second.ok, false);
					if (!second.ok) assertions.strictEqual(second.error.code, "conflict");
					assertions.strictEqual(text(unwrap(await store.get("k", context))?.value), "one");
				}),
		},
		{
			name: "a write at the current version makes a new version, and a write at an old one loses",
			run: () =>
				withStore(async (store) => {
					const v1 = unwrap(await store.put("k", encoder.encode("one"), { absent: true }, context));
					const v2 = unwrap(await store.put("k", encoder.encode("two"), { version: v1.version }, context));
					assertions.ok(v2.version !== v1.version, "the version changed");
					const stale = await store.put("k", encoder.encode("three"), { version: v1.version }, context);
					assertions.strictEqual(stale.ok, false);
					if (!stale.ok) assertions.strictEqual(stale.error.code, "conflict");
					const v3 = unwrap(await store.put("k", encoder.encode("three"), { version: v2.version }, context));
					const got = unwrap(await store.get("k", context));
					assertions.strictEqual(text(got?.value), "three");
					assertions.strictEqual(got?.version, v3.version);
				}),
		},
		{
			name: "a write at a version the key never had loses, and so does a conditional write on a key with no value",
			run: () =>
				withStore(async (store) => {
					const onEmpty = await store.put("empty", encoder.encode("x"), { version: "1" }, context);
					assertions.strictEqual(onEmpty.ok, false);
					unwrap(await store.put("k", encoder.encode("one"), { absent: true }, context));
					const unknown = await store.put("k", encoder.encode("x"), { version: "424242" }, context);
					assertions.strictEqual(unknown.ok, false);
					assertions.strictEqual(text(unwrap(await store.get("k", context))?.value), "one");
					assertions.strictEqual(unwrap(await store.get("empty", context)), undefined);
				}),
		},
		{
			name: "keys are independent, and any text is a key",
			run: () =>
				withStore(async (store) => {
					const keys = ["a", "a/b", "a/b/", "..", ".hidden", "über key", "x\ny", "*", "%2e", "k".repeat(150)];
					for (const key of keys)
						unwrap(await store.put(key, encoder.encode(`value of ${key}`), { absent: true }, context));
					for (const key of keys)
						assertions.strictEqual(text(unwrap(await store.get(key, context))?.value), `value of ${key}`);
				}),
		},
		{
			name: "values keep every byte, empty and large",
			run: () =>
				withStore(async (store) => {
					const all = Uint8Array.from({ length: 256 }, (_, index) => index);
					const big = new Uint8Array(1_000_000).map((_, index) => (index * 7) % 251);
					unwrap(await store.put("all", all, { absent: true }, context));
					unwrap(await store.put("empty", new Uint8Array(0), { absent: true }, context));
					unwrap(await store.put("big", big, { absent: true }, context));
					assertions.deepEqual(Array.from(unwrap(await store.get("all", context))?.value ?? []), Array.from(all));
					assertions.strictEqual(unwrap(await store.get("empty", context))?.value.length, 0);
					assertions.deepEqual(Array.from(unwrap(await store.get("big", context))?.value ?? []), Array.from(big));
				}),
		},
		{
			name: `${TAKERS} takers of the same version: one winner in each of ${ROUNDS} epochs, and the winner's value stays`,
			timeoutMs: 120_000,
			run: () =>
				withStore(async (store) => {
					let version: string | undefined;
					for (let round = 1; round <= ROUNDS; round++) {
						const results = await Promise.all(
							Array.from({ length: TAKERS }, (_, taker) =>
								store.put(
									"lease",
									encoder.encode(`round ${round} taker ${taker}`),
									version === undefined ? { absent: true } : { version },
									context,
								),
							),
						);
						const winners = results.flatMap((result, taker) =>
							result.ok ? [{ taker, version: result.value.version }] : [],
						);
						assertions.ok(winners.length === 1, `round ${round} has one winner, not ${winners.length}`);
						for (const result of results) {
							if (!result.ok) assertions.strictEqual(result.error.code, "conflict");
						}
						const winner = winners[0] as { taker: number; version: string };
						const got = unwrap(await store.get("lease", context));
						assertions.strictEqual(text(got?.value), `round ${round} taker ${winner.taker}`);
						assertions.strictEqual(got?.version, winner.version);
						version = winner.version;
					}
				}),
		},
		{
			name: "no read sees half a value while takers write",
			timeoutMs: 120_000,
			run: () =>
				withStore(async (store) => {
					const body = (round: number) => `${round}:${"x".repeat(20_000)}:${round}`;
					unwrap(await store.put("lease", encoder.encode(body(0)), { absent: true }, context));
					let writing = true;
					let stopped = false;
					let torn = 0;
					let reads = 0;
					const reader = (async () => {
						while (!stopped && (writing || reads < READER_PASSES)) {
							const got = unwrap(await store.get("lease", context));
							const value = text(got?.value) ?? "";
							const [head, , tail] = value.split(":");
							reads += 1;
							if (head === undefined || head !== tail || value.length !== body(Number(head)).length) torn += 1;
							if (!writing && reads >= READER_PASSES) break;
						}
					})();
					try {
						let version = unwrap(await store.get("lease", context))?.version as string;
						for (let round = 1; round <= ROUNDS * 3; round++) {
							const results = await Promise.all(
								Array.from({ length: 8 }, () =>
									store.put("lease", encoder.encode(body(round)), { version }, context),
								),
							);
							const won = results.find((result) => result.ok);
							assertions.ok(won?.ok === true, "someone won");
							if (won?.ok) version = won.value.version;
						}
						writing = false;
						await reader;
					} finally {
						// A failed round must not leave the reader polling the store.
						stopped = true;
						await reader.catch(() => {});
					}
					assertions.ok(torn === 0, `${torn} of ${reads} reads were torn`);
				}),
		},
	];
	if (options.writeThatDies !== undefined) {
		const dies = options.writeThatDies;
		cases.push({
			name: "a writer killed between writing its value and making it the key's value changes nothing, and the key stays writable",
			timeoutMs: 60_000,
			run: () =>
				withStore(async (store) => {
					const first = unwrap(await store.put("lease", encoder.encode("kept"), { absent: true }, context));
					await dies(store, "lease", encoder.encode("never"), first.version);
					const got = unwrap(await store.get("lease", context));
					assertions.strictEqual(text(got?.value), "kept");
					assertions.strictEqual(got?.version, first.version);
					const next = unwrap(
						await store.put("lease", encoder.encode("after"), { version: first.version }, context),
					);
					assertions.strictEqual(text(unwrap(await store.get("lease", context))?.value), "after");
					assertions.strictEqual(unwrap(await store.get("lease", context))?.version, next.version);
					await dies(store, "fresh", encoder.encode("never"), undefined);
					assertions.strictEqual(unwrap(await store.get("fresh", context)), undefined);
					unwrap(await store.put("fresh", encoder.encode("now"), { absent: true }, context));
				}),
		});
	}
	return cases;
}

/** Registers the store conformance cases with a Vitest or Jest compatible test runner. */
export function registerStoreConformance(
	runner: StorageConformanceRunner,
	name: string,
	withStore: StoreConformanceProvider,
	options: Omit<StoreConformanceOptions, "assertions" | "withStore"> = {},
): void {
	const cases = createStoreConformance({ ...options, assertions: createExpectAssertions(runner.expect), withStore });
	runner.describe(name, () => {
		for (const testCase of cases) runner.it(testCase.name, testCase.run, testCase.timeoutMs);
	});
}
