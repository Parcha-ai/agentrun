// Only the store knows SQL, pragmas or a file (design 2.1): SQL and PRAGMA live in packages/serve/src/store/ and nowhere
// else in the packages' and apps' source. Today's files that still hold SQL are listed by name; the cutover deletes or moves
// each one, and the list only shrinks: a listed file with no SQL left fails until it is taken off the list.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STORE = "packages/serve/src/store/";
/** SQL as a statement, not as a word in prose: a keyword with what makes it a statement after it. */
const SQL = /\bPRAGMA\b|\bSELECT\b[^'"`]{0,80}\bFROM\b|\bINSERT (?:OR \w+ )?INTO\b|\bUPDATE [a-z_]+ SET\b|\bDELETE FROM\b|\bCREATE (?:TABLE|INDEX|UNIQUE INDEX)\b/;
/** The files outside the store that held SQL when the store landed. Each goes at the cutover. */
const TODAY = [
  "packages/pi-durable-agent/src/agent-store.ts",
  "packages/pi-durable-agent/src/pack-shared.ts",
  "packages/pi-durable-agent/src/serve/read.ts",
  "packages/pi-durable-agent/src/store.ts",
  "packages/pi-durable-agent/src/timeline/timeline.ts",
  "packages/pi-durable-agent/src/workflow.ts",
  "packages/pi-durable-disk/src/barriers.ts",
  "packages/pi-durable-disk/src/run.ts",
  "packages/pi-durable-disk/src/status.ts",
  "packages/pi-durable-disk/src/store.ts",
  "packages/pi/src/durable/readers.ts",
  "packages/pi/src/durable/recording.ts",
  "packages/serve/src/agents.ts",
  "packages/serve/src/cap.ts",
  "packages/serve/src/import.ts",
  "packages/serve/src/run-db.ts",
  "packages/serve/src/runs.ts",
  "packages/serve/src/server-lock.ts",
  "packages/serve/src/server.ts",
];

/** Every .ts/.mts/.js/.mjs file under `dir`, relative to the repository, skipping node_modules and dist. */
function sources(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:ts|mts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(relative(ROOT, path));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const roots = [...readdirSync(join(ROOT, "packages")).map((name) => join(ROOT, "packages", name, "src")), ...(existsSync(join(ROOT, "apps")) ? readdirSync(join(ROOT, "apps")).map((name) => join(ROOT, "apps", name, "src")) : [])];
const withSql = roots.flatMap(sources).filter((file) => SQL.test(readFileSync(join(ROOT, file), "utf8")));

test("the store holds the SQL: its SQLite adapter and its schema", () => {
  const inStore = withSql.filter((file) => file.startsWith(STORE));
  for (const file of [`${STORE}schema.ts`, `${STORE}sqlite/store.ts`]) assert.ok(inStore.includes(file), `${file} holds the store's SQL (found: ${JSON.stringify(inStore)})`);
});

test("no SQL or PRAGMA outside the store, but for today's files on the list", () => {
  const outside = withSql.filter((file) => !file.startsWith(STORE));
  assert.deepEqual(outside.filter((file) => !TODAY.includes(file)), [], "SQL outside packages/serve/src/store/: move it behind the Store interface");
});

test("the list only shrinks: a listed file with no SQL left is taken off it", () => {
  assert.deepEqual(TODAY.filter((file) => !withSql.includes(file)), [], "these hold no SQL now: take them off TODAY");
});
