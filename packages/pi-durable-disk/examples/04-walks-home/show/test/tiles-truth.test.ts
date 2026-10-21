// What the tiles may say, and where each saying comes from. Pure parts of the page, so they run without a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHomeSkills } from "../relearn.ts";
import { parseSkillJson, skillEvents } from "../skills.ts";
import { skillsToPoll } from "../page/skills-poller.ts";
import { homeLandings, threadsHtml } from "../threads-view.ts";
import type { Thread } from "../types.ts";

const T = (id: string, status: Thread["status"], home = false): Thread => ({ id, skill: id, host: null, status, acquireMs: null, costUsd: null, metric: null, unit: null, target: null, mjcf: null, bodyName: null, passedS: null, wallS: null, cpuS: null, cpuCores: null, home, points: [], at: 0 });

test("the poller reads the directories of the threads the run has, so a skill named in the plan (sit) is read and a name nobody forked (get-up) is not", () => {
  const forked = ["walk", "sprint", "sit"].map((id) => T(id, "learning"));
  assert.deepEqual([...skillsToPoll(forked)].sort(), ["sit", "sprint", "walk"]);
  assert.ok(!skillsToPoll(forked).includes("get-up"));
});

test("before any thread exists the poller falls back to the library's names (a rehearsal with no relay still reads its files)", () => {
  const names = skillsToPoll([]);
  assert.ok(names.includes("walk") && names.includes("spin"));
});

test("the heading counts the threads the run forked: 3 threads say 3, 8 say 8, and no waiting tile is invented", () => {
  const three = threadsHtml(["walk", "spin", "wave"].map((id) => T(id, "learning")));
  assert.match(three, /split into 3 threads/);
  assert.equal((three.match(/class="tile"/g) ?? []).length, 3);
  const eight = threadsHtml(Array.from({ length: 8 }, (_, i) => T(`s${i}`, "learning")));
  assert.match(eight, /split into 8 threads/);
});

test("nothing is in the robot because a clock ran: a skill lands only when the robot's home lists it, it finished, and the run is home", () => {
  const threads = [T("walk", "done"), T("spin", "done"), T("wave", "learning"), T("sit", "failed")];
  const listed = new Set(["walk", "spin", "wave", "sit"]);
  assert.deepEqual(homeLandings(threads, listed, false), [], "the run is not home: nothing lands");
  assert.deepEqual(homeLandings(threads, new Set(), true), [], "the robot's home lists nothing: nothing lands");
  assert.deepEqual(homeLandings(threads, listed, true), ["walk", "spin"], "finished and listed only: a learning skill and a failed one do not");
  assert.deepEqual(homeLandings([T("walk", "done", true)], listed, true), [], "one already in is not said again");
});

test("home/skills.json is read for the names of the skills the robot holds, as well as its body", () => {
  const text = JSON.stringify({ version: 1, body_mjcf_sha256: "ab".repeat(32), skills: { spin: { policy: "skills/spin.json" }, sit: { policy: "skills/sit.json" } } });
  assert.deepEqual(parseHomeSkills(text), { bodySha: "ab".repeat(32), skills: ["spin", "sit"] });
});

test("a skill the trainer refused or only compiled still has a tile that says so, instead of a file the stage cannot read", () => {
  const refused = parseSkillJson(JSON.stringify({ skill: "get-up", status: "refused", label: "get up" }));
  assert.ok(refused, "the trainer writes status refused; the stage reads it");
  assert.equal(skillEvents("get-up", refused, [], 0, 0)[0]!.t === "thread" && (skillEvents("get-up", refused, [], 0, 0)[0] as { patch: { status?: string } }).patch.status, "failed");
  const compiled = parseSkillJson(JSON.stringify({ skill: "walk", status: "compiled" }));
  assert.ok(compiled);
  assert.equal((skillEvents("walk", compiled, [], 0, 0)[0] as { patch: { status?: string } }).patch.status, "learning", "compiled: the box has the program and the training is next");
});
