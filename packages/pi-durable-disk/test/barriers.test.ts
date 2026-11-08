// The barrier (`syncNow`) and the table that says where it runs (barriers.ts), held to the source of every package.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { BARRIER, BARRIERS, NORMAL_PRECONDITIONS, STORES, syncNow, type BarrierRow, type StoreRow } from "../src/barriers.ts";
import { JOURNAL_SYNCHRONOUS, openArchilStore, type Synchronous } from "../src/store.ts";
import { ctx, scratchRoot } from "./_run-support.ts";

const PACKAGES = fileURLToPath(new URL("../..", import.meta.url));

/** Every commit through a database, with the `synchronous` level it ran at (read inside it, where it cannot change). */
function levels(inner: SqliteDatabase): { database: SqliteDatabase; commits: number[] } {
  const commits: number[] = [];
  const level = async (on: SqliteExecutor) => Number(Object.values((await on.get<Record<string, SqliteValue>>("PRAGMA synchronous"))!)[0]);
  return {
    commits,
    database: {
      exec: (sql) => inner.exec(sql),
      run: (sql, ...params) => inner.run(sql, ...params),
      runCounted: (sql, ...params) => inner.runCounted(sql, ...params),
      get: (sql, ...params) => inner.get(sql, ...params),
      all: (sql, ...params) => inner.all(sql, ...params),
      async transaction(callback) {
        let at = 0;
        const result = await inner.transaction(async (handle) => {
          const value = await callback(handle);
          at = await level(handle);
          return value;
        });
        commits.push(at);
        return result;
      },
      close: () => inner.close(),
    },
  };
}

describe("syncNow", () => {
  it("on a NORMAL store: one marker commit at FULL, and the store back at NORMAL for the commits after it", async () => {
    let decorated: number[] = [];
    const dir = scratchRoot("barrier-normal");
    try {
      const store = await openArchilStore(join(dir.root, "store", "run.sqlite"), "exclusive", {
        synchronous: "NORMAL",
        decorate: (raw) => {
          const d = levels(raw);
          decorated = d.commits;
          return d.database;
        },
      });
      const write = (n: number) => store.database.transaction((tx) => tx.exec(`CREATE TABLE IF NOT EXISTS t (n INTEGER); INSERT INTO t VALUES (${n})`));
      const before = decorated.length;
      await write(1);
      await syncNow(store, BARRIER.runStatus);
      await write(2);
      assert.deepEqual(decorated.slice(before), [1, 2, 1], "NORMAL, the barrier at FULL, NORMAL again");
      assert.deepEqual({ ...(await store.database.get("SELECT n, barrier FROM pda_barrier")) }, { n: 1, barrier: "runStatus" });
      await syncNow(store, BARRIER.runRelease);
      assert.deepEqual({ ...(await store.database.get("SELECT n, barrier FROM pda_barrier")) }, { n: 2, barrier: "runRelease" }, "each barrier changes the row, so each writes a page to sync");
      await store.storage.close(ctx);
    } finally {
      dir.remove();
    }
  });

  it("on a FULL store: nothing written, since every commit synced already", async () => {
    let decorated: number[] = [];
    const dir = scratchRoot("barrier-full");
    try {
      const store = await openArchilStore(join(dir.root, "store", "run.sqlite"), "exclusive", {
        synchronous: "FULL",
        decorate: (raw) => {
          const d = levels(raw);
          decorated = d.commits;
          return d.database;
        },
      });
      const before = decorated.length;
      await syncNow(store, BARRIER.runStatus);
      assert.equal(decorated.length, before);
      assert.equal(await store.database.get("SELECT name FROM sqlite_schema WHERE name = 'pda_barrier'"), undefined);
      await store.storage.close(ctx);
    } finally {
      dir.remove();
    }
  });

  it("commits issued while a barrier is in flight run at the store's own level: only the marker is FULL", async () => {
    let decorated: number[] = [];
    const dir = scratchRoot("barrier-race");
    try {
      const store = await openArchilStore(join(dir.root, "store", "run.sqlite"), "exclusive", {
        synchronous: "NORMAL",
        decorate: (raw) => {
          const d = levels(raw);
          decorated = d.commits;
          return d.database;
        },
      });
      await store.database.exec("CREATE TABLE t (n INTEGER)");
      const before = decorated.length;
      const write = (n: number) => store.database.transaction((tx) => tx.run("INSERT INTO t VALUES (?)", n));
      await Promise.all([write(1), syncNow(store, BARRIER.runStatus), write(2), write(3), syncNow(store, BARRIER.runRelease), write(4)]);
      const after = decorated.slice(before);
      assert.equal(after.length, 6);
      assert.equal(after.filter((l) => l === 2).length, 2, `two FULL commits, the markers: ${after}`);
      await store.storage.close(ctx);
    } finally {
      dir.remove();
    }
  });

  it("refuses a name that is not in the table", async () => {
    const dir = scratchRoot("barrier-name");
    try {
      const store = await openArchilStore(join(dir.root, "store", "run.sqlite"), "exclusive", { synchronous: "NORMAL" });
      await assert.rejects(syncNow(store, "noSuchBarrier" as never), TypeError);
      await store.storage.close(ctx);
    } finally {
      dir.remove();
    }
  });
});

