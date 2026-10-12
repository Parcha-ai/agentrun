// The session's code-mode instructions are the SOP files, verbatim (robot-sop.ts is generated: run scripts/gen-robot-sop.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROBOT_CODE_INSTRUCTIONS, ROBOT_SOP, TEACH_SOP } from "../robot-sop.ts";

test("robot-sop.ts is what 04-walks-home/cluster/sop holds (it is generated: run scripts/gen-robot-sop.mjs)", async () => {
  // @ts-expect-error: a plain .mjs script, without types
  const { generated } = await import("../scripts/gen-robot-sop.mjs");
  assert.equal(readFileSync(new URL("../robot-sop.ts", import.meta.url), "utf8"), generated);
});

test("code mode's instructions open by saying how the robot is made, then teach planning", () => {
  assert.match(ROBOT_SOP, /^# Writing the robot\n\n\*\*To make or change the robot, write `robot\/body\.mjs` and build it\.\*\*/);
  assert.match(TEACH_SOP, /teach_skills/);
  assert.ok(ROBOT_CODE_INSTRUCTIONS.startsWith(ROBOT_SOP) && ROBOT_CODE_INSTRUCTIONS.endsWith(TEACH_SOP));
});

test("teach.md gives the result once, after teach_skills, and the reply back home adds only what is new", () => {
  const sop = TEACH_SOP.replace(/\s+/g, " ");
  assert.match(sop, /Give the result once, here/);
  assert.match(sop, /Do not say you are moving or coming back: the move home follows on its own\./);
  assert.match(sop, /## Back home after teaching/);
  assert.match(sop, /one short line that adds only what is new: that you are back, and one thing to try/);
  assert.match(sop, /Do not repeat the result\. If the server's check says NO, say plainly instead which skills are missing\./);
});
