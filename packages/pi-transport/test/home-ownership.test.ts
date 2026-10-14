import { fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import { dirStore } from "../src/home/dir-store.ts";
import { type ConditionalStore, type Holder, KeyStoreError, leaseIn } from "../src/home/ownership.ts";
import { registerStoreConformance } from "../src/testing/index.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-lease-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }));
let counter = 0;
const fresh = () => join(root, `d${counter++}`);
const GOOD_SEAL = { head: 7, sha256: "ab".repeat(32), bytes: 9 };
const holder = (name: string): Holder => ({
	environment: "env",
	provider: "local",
	box: `box-${name}`,
	host: `host-${name}`,
});

/** A store in memory, with the same contract: for the conformance suite to prove the suite itself. */
function memoryStore(): ConditionalStore {
	const data = new Map<string, { value: Uint8Array; version: number }>();
	return {
		async get(key) {
			const found = data.get(key);
			return ok(found === undefined ? undefined : { value: found.value.slice(), version: String(found.version) });
		},
		async put(key, value, when) {
			const found = data.get(key);
			const matches =
				"absent" in when ? found === undefined : found !== undefined && String(found.version) === when.version;
			if (!matches) return err(new KeyStoreError("conflict", "not at that version"));
			const version = (found?.version ?? 0) + 1;
			data.set(key, { value: value.slice(), version });
			return ok({ version: String(version) });
		},
	};
}

/** A store that lets every write through, as one without a conditional write would. */
function unconditionalStore(): ConditionalStore {
	const data = new Map<string, { value: Uint8Array; version: number }>();
	return {
		async get(key) {
			const found = data.get(key);
			return ok(found === undefined ? undefined : { value: found.value.slice(), version: String(found.version) });
		},
		async put(key, value) {
			const version = (data.get(key)?.version ?? 0) + 1;
			data.set(key, { value: value.slice(), version });
			return ok({ version: String(version) });
		},
	};
}

/** Runs the writer that dies, and resolves when it is dead. */
function dyingWriter(directory: string, key: string, value: string, version: string | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[join(import.meta.dirname, "home-dir-writer.mjs"), directory, key, value, version ?? "-"],
			{
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.once("exit", (code, signal) =>
			signal === "SIGKILL" && out === "" ? resolve() : reject(new Error(`writer ended ${code} ${signal} ${out}`)),
		);
	});
}

const directories = new WeakMap<ConditionalStore, string>();
function newDirStore(): ConditionalStore {
	const directory = fresh();
	const store = dirStore(directory);
	directories.set(store, directory);
	return store;
}

registerStoreConformance({ describe, expect, it }, "dirStore", async (use) => use(newDirStore()), {
	writeThatDies: async (store, key, value, version) => {
		const directory = directories.get(store);
		if (directory === undefined) throw new Error("not a store of this file");
		await dyingWriter(directory, key, new TextDecoder().decode(value), version);
	},
});
registerStoreConformance({ describe, expect, it }, "an in-memory store", async (use) => use(memoryStore()));

describe("the store conformance suite", () => {
	it("stops its reader when a round fails, so nothing keeps polling the store", async () => {
		const { createStoreConformance } = await import("../src/testing/index.ts");
		const { createExpectAssertions } = await import("@earendil-works/pi-durable/testing");
		const inner = memoryStore();
		let broken = false;
		let gets = 0;
		const store: ConditionalStore = {
			get: (key, ctx) => {
				gets += 1;
				return inner.get(key, ctx);
			},
			put: async (key, value, when, ctx) => {
				// The first write after the seeding write throws, as a failed round would.
				if (when && "version" in when && !broken) {
					broken = true;
					throw new Error("the round failed");
				}
				return inner.put(key, value, when, ctx);
			},
		};
		const cases = createStoreConformance({
			assertions: createExpectAssertions(expect),
			withStore: async (use) => use(store),
		});
		const torn = cases.find((testCase) => testCase.name.startsWith("no read sees half a value"));
		await expect(torn?.run()).rejects.toThrow("the round failed");
		const after = gets;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(gets).toBe(after);
	}, 60_000);

	it("fails a store whose writes are not conditional", async () => {
		const { createStoreConformance } = await import("../src/testing/index.ts");
		const { createExpectAssertions } = await import("@earendil-works/pi-durable/testing");
		const cases = createStoreConformance({
			assertions: createExpectAssertions(expect),
			withStore: async (use) => use(unconditionalStore()),
		});
		const outcomes: boolean[] = [];
		for (const testCase of cases) {
			outcomes.push(
				await testCase.run().then(
					() => true,
					() => false,
				),
			);
		}
		expect(outcomes.filter((passed) => !passed).length).toBeGreaterThanOrEqual(3);
	}, 120_000);
});

