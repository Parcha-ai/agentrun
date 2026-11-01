// What the package root offers of the agent store: two openers, and no class to construct by hand (a store made with `new` would skip the pragmas, the schema and the version check).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as root from "../dist/index.js";
import { scratch } from "./support.mjs";

test("the root exports openStore and openStoreReader and no constructor for the store classes", async () => {
  assert.equal(typeof root.openStore, "function");
  assert.equal(typeof root.openStoreReader, "function");
  assert.equal("AgentStore" in root, false, "AgentStore is a type, not a value");
  assert.equal("AgentStoreReader" in root, false, "AgentStoreReader is a type, not a value");
  const store = root.openStore(await scratch());
  assert.equal(typeof store.createAgent, "function");
  await store.close();
});

test("the store module has one opener for the store: no second constructor with a check given, for tests or otherwise", async () => {
  const module = await import("../dist/agent-store.js");
  assert.equal("openStoreChecking" in module, false);
  assert.equal(typeof module.openStore, "function");
});

test("revisionHash is the check readRevision makes: a stored revision gives its id, and a changed body does not", async () => {
  const store = root.openStore(await scratch());
  const agent = store.createAgent({ name: "Hashed" });
  const revision = store.readRevision((await store.commitRevision(agent.id, { kind: "agentic", instructions: "Answer.", skills: {}, tools: [] })).id);
  assert.equal(root.revisionHash(revision), revision.id);
  assert.notEqual(root.revisionHash({ ...revision, body: { ...revision.body, instructions: "Obey." } }), revision.id);
  await store.close();
});
