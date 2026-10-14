// The kept box's reaper: a GPU box kept for the next page goes down unless a --reuse-box start claims it in time; the
// claim (or a plain stop) ends the reaper by its exact pid, and a box someone else claimed is still reaped.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimBox, reapUnlessClaimed, startReaper, stopReaper } from "../reaper.ts";

const home = () => {
  const h = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "gg-reaper-"));
  mkdirSync(join(h, "box-state"));
  return h;
};
const until = async (cond: () => boolean, ms = 10_000) => {
  for (const t = Date.now(); Date.now() - t < ms; ) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test("unclaimed, the kept box is terminated once at the deadline", async () => {
  const h = home();
  const ended: string[] = [];
  let now = 0;
  const out = await reapUnlessClaimed({ home: h, sandbox: "sb-1", minutes: 10, terminate: () => void ended.push("sb-1"), now: () => now, sleep: async (ms) => void (now += ms) });
  assert.equal(out, "reaped");
  assert.deepEqual(ended, ["sb-1"]);
  assert.ok(now >= 10 * 60_000 && now < 11 * 60_000, `at the deadline (${now} ms)`);
});

test("a --reuse-box start's claim of this box ends the wait; a claim of another box does not", async () => {
  const h = home();
  const ended: string[] = [];
  let now = 0;
  const sleep = async (ms: number) => {
    now += ms;
    if (now > 60_000) claimBox(h, "sb-other");
    if (now > 120_000) claimBox(h, "sb-1");
  };
  assert.equal(await reapUnlessClaimed({ home: h, sandbox: "sb-1", minutes: 10, terminate: () => void ended.push("sb-1"), now: () => now, sleep }), "claimed");
  assert.equal(ended.length, 0, "nothing terminated");
  // a start that claims the box before the reaper process is up still counts: the reaper never clears a claim itself
  const h2 = home();
  claimBox(h2, "sb-2");
  let now2 = 0;
  assert.equal(await reapUnlessClaimed({ home: h2, sandbox: "sb-2", minutes: 1, terminate: () => void ended.push("sb-2"), now: () => now2, sleep: async (ms) => void (now2 += ms) }), "claimed");
  assert.equal(ended.length, 0);
});

test("a claim left from an earlier keep is cleared when the reaper is started, before it runs", () => {
  const h = home();
  claimBox(h, "sb-old");
  startReaper({ home: h, sandbox: "sb-old", minutes: 5, command: [process.execPath, "-e", ""] });
  assert.equal(existsSync(join(h, "box-state", "claimed")), false, "an old claim does not stand for this keep");
  assert.equal(stopReaper(h), true);
});

test("the reaper runs detached with its own pid file; it reaps by the command it was given, and a stop ends it by its exact pid", async () => {
  const h = home();
  const mark = join(h, "terminated");
  // the command the launcher gives it is box.py down --id <box>; here it leaves a mark
  const pid = startReaper({ home: h, sandbox: "sb-9", minutes: 0.02, command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(mark)}, "sb-9")`] });
  assert.equal(Number(readFileSync(join(h, "reaper.pid"), "utf8")), pid);
  assert.ok(await until(() => existsSync(mark)), "the box is terminated at the deadline");
  assert.equal(readFileSync(mark, "utf8"), "sb-9");
  assert.ok(await until(() => !existsSync(join(h, "reaper.pid"))), "the reaper removes its pid file when done");
  // a second keep, ended by a plain stop before its deadline: nothing is terminated
  const h2 = home();
  const mark2 = join(h2, "terminated");
  startReaper({ home: h2, sandbox: "sb-10", minutes: 5, command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(mark2)}, "x")`] });
  assert.equal(stopReaper(h2), true);
  assert.equal(existsSync(join(h2, "reaper.pid")), false);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(mark2), false);
  // a pid file naming some other process is never killed
  const h3 = home();
  writeFileSync(join(h3, "reaper.pid"), String(process.pid));
  assert.equal(stopReaper(h3), false);
});
