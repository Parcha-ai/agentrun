// POST /agents while the store's write is held up. The store's one connection bounds an interactive transaction by a
// timer on this process's event loop. Other work of the process that holds the loop (a harness binary hashed, or its
// `--version` run, synchronously) while the agent's create is open makes that timer fire late, after the create's
// statements were answered: the create is not slow, the process was. Such a create commits, and is answered 201. A
// create whose own write really runs past its deadline is answered home_busy (409, retryable), as a store busy past its
// wait is, never 500. The seam: the store's Connection.transaction, wrapped for the create's transaction alone, with a
// short deadline and the hold put in it.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Connection } from "../dist/store/index.js";
import { agent, serve } from "./support.mjs";

/** Holds this process's event loop for `ms`, as a synchronous hash or exec does. */
const hold = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

/** For test `t`: the next transaction made by an agent's create runs under a `deadlineMs` deadline, with `during` run
 *  as it begins (before its first statement), and the wrapped callback's own `inside` after its statements. */
function nextCreate(t, { deadlineMs, during = () => {}, inside = async () => {} }) {
  const original = Connection.prototype.transaction;
  let armed = true;
  Connection.prototype.transaction = function (callback, options = {}) {
    if (!armed || !new Error().stack.includes("createAgent")) return original.call(this, callback, options);
    armed = false;
    return original.call(this, async (tx) => {
      during();
      const value = await callback(tx);
      await inside();
      return value;
    }, { ...options, deadlineMs });
  };
  t.after(() => void (Connection.prototype.transaction = original));
  return { used: () => !armed };
}

test("an agent's create whose transaction is open while other work holds the process's event loop past its deadline commits: 201, the agent is there", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  // The hold runs right after the create's transaction began, while its first statement is answered: it is the
  // process's, never the transaction's own work.
  const seam = nextCreate(t, { deadlineMs: 200, during: () => setImmediate(() => hold(800)) });
  const made = await api("POST", "/agents", agent("held"));
  assert.ok(seam.used(), "the create's transaction ran under the seam");
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api("GET", "/agents/held")).status, 200, "the agent is there");
});

test("an agent's create whose own write runs past its deadline is answered home_busy, retryable, never 500, and nothing is made", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  const seam = nextCreate(t, { deadlineMs: 200, inside: () => sleep(800) });
  const made = await api("POST", "/agents", agent("slow"));
  assert.ok(seam.used(), "the create's transaction ran under the seam");
  assert.equal(made.status, 409, JSON.stringify(made.body));
  assert.equal(made.body.error.code, "home_busy");
  assert.equal(made.body.error.retryable, true);
  assert.equal((await api("GET", "/agents/slow")).status, 404, "nothing of it was written");
  // Asked again, it is made.
  assert.equal((await api("POST", "/agents", agent("slow"))).status, 201);
});
