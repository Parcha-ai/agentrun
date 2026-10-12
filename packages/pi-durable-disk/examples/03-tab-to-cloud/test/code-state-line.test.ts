// The state line on a body written as code: the bytes D1's v6 was trained on (window.py code_state_line), so the phone's
// model reads in the tab what it learned from.
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeStateLine, codeTagColors, type CodeBodyFacts } from "../robot-state-line.ts";

const dino: CodeBodyFacts = {
  body: "dino",
  tags: ["torso", "belly", "plates", "front_legs", "legs", "head", "eyes"],
  pieceTags: { torso: ["torso"], torso_g1: ["torso", "belly"], torso_g2: ["plates"], front_left: ["legs", "front_legs"], back_left: ["legs", "back_legs"], back_left_foot: ["legs"], head: ["head"], head_g1: ["head", "eyes"], head_g2: ["head", "eyes"] },
  pieceColors: { torso: "green", torso_g1: "yellow", torso_g2: "orange", front_left: "green", back_left: "green", back_left_foot: "yellow", head: "green", head_g1: "white", head_g2: "white" },
  legs: 4,
};

test("a code body's line is v6's bytes: its own colours per tag, the face, what it does, the skills home in their order", () => {
  assert.equal(
    codeStateLine({ name: "dino", face: "none" }, dino, {}, ["walk", "spin"]),
    "[Robot now: named dino; body dino, built from code; 4 legs; colors torso green, belly yellow, plates orange, front_legs green, legs green, head green, eyes white; face no face; doing walk; skills home: walk, spin.]",
  );
  const beetle: CodeBodyFacts = { body: "beetle", tags: ["torso", "head", "legs", "horns"], pieceTags: { torso: ["torso"], head: ["head"], leg: ["legs"], horn: ["horns"] }, pieceColors: { torso: "black", head: "black", leg: "red", horn: "gray" }, legs: 6 };
  assert.equal(
    codeStateLine({ name: "Bolt", face: "happy" }, beetle, { horns: "yellow" }, []),
    "[Robot now: named Bolt; body beetle, built from code; 6 legs; colors torso black, head black, legs red, horns yellow; face happy; doing nothing; skills home: none yet.]",
  );
});

test("a tag's colour is its own set_color, else the whole robot's, else its first piece's", () => {
  const colors = (o: Record<string, string | null> = {}) => Object.fromEntries(codeTagColors(dino, o));
  assert.equal(colors().torso, "green", "the torso, not its yellow belly piece that also carries torso");
  assert.equal(colors().head, "green", "the head node, not the two white eye pieces that also carry head");
  assert.equal(colors().belly, "yellow");
  assert.deepEqual(colors({ all: "red", plates: "blue" }), { torso: "red", belly: "red", plates: "blue", front_legs: "red", legs: "red", head: "red", eyes: "red" });
  assert.equal(colors({ tail: "red" }).torso, "green", "an override for a tag the body lacks changes nothing");
});

test("a skill the page plays, or one named, is what it does; skills home keep a planned order, not D2's eight", () => {
  assert.match(codeStateLine({ name: "dino", face: "none" }, dino, {}, ["wag-tail", "walk"], "wag-tail"), /doing wag-tail; skills home: wag-tail, walk\.\]$/);
  assert.match(codeStateLine({ name: "dino", face: "none", skill: "walk" }, dino, {}, ["wag-tail", "walk"]), /doing walk;/);
});
