// The page of scripts/store-check.ts: pi's storage conformance suite on the browser store (SQLite-WASM on OPFS, in its worker), run in the page.
// `?phase=conformance` runs every case against a fresh database each; `?phase=write` and `?phase=read` are two page loads that show a database
// written by one page is read by the next (the worker of the first is torn down by the reload, and the second waits for its handles).
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import type { StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";
import { deleteStore, hasStore, openLocalStore, spawnStoreWorker, storeName } from "../tab/local-store.ts";

type Result = { phase: string; ok: boolean; total?: number; failed?: { name: string; error: string }[]; detail?: unknown; ms?: number; crossOriginIsolated: boolean };
const done = (result: Omit<Result, "crossOriginIsolated">) => ((globalThis as { __result?: Result }).__result = { ...result, crossOriginIsolated: globalThis.crossOriginIsolated });

// Vitest's assertion semantics, as scripts and test/_conformance.ts state them: toEqual ignores undefined-valued keys, toMatchObject is a subset.
const strip = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(strip);
  if (value instanceof Uint8Array) return value;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, strip(v)]));
  return value;
};
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Uint8Array || b instanceof Uint8Array) return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
function subset(actual: unknown, expected: unknown, where = "$"): void {
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") throw new Error(`${where}: expected object, got ${JSON.stringify(actual)}`);
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`${where}: array length differs`);
      expected.forEach((item, i) => subset(actual[i], item, `${where}[${i}]`));
    } else for (const [key, item] of Object.entries(expected)) subset((actual as Record<string, unknown>)[key], item, `${where}.${key}`);
    return;
  }
  if (actual !== expected) throw new Error(`${where}: ${String(actual)} !== ${String(expected)}`);
}
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof Uint8Array ? `bytes(${x.length})` : x));
const assertions: StorageConformanceAssertions = {
  ok: (value, message) => { if (!value) throw new Error(message ?? "expected a truthy value"); },
  strictEqual: (actual, expected) => { if (actual !== expected) throw new Error(`${show(actual)} !== ${show(expected)}`); },
  deepEqual: (actual, expected) => { if (!same(strip(actual), strip(expected))) throw new Error(`${show(actual)} does not equal ${show(expected)}`); },
  partialDeepEqual: (actual, expected) => subset(actual, expected),
  greaterThan: (actual, expected) => { if (!(actual > expected)) throw new Error(`${actual} is not greater than ${expected}`); },
  async rejects(operation, messageIncludes) {
    let error: unknown;
    try { await operation; } catch (caught) { error = caught; }
    if (error === undefined) throw new Error(`expected a rejection containing "${messageIncludes}", got a resolution`);
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(messageIncludes)) throw new Error(`rejection "${message}" does not include "${messageIncludes}"`);
  },
};

const phase = new URLSearchParams(location.search).get("phase") ?? "conformance";
const started = performance.now();
try {
  if (phase === "conformance") {
    let n = 0;
    const cases = createStorageConformance({
      assertions,
      async withStorage(use) {
        const run = `conf-${++n}`;
        const store = await openLocalStore(run);
        try {
          await use(store.storage);
        } finally {
          await store.storage.close(undefined as never).catch(() => undefined);
          await deleteStore(run).catch(() => undefined);
        }
      },
    });
    const failed: { name: string; error: string }[] = [];
    for (const testCase of cases) {
      try {
        await testCase.run();
      } catch (error) {
        failed.push({ name: testCase.name, error: String((error as Error)?.message ?? error).slice(0, 300) });
      }
    }
    done({ phase, ok: failed.length === 0, total: cases.length, failed, ms: Math.round(performance.now() - started) });
  } else if (phase === "write") {
    const store = await openLocalStore("persist");
    await store.database.exec("CREATE TABLE IF NOT EXISTS probe(a INTEGER, b TEXT)");
    await store.database.run("INSERT INTO probe VALUES (?, ?)", 41, "from the first page");
    await store.storage.close(undefined as never);
    done({ phase, ok: true, detail: { has: await hasStore("persist"), name: storeName("persist") } });
  } else if (phase === "read") {
    const store = await openLocalStore("persist", spawnStoreWorker());
    const rows = await store.database.all("SELECT a, b FROM probe");
    await store.storage.close(undefined as never);
    await deleteStore("persist");
    done({ phase, ok: rows.length === 1, detail: rows, ms: Math.round(performance.now() - started) });
  }
} catch (error) {
  done({ phase, ok: false, detail: String((error as Error)?.stack ?? error) });
}
