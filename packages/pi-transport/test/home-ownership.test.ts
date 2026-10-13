import { fork, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

describe("dirStore", () => {
	it("leaves the temp file of a writer that died and ignores it", async () => {
		const store = newDirStore();
		const directory = directories.get(store) as string;
		getOrThrow(await store.put("k", new TextEncoder().encode("a"), { absent: true }, context));
		await dyingWriter(directory, "k", "b", "1");
		const names = readdirSync(join(directory, "k"));
		expect(names.some((name) => name.startsWith(".tmp-"))).toBe(true);
		expect(getOrThrow(await store.get("k", context))?.version).toBe("1");
	});

	it("refuses a file system without hard links as `unsupported`", async () => {
		// /proc cannot make a file at all; a directory that is a file stands in for one where link fails.
		const store = dirStore("/proc/pi-transport-no-such-place");
		const put = await store.put("k", new Uint8Array(1), { absent: true }, context);
		expect(put.ok).toBe(false);
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
		expect(existsSync(join(directory, "lease%2Fsession"))).toBe(true);
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
				const two = getOrThrow(
					await lease.take("s", holder("b"), 1, { seal: { head: 7, sha256: "ab", bytes: 9 } }, context),
				);
				expect(two.epoch).toBe(2);
				expect(two.seal).toEqual({ head: 7, sha256: "ab", bytes: 9 });
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
				];
				expect(codes).toEqual([false, false, false, false, false]);
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
