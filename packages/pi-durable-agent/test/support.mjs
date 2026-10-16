import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, createSession, defineDocFamily, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";

export const ctx = BACKGROUND_CONTEXT;
export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const roots = [];
after(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));
/** A fresh directory for one test, removed when the file's tests end. */
export async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-durable-agent-"));
  roots.push(dir);
  return dir;
}

/** The stored format, declared from outside the package. */
export const Profiles = defineDocFamily({ kind: "browser.profiles", version: 1, scope: "session", family: true, initial: () => ({}) });

async function openStorage(file) {
  const database = await openNodeSqliteDatabase(file);
  await database.exec("PRAGMA synchronous = FULL");
  return SqliteStorage.open(database);
}

/** What a host does with a started run: its own Harness on the run store, empty registry, no model calls. */
export async function openHost(storePath) {
  return Harness.open(await openStorage(storePath), { models: createModels(), registry: createRegistry() }, ctx);
}

/** A plain Session on a store, for edits a browser extension would make during a run. */
export async function openSession(storePath) {
  return createSession(await openStorage(storePath));
}

export const DEFINITION = {
  version: 1,
  name: "Researcher",
  instructions: "Cite every claim.",
  skills: ["cite"],
  tools: ["web_search", "browser"],
};
