// A child of store-target-end.test.mjs (run with `node --test` on Postgres, never by the suite's glob): the order of a
// test's end (store-target.mjs's endTest: the closers handed to atTestEnd, then the open-connection check) against the
// test's own after-hooks. Each step prints a line "step <test>: <what>" for the parent to read. The second test's second
// hook throws: its third hook and its end still run, and the client its third hook closes is not counted as left open.
import { test } from "node:test";
import { atTestEnd, client, freshSchema } from "../store-target.mjs";

const step = (name, what) => process.stdout.write(`step ${name}: ${what}\n`);

test("after-hooks that pass", async (t) => {
  await freshSchema();
  atTestEnd(() => step("pass", "end closer"));
  t.after(() => step("pass", "own hook 1"));
  t.after(() => step("pass", "own hook 2"));
});

test("a second after-hook that throws", async (t) => {
  const c = await client(await freshSchema());
  atTestEnd(() => step("throw", "end closer"));
  t.after(() => step("throw", "own hook 1"));
  t.after(() => {
    step("throw", "own hook 2 throws");
    throw new Error("own hook 2 threw");
  });
  t.after(async () => {
    await c.end();
    step("throw", "own hook 3 closed its client");
  });
});