// ---- the source guard ------------------------------------------------------------------------------------------------

type Table = { barriers: Record<string, Omit<BarrierRow, "store"> & { store: string }>; stores: Record<string, StoreRow>; preconditions?: Record<string, { done: boolean; what: string }> };

/** The file that is the sync primitive itself: it holds `syncNow`'s definition and its pragmas, and opens no store. */
const PRIMITIVES = new Set(["pi-durable-disk/src/barriers.ts"]);
/** What opens a store read-write, or sets how one syncs: a `new DatabaseSync(` counts unless its options say readOnly. */
const OPENS = /openArchilStore\(|openNodeSqliteStorage\(|openNodeSqliteDatabase\(|PRAGMA synchronous\b|profilePragmas\(|new DatabaseSync\((?![^;]*readOnly:\s*true)/;
/** What a store with no effects must never do: run a tool or a model on it. */
const EFFECTFUL = /\.install\(|setProvider\(|syncNow\(/;
const CALL = /syncNow\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/** `text` with every comment blanked (its newlines kept), so a comment that names a barrier or an opener neither
 *  satisfies nor trips the guard. TypeScript's parser finds them: never a `//` in a string, a template or a regular
 *  expression. `file` says how to parse it (JavaScript or TypeScript). */
function withoutComments(text: string, file = "source.ts"): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const out = text.split("");
  const blank = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const { pos, end } of ranges ?? []) for (let at = pos; at < end; at++) if (out[at] !== "\n" && out[at] !== "\r") out[at] = " ";
  };
  // Every comment is trivia around a token: before it (from the line after the token before) or after it on its line.
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      blank(ts.getLeadingCommentRanges(text, node.pos));
      blank(ts.getTrailingCommentRanges(text, node.end));
    }
    for (const child of children) visit(child);
  };
  visit(source);
  return out.join("");
}

/** What a comment could meet: a file with none of it is checked as it is, unparsed. */
const MATCHED = new RegExp([CALL.source, OPENS.source, EFFECTFUL.source].join("|"));

/** Every way the table and the source disagree, read with comments left out: a barrier's call, a hook's await line
 *  (`via`) or a store's open that is only in a comment counts as missing. `sources`: file (relative to packages/) to its
 *  text. */
/** Whether a file (relative to the repository) exists: a barrier's proof. */
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const inRepo = (file: string): boolean => existsSync(join(REPO, file));

function violations(table: Table, journal: Synchronous, given: ReadonlyMap<string, string>, exists: (file: string) => boolean = inRepo): string[] {
  const vias = Object.values(table.barriers).flatMap((row) => (row.via ? [row.via.text] : []));
  const sources = new Map([...given].map(([file, text]) => [file, MATCHED.test(text) || vias.some((via) => text.includes(via)) ? withoutComments(text, file) : text]));
  const out: string[] = [];
  const called = new Map<string, Set<string>>();
  for (const [file, text] of sources) {
    if (PRIMITIVES.has(file)) continue;
    for (const match of text.matchAll(CALL)) {
      const name = /,\s*(?:BARRIER\.(\w+)|"(\w+)")\s*$/.exec(match[1]!.trim());
      const barrier = name?.[1] ?? name?.[2];
      if (barrier === undefined) {
        out.push(`${file}: syncNow(${match[1]}) names no barrier`);
        continue;
      }
      const row = table.barriers[barrier];
      if (row === undefined) out.push(`${file}: syncNow names ${barrier}, which the table does not list`);
      else if (row.site !== file) out.push(`${file}: syncNow names ${barrier}, whose site is ${row.site}`);
      called.set(barrier, (called.get(barrier) ?? new Set()).add(file));
    }
  }
  for (const [name, row] of Object.entries(table.barriers)) {
    if (!(row.store in table.stores)) out.push(`${name}: store ${row.store} is not listed`);
    if (row.status === "active" && !called.has(name)) out.push(`${name}: active, but ${row.site} has no syncNow(…, BARRIER.${name})`);
    if (row.status === "active" && row.via && !(sources.get(row.via.file) ?? "").includes(row.via.text)) out.push(`${name}: ${row.via.file} no longer has ${JSON.stringify(row.via.text)}`);
    if (row.status === "planned" && row.store === "run-journal" && journal === "NORMAL") out.push(`${name}: still planned, and the run journal is NORMAL: it may not go NORMAL before every barrier on it is active`);
    if (row.status === "active") {
      const proof = (row as { proof?: string | null }).proof;
      if (proof === undefined) out.push(`${name}: active, and names no box-loss proof (proof: its end-to-end test file, or null while it has none)`);
      else if (proof === null) {
        if (journal === "NORMAL") out.push(`${name}: has no box-loss proof, and the run journal is NORMAL`);
      } else if (!exists(proof)) out.push(`${name}: its proof ${proof} does not exist`);
    }
  }
  for (const [name, pre] of Object.entries(table.preconditions ?? {})) if (!pre.done && journal === "NORMAL") out.push(`${name}: not done, and the run journal is NORMAL: ${pre.what}`);
  const listed = new Set(Object.values(table.stores).flatMap((store) => store.opens));
  for (const [file, text] of sources) if (!PRIMITIVES.has(file) && OPENS.test(text) && !listed.has(file)) out.push(`${file}: opens a store or sets its sync, and no store in the table lists it`);
  for (const [id, store] of Object.entries(table.stores)) {
    for (const file of store.opens) if (!sources.has(file)) out.push(`${id}: ${file} does not exist`);
    const level = store.synchronous === "journal" ? journal : store.synchronous;
    if (store.effects === "none") {
      for (const file of store.opens) if (EFFECTFUL.test(sources.get(file) ?? "")) out.push(`${id}: listed with no effects, but ${file} runs a tool, a model or a barrier on it`);
    } else if (level === "NORMAL") {
      const chokepoints = Object.entries(table.barriers).filter(([, row]) => row.store === id && row.status === "active");
      if (chokepoints.length === 0) out.push(`${id}: NORMAL with effects, and no active barrier`);
    }
  }
  return out;
}

function sourcesOf(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pkg of readdirSync(root)) {
    const src = join(root, pkg, "src");
    if (!existsSync(src)) continue;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.set(relative(root, path), readFileSync(path, "utf8"));
      }
    };
    walk(src);
  }
  return out;
}

