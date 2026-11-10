// A runner-path run that was handed a sign-in its server can no longer read back (its seal does not open here, or it was
// forgotten and no kept tombstone of it opens) ends FAILED at its claim, in main's words (runs.ts UNREADABLE_SIGN_IN),
// which name no pointer: whatever it said could repeat the pointer, which nothing can cut then. A pointer still saved, or
// forgotten with its tombstone opening, reads back, and the run goes on.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";
import { storeOn } from "./store-helpers.mjs";

const signIns = await import("../dist/sign-ins-store.js");
const { UNREADABLE_SIGN_IN } = await import("../dist/runs.js");
const contract = await import("../dist/runner/loop-contract.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");

/** A test seal key, no real one. */
const KEY = randomBytes(32);

test("a handed sign-in reads back while it is saved, or forgotten with its tombstone opening; not under another key, nor when nothing of it is kept", async (t) => {
  assert.equal(typeof signIns.handedSignInReadsBack, "function", "sign-ins-store.ts exports handedSignInReadsBack");
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-a", name: "a" }, { id: "rev-a", kind: "agentic", body: { instructions: "Browse." } });
  const pointer = `ctx-${randomBytes(8).toString("hex")}`;
  await signIns.saveSignIn(store, KEY, { agentId: "agent-a", provider: "browserbase", pointer });
  const run = (handed) => ({ agentId: "agent-a", signInHanded: handed });
  assert.equal(await signIns.handedSignInReadsBack(store, KEY, run(null)), true, "a run handed none");
  assert.equal(await signIns.handedSignInReadsBack(store, KEY, run([signIns.pointerHash(pointer)])), true, "saved, and it opens");
  assert.equal(await signIns.handedSignInReadsBack(store, randomBytes(32), run([signIns.pointerHash(pointer)])), false, "its seal does not open under another key");
  assert.equal(await signIns.handedSignInReadsBack(store, undefined, run([signIns.pointerHash(pointer)])), false, "nor with no seal key");
  assert.equal(await signIns.handedSignInReadsBack(store, KEY, run([signIns.pointerHash("ctx-never-kept")])), false, "nothing of it is kept");
  await store.signIns.forget("agent-a", "browserbase", { hash: "not-held" });
  assert.equal(await signIns.handedSignInReadsBack(store, KEY, run([signIns.pointerHash(pointer)])), true, "forgotten, its tombstone opens");
});

test("a runner-path run handed a sign-in that won't read back is refused at its claim, in main's words naming no pointer", async (t) => {
  const gone = `ctx-${randomBytes(8).toString("hex")}`;
  await assert.rejects(
    specFor(t, {
      body: { tools: ["read", "browser"] },
      before: async (server) => {
        // An earlier claim was handed a sign-in that is kept nowhere now.
        const claim = await server.claim("run-1", "runner-earlier", { leaseMs: 60_000 });
        await server.runs.update(claim, { signInHanded: [signIns.pointerHash(gone)] });
        await server.release(claim);
      },
    }),
    (error) => {
      assert.equal(error.name, "ClaimRefused");
      assert.equal(error.message, UNREADABLE_SIGN_IN);
      assert.ok(!error.message.includes(gone));
      return true;
    },
  );
});

test("a run whose mark column holds the JSON text null (no writer writes it; never the column's SQL NULL) is refused at its claim as one that won't read back", async (t) => {
  await assert.rejects(
    specFor(t, {
      body: { tools: ["read", "browser"] },
      before: async (_server, _key, dir) => {
        const db = new DatabaseSync(join(dir, "store.sqlite"), { timeout: 10_000 });
        try {
          db.exec("BEGIN IMMEDIATE");
          db.prepare("UPDATE runs SET sign_in_handed = 'null' WHERE id = ?").run("run-1");
          db.exec("COMMIT");
        } finally {
          db.close();
        }
      },
    }),
    (error) => error.name === "ClaimRefused" && error.message === UNREADABLE_SIGN_IN,
  );
});

test("after the seal key changed, a run that was never handed the sign-in is taken up at its claim as any run: only a run handed one that won't read back is refused", async (t) => {
  // The agent's sign-in is kept under another seal key (it does not open here), and this run was never handed it.
  const got = await specFor(t, {
    body: { tools: ["read", "browser"] },
    before: (server) => signIns.saveSignIn(server, randomBytes(32), { agentId: "agent-1", provider: "browserbase", pointer: `ctx-${randomBytes(8).toString("hex")}` }),
  });
  assert.ok(got?.spec, "its spec is built, never refused");
  assert.equal((await got.store.runs.get("run-1")).state, "running");
});

test("the loop ends a run whose claim is refused failed, in the refusal's words, with nothing sent", async (t) => {
  assert.equal(typeof contract.ClaimRefused, "function", "loop-contract.ts exports ClaimRefused");
  const { store } = await storeOn(t);
  await store.agents.create({ id: "agent-a", name: "a" }, { id: "rev-a", kind: "agentic", body: { instructions: "Browse." } });
  await store.runs.create({ id: "run-1", agentId: "agent-a", revisionId: "rev-a" });
  const claim = await store.claim("run-1", "runner-1", { leaseMs: 60_000 });
  const loop = createAdapterLoop(() => { throw new contract.ClaimRefused(UNREADABLE_SIGN_IN); })({ journal: (c) => store.journal(c), flush: () => store.flush(), signal: new AbortController().signal });
  const end = await loop.start(claim);
  assert.equal(end.state, "failed", JSON.stringify(end));
  assert.equal(end.error?.message, UNREADABLE_SIGN_IN);
  const row = await store.runs.get("run-1");
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.equal(row.summary, UNREADABLE_SIGN_IN);
});
