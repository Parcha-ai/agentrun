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
  assert.match(sop, /one short line that adds only what is new: that you are back, and one thing to try\. When the server's check gives the line to try \(with a flag on the floor and walk home, "Back in your browser\. Try: walk to the flag\."\), say that line; otherwise name one skill from the server's list of skills that came home \("Back in your browser\. Try: make it <that skill>\."\)/);
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

test("robot.md and teach.md tell the agent about the flag: before training a move request tries and offers to teach, after it reports whether it reached the flag", () => {
  const robot = ROBOT_SOP.replace(/\s+/g, " ");
  assert.match(robot, /## The flag: a place and a goal/);
  assert.match(robot, /nothing plays by itself: it waits at the start for the ask\. "Walk to the flag", "go get the flag" or "make it walk" is `do walk` \(`do sprint` if they want it to run there\), whether or not that skill has been taught\./);
  assert.match(robot, /\*\*Not taught yet:\*\* the robot tries and fails where everyone can see it .* offer to teach it \("Want me to teach it to walk\?"\)\. The try is the point: do not refuse it/);
  assert.match(robot, /\*\*Taught:\*\* it walks\. Say whether it reached the flag and how long it took, from the result\. Never say it reached the flag unless the result says it did\./);
  assert.match(TEACH_SOP.replace(/\s+/g, " "), /"Teach it to walk to the flag" means walk; add turn-left and turn-right only if the user wants it to steer\./);
});
