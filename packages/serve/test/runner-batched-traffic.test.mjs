// A runner's periodic store traffic is per runner, never per run (design: "about 300 loops per Node process", all on the
// store's one connection): one read of every held run's new command rows a command tick, and one transaction renewing
// every held claim a renew tick, as run_live's write is one for all of them. 300 loops held: counted by a spy on the
// store, the reads and renews stay at one a tick, never 300.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startRunner } from "../dist/runner/runner.js";
import { fauxLoops, queue, sleep, stores, until } from "./runner-support.mjs";

const LOOPS = 300;
const COMMAND_POLL_MS = 100;
const RENEW_EVERY_MS = 200;
const WINDOW_MS = 1_000;
const id = (i) => `run-${String(i).padStart(3, "0")}`;

test("300 loops held: one commands read a command tick and one renew transaction a renew tick, never one per run", async (t) => {
  const { server, runners: [store] } = await stores({ runners: 1 });
  // Loops that run well past the window: 300 held throughout it.
  const faux = fauxLoops({ turns: 1_000, turnMs: 50 });
  for (let i = 0; i < LOOPS; i++) await queue(server, id(i));
  const counts = { commands: 0, renews: 0 };
  // A spy on the store: each read of command rows and each renew transaction, whichever method makes it.
  const spied = new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "commands" || property === "commandsOf") return (...args) => (counts.commands++, value.apply(target, args));
      if (property === "renew" || property === "renewMany") return (...args) => (counts.renews++, value.apply(target, args));
      return value.bind(target);
    },
  });
  const runner = startRunner({ store: spied, createLoop: faux.createLoop, name: "runner-a", loops: LOOPS, leaseMs: 10_000, renewEveryMs: RENEW_EVERY_MS, stopMarginMs: 2_000, pollMs: 20, commandPollMs: COMMAND_POLL_MS });
  t.after(() => runner.close());
  await until(() => runner.held().length === LOOPS, `the runner holds ${LOOPS}`, 30_000);
  counts.commands = 0;
  counts.renews = 0;
  await sleep(WINDOW_MS);
  const commandTicks = WINDOW_MS / COMMAND_POLL_MS;
  const renewTicks = WINDOW_MS / RENEW_EVERY_MS;
  assert.equal(runner.held().length, LOOPS, "all 300 held through the window");
  assert.ok(counts.commands <= commandTicks + 2, `${counts.commands} command reads in ${WINDOW_MS} ms (one a tick: at most ${commandTicks + 2})`);
  assert.ok(counts.renews <= renewTicks + 2, `${counts.renews} renew transactions in ${WINDOW_MS} ms (one a tick: at most ${renewTicks + 2})`);
});