describe("dirStore keys", () => {
	it("refuses the empty key, for reading and writing", async () => {
		const store = newDirStore();
		const put = await store.put("", new Uint8Array(1), { absent: true }, context);
		expect(put.ok ? "" : put.error.code).toBe("invalid");
		const got = await store.get("", context);
		expect(got.ok ? "" : got.error.code).toBe("invalid");
		expect(existsSync(join(directories.get(store) as string, "k-"))).toBe(false);
	});

	it("names every key by a fixed prefix and without case, so no two keys share a directory on any file system", async () => {
		const store = newDirStore();
		const root = directories.get(store) as string;
		const keys = ["A", "a", "B", "b", "Lease", "lease", "LEASE", "1", ".tmp-x", "k-a", "%41", "ÄÖ", "äö"];
		for (const key of keys)
			getOrThrow(await store.put(key, new TextEncoder().encode(`v:${key}`), { absent: true }, context));
		for (const key of keys) {
			expect(new TextDecoder().decode(getOrThrow(await store.get(key, context))?.value), key).toBe(`v:${key}`);
		}
		const names = readdirSync(root);
		expect(names.length).toBe(keys.length);
		expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(keys.length);
		expect(names.every((name) => name.startsWith("k-"))).toBe(true);
		expect(names.some((name) => name.startsWith(".tmp-") || /^\d+$/.test(name))).toBe(false);
	});

	it("writes a value of many megabytes whole", async () => {
		const store = newDirStore();
		const big = new Uint8Array(24 * 1024 * 1024).map((_, index) => (index * 13) % 251);
		getOrThrow(await store.put("big", big, { absent: true }, context));
		const got = getOrThrow(await store.get("big", context));
		expect(got?.value.length).toBe(big.length);
		expect(Buffer.from(got?.value ?? new Uint8Array()).equals(Buffer.from(big))).toBe(true);
	});
});

describe("dirStore", () => {
	it("leaves the temp file of a writer that died and ignores it", async () => {
		const store = newDirStore();
		const directory = directories.get(store) as string;
		getOrThrow(await store.put("k", new TextEncoder().encode("a"), { absent: true }, context));
		await dyingWriter(directory, "k", "b", "1");
		const names = readdirSync(join(directory, "k-k"));
		expect(names.some((name) => name.startsWith(".tmp-"))).toBe(true);
		expect(getOrThrow(await store.get("k", context))?.version).toBe("1");
	});

	it("keeps no temp file after a write that won or one that lost", async () => {
		const store = newDirStore();
		const directory = directories.get(store) as string;
		getOrThrow(await store.put("k", new TextEncoder().encode("a"), { absent: true }, context));
		const lost = await store.put("k", new TextEncoder().encode("b"), { absent: true }, context);
		expect(lost.ok).toBe(false);
		getOrThrow(await store.put("k", new TextEncoder().encode("c"), { version: "1" }, context));
		expect(readdirSync(join(directory, "k-k")).sort()).toEqual(["1", "2"]);
	});

	it("returns an error, and throws none, for a directory it cannot use", async () => {
		const directory = fresh();
		mkdirSync(directory);
		writeFileSync(join(directory, "file"), "x");
		const store = dirStore(join(directory, "file", "inside"));
		const put = await store.put("k", new Uint8Array(1), { absent: true }, context);
		expect(put.ok ? "" : put.error.code).toBe("unavailable");
		const got = await store.get("k", context);
		expect(got.ok ? "" : got.error.code).toBe("unavailable");
	});

	it("keeps one winner per epoch across processes taking at the same millisecond", async () => {
		const directory = fresh();
		const workers = 12;
		const rounds = 60;
		const results = new Map<number, { name: string; won: boolean; code: string }[]>();
		const children = Array.from({ length: workers }, (_, index) => {
			const child = fork(join(import.meta.dirname, "home-lease-worker.mjs"), [directory, `w${index}`], {
				execArgv: [],
			});
			child.on("message", (message: { epoch?: number; name: string; won: boolean; code: string }) => {
				if (message.epoch === undefined) return;
				results.set(message.epoch, [...(results.get(message.epoch) ?? []), message]);
			});
			return child;
		});
		try {
			await Promise.all(
				children.map(
					(child) =>
						new Promise((resolve, reject) => {
							child.once("message", resolve);
							child.once("exit", (code) =>
								reject(new Error(`a taker process ended with ${code} before it was ready`)),
							);
							setTimeout(() => reject(new Error("a taker process did not start")), 30_000).unref();
						}),
				),
			);
			for (let epoch = 1; epoch <= rounds; epoch++) {
				const at = Date.now() + 25;
				for (const child of children) child.send({ epoch, at });
				for (let waited = 0; (results.get(epoch)?.length ?? 0) < workers; waited++) {
					if (waited > 5000) throw new Error(`epoch ${epoch} did not finish`);
					await new Promise((resolve) => setTimeout(resolve, 2));
				}
			}
		} finally {
			for (const child of children) child.kill();
		}
		for (let epoch = 1; epoch <= rounds; epoch++) {
			const row = results.get(epoch) ?? [];
			expect(row.filter((entry) => entry.won).length, `epoch ${epoch}`).toBe(1);
			expect(row.filter((entry) => !entry.won).every((entry) => entry.code === "lost")).toBe(true);
		}
		const lease = leaseIn(dirStore(directory));
		expect(getOrThrow(await lease.current("session", context))?.epoch).toBe(rounds);
		expect(existsSync(join(directory, "k-lease%2Fsession"))).toBe(true);
	}, 120_000);
});