describe("the barriers table, held to the source", () => {
  const table: Table = { barriers: BARRIERS, stores: STORES, preconditions: NORMAL_PRECONDITIONS };
  const sources = sourcesOf(PACKAGES);

  it("agrees with every package's source", () => {
    assert.deepEqual(violations(table, JOURNAL_SYNCHRONOUS, sources), []);
  });

  it("a planned barrier passes while the run journal is FULL, and fails once it is NORMAL", () => {
    const planned: Table = { barriers: { later: { store: "run-journal", site: "x/src/a.ts", status: "planned", why: "" } }, stores: { "run-journal": { opens: ["x/src/a.ts"], synchronous: "journal", effects: "barriers", what: "" } } };
    const files = new Map([["x/src/a.ts", "openArchilStore(file)"]]);
    assert.deepEqual(violations(planned, "FULL", files), []);
    assert.deepEqual(violations(planned, "NORMAL", files), [
      "later: still planned, and the run journal is NORMAL: it may not go NORMAL before every barrier on it is active",
      "run-journal: NORMAL with effects, and no active barrier",
    ]);
  });

  it("fails a call that names no barrier, one in another file than its row's, an active row with no call, an unlisted store, and a no-effects store that runs tools", () => {
    const t: Table = {
      barriers: {
        here: { store: "s", site: "x/src/a.ts", status: "active", proof: null, why: "" },
        missing: { store: "s", site: "x/src/a.ts", status: "active", proof: null, why: "" },
      },
      stores: { s: { opens: ["x/src/a.ts"], synchronous: "NORMAL", effects: "barriers", what: "" }, quiet: { opens: ["x/src/q.ts"], synchronous: "NORMAL", effects: "none", what: "" } },
    };
    const files = new Map([
      ["x/src/a.ts", "openNodeSqliteStorage(f); await syncNow(store, BARRIER.here); await syncNow(store, name);"],
      ["x/src/b.ts", "await syncNow(store, BARRIER.here);"],
      ["x/src/c.ts", "await openNodeSqliteStorage(path);"],
      ["x/src/q.ts", "openNodeSqliteStorage(p); registry.install(tools);"],
    ]);
    assert.deepEqual(violations(t, "FULL", files), [
      "x/src/a.ts: syncNow(store, name) names no barrier",
      "x/src/b.ts: syncNow names here, whose site is x/src/a.ts",
      "missing: active, but x/src/a.ts has no syncNow(…, BARRIER.missing)",
      "x/src/c.ts: opens a store or sets its sync, and no store in the table lists it",
      "quiet: listed with no effects, but x/src/q.ts runs a tool, a model or a barrier on it",
    ]);
  });

  it("a comment meets no check: a via line or a barrier's call that is only in a comment is missing; the same lines as code, beside text that only looks like a comment, pass", () => {
    const t: Table = {
      barriers: { hooked: { store: "s", site: "x/src/a.ts", status: "active", proof: null, why: "", via: { file: "x/src/d.ts", text: "if (hook) await persist(hook);" } } },
      stores: { s: { opens: ["x/src/a.ts"], synchronous: "NORMAL", effects: "barriers", what: "" } },
    };
    const commented = new Map([
      ["x/src/a.ts", "openNodeSqliteStorage(f);\n// await syncNow(store, BARRIER.hooked);\n/* syncNow(store, BARRIER.hooked) */"],
      ["x/src/d.ts", "// if (hook) await persist(hook);\n/**\n * if (hook) await persist(hook);\n */\nconst later = 1;"],
    ]);
    assert.deepEqual(violations(t, "FULL", commented), [
      "hooked: active, but x/src/a.ts has no syncNow(…, BARRIER.hooked)",
      'hooked: x/src/d.ts no longer has "if (hook) await persist(hook);"',
    ]);
    const code = new Map([
      ["x/src/a.ts", 'openNodeSqliteStorage(f);\nconst url = "http://x"; await syncNow(store, BARRIER.hooked); // synced'],
      ["x/src/d.ts", "const slashes = /\\/\\//; const text = `// ${slashes}`; if (hook) await persist(hook); /* admitted */"],
    ]);
    assert.deepEqual(violations(t, "FULL", code), []);
  });

  it("a regular expression is code: a `//` or a quote inside one starts no comment and no string, so a real call beside it counts and a commented one after it does not", () => {
    const t: Table = {
      barriers: {
        here: { store: "s", site: "x/src/a.ts", status: "active", proof: null, why: "", via: { file: "x/src/a.ts", text: "if (hook) await persist(hook);" } },
        ghost: { store: "s", site: "x/src/a.ts", status: "active", proof: null, why: "" },
      },
      stores: { s: { opens: ["x/src/a.ts"], synchronous: "NORMAL", effects: "barriers", what: "" } },
    };
    const lines = [
      "openArchilStore(f);",
      "const slashes = /\\/\\//; await syncNow(store, BARRIER.here); if (hook) await persist(hook);",
      'const quote = /"/; // await syncNow(store, BARRIER.ghost);',
      "const tick = /'/; const done = \"ok\";",
    ];
    const code = withoutComments(lines.join("\n")).split("\n");
    assert.deepEqual(code.slice(0, 2), lines.slice(0, 2), "a `//` inside a regular expression is no comment: the call and the via line beside it are code");
    assert.equal(code[2]!.trimEnd(), 'const quote = /"/;', "a quote inside a regular expression opens no string: the comment after it is blanked");
    assert.equal(code[3], lines[3]);
    assert.deepEqual(violations(t, "FULL", new Map([["x/src/a.ts", lines.join("\n")]])), ["ghost: active, but x/src/a.ts has no syncNow(…, BARRIER.ghost)"]);
  });

  it("reads code only: a barrier call or an opener inside a comment neither counts nor trips it, and a string keeps its slashes", () => {
    const t: Table = { barriers: { here: { store: "s", site: "x/src/a.ts", status: "active", proof: null, why: "" } }, stores: { s: { opens: ["x/src/a.ts"], synchronous: "FULL", effects: "barriers", what: "" } } };
    const files = new Map([
      ["x/src/a.ts", withoutComments('const url = "https://x//y"; openArchilStore(f);\n// await syncNow(store, BARRIER.here);\n')],
      ["x/src/b.ts", withoutComments("/* new DatabaseSync(path) */ const db = new DatabaseSync(path, { readOnly: true });")],
      ["x/src/c.ts", withoutComments("const db = new DatabaseSync(file, { timeout: 0 });")],
    ]);
    assert.ok(files.get("x/src/a.ts")!.includes('"https://x//y"'), "a string's slashes are code");
    assert.deepEqual(violations(t, "FULL", files), [
      "here: active, but x/src/a.ts has no syncNow(…, BARRIER.here)",
      "x/src/c.ts: opens a store or sets its sync, and no store in the table lists it",
    ]);
  });

  it("a precondition not done passes while the run journal is FULL, and fails once it is NORMAL", () => {
    const t: Table = { barriers: {}, stores: {}, preconditions: { later: { done: false, what: "x" }, now: { done: true, what: "y" } } };
    assert.deepEqual(violations(t, "FULL", new Map()), []);
    assert.deepEqual(violations(t, "NORMAL", new Map()), ["later: not done, and the run journal is NORMAL: x"]);
  });

  it("an active barrier names its box-loss proof: a missing proof or a proof file that does not exist fails; a proof stated as none passes at FULL and fails at NORMAL", () => {
    const t = (proof?: string | null): Table => ({
      barriers: { here: { store: "s", site: "x/src/a.ts", status: "active", why: "", ...(proof === undefined ? {} : { proof }) } },
      stores: { s: { opens: ["x/src/a.ts"], synchronous: "FULL", effects: "barriers", what: "" } },
    });
    const files = new Map([["x/src/a.ts", "openArchilStore(f); await syncNow(store, BARRIER.here);"]]);
    const exists = (file: string) => file === "packages/x/test/proof.test.ts";
    assert.deepEqual(violations(t(), "FULL", files, exists), ["here: active, and names no box-loss proof (proof: its end-to-end test file, or null while it has none)"]);
    assert.deepEqual(violations(t("packages/x/test/gone.test.ts"), "FULL", files, exists), ["here: its proof packages/x/test/gone.test.ts does not exist"]);
    assert.deepEqual(violations(t("packages/x/test/proof.test.ts"), "NORMAL", files, exists), []);
    assert.deepEqual(violations(t(null), "FULL", files, exists), []);
    assert.deepEqual(violations(t(null), "NORMAL", files, exists), ["here: has no box-loss proof, and the run journal is NORMAL"]);
  });
});
