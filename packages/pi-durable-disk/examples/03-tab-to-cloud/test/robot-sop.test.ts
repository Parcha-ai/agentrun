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
  assert.match(sop, /one short line that adds only what is new: that you are back, and one thing to try, naming one skill from the server's list of skills that came home \("Back in your browser\. Try: make it <that skill>\."\)/);
  assert.doesNotMatch(sop, /Try: make it spin/, "the example names no skill that may not be home");
  assert.match(sop, /Do not repeat the result\. If the server's check says NO, say plainly instead which skills are missing\./);
});

test("robot.md asks for a body that can learn to walk: flat box feet with friction 1.4, leg motors of strength 14, a heavy torso, and says why", () => {
  const sop = ROBOT_SOP.replace(/\s+/g, " ");
  assert.match(sop, /\*\*Feet, motors and mass, so it can learn to walk:\*\* every foot a flat box with `friction: "1\.4 0\.05 0\.01"`, every leg motor `strength: 14` or more, and most of the mass in the torso\./);
  assert.match(sop, /ball feet walked 0\.087 m\/s and never passed; flat box feet with friction 1\.4 passed in 125 s; with strength 14 and a 6 kg torso as well, in 86\.6 s/);
  assert.doesNotMatch(sop, /and any shape works/, "the foot's shape matters now");
});

test("robot.md quotes the dog and the dinosaur examples byte for byte, as the workspace gets them", () => {
  const body = (f: string) => readFileSync(new URL(`../../04-walks-home/body/${f}`, import.meta.url), "utf8");
  assert.ok(ROBOT_SOP.includes(body("dog.example.mjs")), "robot.md's dog is dog.example.mjs");
  assert.ok(ROBOT_SOP.includes(body("dino.example.mjs")), "robot.md's dinosaur is dino.example.mjs");
});