describe("leaseIn", () => {
	for (const [name, make] of [
		["dirStore", newDirStore],
		["a memory store", memoryStore],
	] as const) {
		describe(name, () => {
			it("has no record until a first take, then counts epochs from 1", async () => {
				const lease = leaseIn(make());
				expect(getOrThrow(await lease.current("s", context))).toBeUndefined();
				const one = getOrThrow(await lease.take("s", holder("a"), 0, undefined, context));
				expect(one).toMatchObject({ v: 1, session: "s", epoch: 1, holder: holder("a") });
				const two = getOrThrow(await lease.take("s", holder("b"), 1, { seal: GOOD_SEAL }, context));
				expect(two.epoch).toBe(2);
				expect(two.seal).toEqual(GOOD_SEAL);
				expect(getOrThrow(await lease.current("s", context))).toEqual(two);
			});

			it("loses when the expected epoch is not the current one, in either direction", async () => {
				const lease = leaseIn(make());
				getOrThrow(await lease.take("s", holder("a"), 0, undefined, context));
				for (const expected of [0, 2, 5]) {
					const taken = await lease.take("s", holder("b"), expected, undefined, context);
					expect(taken.ok ? "" : taken.error.code, `expected ${expected}`).toBe("lost");
				}
				expect(getOrThrow(await lease.current("s", context))?.holder).toEqual(holder("a"));
			});

			it("gives one session's epochs to that session only", async () => {
				const lease = leaseIn(make());
				getOrThrow(await lease.take("a", holder("a"), 0, undefined, context));
				getOrThrow(await lease.take("b", holder("b"), 0, undefined, context));
				expect(getOrThrow(await lease.current("a", context))?.holder.box).toBe("box-a");
				expect(getOrThrow(await lease.current("b", context))?.holder.box).toBe("box-b");
			});

			it("lets 50 takers of one epoch through one at a time: exactly one wins, the rest lose", async () => {
				const lease = leaseIn(make());
				getOrThrow(await lease.take("s", holder("0"), 0, undefined, context));
				const results = await Promise.all(
					Array.from({ length: 50 }, (_, index) =>
						lease.take("s", holder(String(index + 1)), 1, undefined, context),
					),
				);
				expect(results.filter((result) => result.ok).length).toBe(1);
				expect(
					results.filter((result) => !result.ok).every((result) => !result.ok && result.error.code === "lost"),
				).toBe(true);
				expect(getOrThrow(await lease.current("s", context))?.epoch).toBe(2);
			});

			it("answers a retried take of the same move with the record it made, and a take of another move with `lost`", async () => {
				const lease = leaseIn(make());
				getOrThrow(await lease.take("s", holder("a"), 0, undefined, context));
				const first = getOrThrow(await lease.take("s", holder("b"), 1, { move: "move-1" }, context));
				const again = getOrThrow(await lease.take("s", holder("b"), 1, { move: "move-1" }, context));
				expect(again).toEqual(first);
				const other = await lease.take("s", holder("c"), 1, { move: "move-2" }, context);
				expect(other.ok ? "" : other.error.code).toBe("lost");
				const none = await lease.take("s", holder("c"), 1, undefined, context);
				expect(none.ok ? "" : none.error.code).toBe("lost");
				expect(getOrThrow(await lease.current("s", context))?.epoch).toBe(2);
			});

			it("refuses what is not a take before it touches the store", async () => {
				const lease = leaseIn(make());
				const codes = [
					(await lease.take("", holder("a"), 0, undefined, context)).ok,
					(await lease.take("s", holder("a"), -1, undefined, context)).ok,
					(await lease.take("s", holder("a"), 1.5, undefined, context)).ok,
					(await lease.take("s", { ...holder("a"), box: "" }, 0, undefined, context)).ok,
					(await lease.take("s", holder("a"), 0, { move: "" }, context)).ok,
					(await lease.take("s", holder("a"), 0, { seal: { head: 1, sha256: "x", bytes: 1 } }, context)).ok,
				];
				expect(codes).toEqual([false, false, false, false, false, false]);
				expect(getOrThrow(await lease.current("s", context))).toBeUndefined();
			});
		});
	}

	it("says `corrupt` for a record that is not a lease, and `unavailable` when the store fails", async () => {
		const store = memoryStore();
		getOrThrow(await store.put("lease/s", new TextEncoder().encode('{"v":1,"epoch":0}'), { absent: true }, context));
		const lease = leaseIn(store);
		const current = await lease.current("s", context);
		expect(current.ok ? "" : current.error.code).toBe("corrupt");
		const broken = leaseIn({
			get: async () => err(new KeyStoreError("unavailable", "down")),
			put: async () => err(new KeyStoreError("unavailable", "down")),
		});
		const taken = await broken.take("s", holder("a"), 0, undefined, context);
		expect(taken.ok ? "" : taken.error.code).toBe("unavailable");
	});

	it("says `corrupt` for a record whose seal is not a seal", async () => {
		const bad = [
			{ head: -1, sha256: "ab".repeat(32), bytes: 9 },
			{ head: 1.5, sha256: "ab".repeat(32), bytes: 9 },
			{ head: 7, sha256: "AB".repeat(32), bytes: 9 },
			{ head: 7, sha256: "ab".repeat(31), bytes: 9 },
			{ head: 7, sha256: "ab".repeat(32), bytes: -2 },
			{ head: 7, sha256: "ab".repeat(32) },
			"seal",
			null,
		];
		for (const seal of bad) {
			const store = memoryStore();
			const record = { v: 1, session: "s", epoch: 1, holder: holder("a"), seal, at: "2026-01-01T00:00:00.000Z" };
			getOrThrow(
				await store.put("lease/s", new TextEncoder().encode(JSON.stringify(record)), { absent: true }, context),
			);
			const current = await leaseIn(store).current("s", context);
			expect(current.ok ? "ok" : current.error.code, JSON.stringify(seal)).toBe("corrupt");
		}
		const good = memoryStore();
		const lease = leaseIn(good);
		getOrThrow(await lease.take("s", holder("a"), 0, { seal: GOOD_SEAL }, context));
		expect(getOrThrow(await lease.current("s", context))?.seal).toEqual(GOOD_SEAL);
	});

	it("says `corrupt` for a record whose time is not an ISO time", async () => {
		for (const at of ["yesterday", 123, null, "2026-13-45T00:00:00.000Z", "2026-01-01", undefined]) {
			const store = memoryStore();
			const record = { v: 1, session: "s", epoch: 1, holder: holder("a"), at };
			getOrThrow(
				await store.put("lease/s", new TextEncoder().encode(JSON.stringify(record)), { absent: true }, context),
			);
			const current = await leaseIn(store).current("s", context);
			expect(current.ok ? "ok" : current.error.code, String(at)).toBe("corrupt");
		}
	});

	it("loses to a record of another session in its key, not follows it", async () => {
		const store = memoryStore();
		const lease = leaseIn(store);
		getOrThrow(await lease.take("a", holder("a"), 0, undefined, context));
		const stolen = getOrThrow(await store.get("lease/a", context));
		getOrThrow(await store.put("lease/b", stolen?.value ?? new Uint8Array(), { absent: true }, context));
		const current = await lease.current("b", context);
		expect(current.ok ? "" : current.error.code).toBe("corrupt");
	});
});
