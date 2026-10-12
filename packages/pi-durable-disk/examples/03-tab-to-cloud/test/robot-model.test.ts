// The robot's state and what each tool does to it. Expected values are chosen from the limits and the spec the model is told (looks only keeps the brain, a body change does not), not from the code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS as PAGE_LIMITS, PRESETS, defaultDesign, validateDesign as pageValidate } from "../../04-walks-home/tab/src/design.ts";
import { BODY_CHANGED, COLOR_NAMES, LIMITS, LOOKS_ONLY, MORPH_PRESETS, REACH, applyRobotTool, bodyKey, initialRobot, morphDesign, parseRobot, reachRatio, serializeRobot, validateDesign } from "../robot-model.ts";

const robot = () => initialRobot(defaultDesign());
const call = (s: ReturnType<typeof robot>, tool: string, args: Record<string, unknown>) => applyRobotTool(s, tool, args);
const call2 = (s: ReturnType<typeof robot>, tool: string, args: Record<string, unknown>, context: Parameters<typeof applyRobotTool>[3] = {}) => applyRobotTool(s, tool, args, context);

test("the body's limits and rules are the creature page's own (this file carries a copy, so the cloud host can bundle it)", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(LIMITS)), JSON.parse(JSON.stringify(PAGE_LIMITS)));
  for (const [name, d] of Object.entries(PRESETS)) assert.deepEqual(validateDesign(d as never), pageValidate(d), name);
  const bad = { ...defaultDesign(), torso: { length: 5, width: 0.2, height: 0.1 } };
  assert.deepEqual(validateDesign(bad as never), pageValidate(bad));
});

test("every morph preset is a buildable body of its own, and a body the drawn one is not", () => {
  const keys = new Set<string>();
  for (const p of MORPH_PRESETS.filter((x) => x !== "original")) {
    const d = morphDesign(p);
    assert.deepEqual(validateDesign(d), [], p);
    assert.ok(pageValidate(d as never).length === 0, `${p} is valid for the creature page`);
    keys.add(bodyKey(d));
  }
  assert.equal(keys.size, 5, "five different bodies");
  assert.ok(!keys.has(bodyKey(defaultDesign())), "none of them is the default quadruped");
  assert.equal(morphDesign("spider").legs.length, 3, "a spider has six legs");
});

test("looks-only tools change the looks, never the body, and say the brain still fits", () => {
  let s = robot();
  const key = bodyKey(s.design);
  for (const [tool, args, check] of [
    ["set_color", { part: "legs", color: "red" }, (r: typeof s) => r.look.legs.every((c) => c === "red")],
    ["set_color", { part: "torso", color: "blue" }, (r: typeof s) => r.look.torso === "blue"],
    ["set_color", { part: "front_legs", color: "pink" }, (r: typeof s) => r.look.legs[0] === "pink" && r.look.legs[1] === "red"],
    ["set_color", { part: "back_legs", color: "gray" }, (r: typeof s) => r.look.legs[1] === "gray" && r.look.legs[0] === "pink"],
    ["set_color", { part: "all", color: "green" }, (r: typeof s) => r.look.torso === "green" && r.look.legs.every((c) => c === "green")],
    ["set_shape", { part: "torso", shape: "round" }, (r: typeof s) => r.look.shape.torso === "round"],
    ["set_face", { face: "happy" }, (r: typeof s) => r.look.face === "happy"],
    ["rename", { name: "  Pixel " }, (r: typeof s) => r.name === "Pixel"],
  ] as const) {
    const o = call(s, tool, args);
    assert.equal(o.kind, "looks", `${tool} ${JSON.stringify(args)}: ${o.text}`);
    assert.ok(check(o.state), `${tool} ${JSON.stringify(args)}`);
    assert.equal(bodyKey(o.state.design), key, "the body is untouched");
    assert.ok(o.text.endsWith(LOOKS_ONLY), o.text);
    assert.equal(o.state.edits, s.edits + 1);
    s = o.state;
  }
  assert.equal(call(s, "set_face", { face: "none" }).text.startsWith("The face is gone."), true);
});

test("body tools change the body and say the brain no longer fits; the result names the new size", () => {
  const s = robot(); // torso 0.5 x 0.22 x 0.1, legs 0.2 + 0.2
  const key = bodyKey(s.design);
  const legs = call(s, "resize", { part: "leg_length", factor: 1.5 });
  assert.equal(legs.kind, "body");
  assert.deepEqual(legs.state.design.legs.map((l) => [l.thigh, l.shin]), [[0.3, 0.3], [0.3, 0.3]]);
  assert.match(legs.text, /^The legs are now 0\.60 m long \(x1\.5\)\. This changes the body: the walking brain no longer fits/);
  assert.ok(legs.text.endsWith(BODY_CHANGED));
  assert.notEqual(bodyKey(legs.state.design), key);
  assert.deepEqual(call(s, "resize", { part: "torso_length", factor: 0.8 }).state.design.torso, { length: 0.4, width: 0.22, height: 0.1 });
  assert.equal(call(s, "resize", { part: "leg_thickness", factor: 2 }).state.design.legs[0]!.radius, 0.04);
  const six = call(s, "set_legs", { pairs: 3 });
  assert.equal(six.kind, "body");
  assert.deepEqual(six.state.design.legs.map((l) => l.x), [0.8, 0, -0.8], "a middle pair joins");
  assert.equal(validateDesign(six.state.design).length, 0);
  assert.equal(call(six.state, "set_legs", { pairs: 2 }).state.design.legs.length, 2);
  assert.equal(bodyKey(call(six.state, "set_legs", { pairs: 2 }).state.design), key, "six legs and back to four is the body it was");
  assert.equal(call(s, "morph", { preset: "giraffe" }).kind, "body");
});

test("a size past a limit is refused with the limit, never clamped, and the state is unchanged", () => {
  const s = robot();
  const big = call(s, "resize", { part: "torso_length", factor: 2 }); // 0.5 -> 1.0, the most is 0.9
  assert.equal(big.kind, "refused");
  assert.equal(big.text, "Not done: torso_length would be 1.00 m, the most allowed is 0.90 m (about x1.8).");
  assert.strictEqual(big.state, s);
  const tall = call(call(s, "resize", { part: "torso_length", factor: 1.6 }).state, "resize", { part: "leg_length", factor: 2 }).state; // a 0.8 m torso lets the legs reach 0.4 + 0.4 (the reach rule would stop it on the 0.5 m one)
  const long = call(tall, "resize", { part: "leg_length", factor: 1.5 }); // 0.4 -> 0.6, the most is 0.4
  assert.equal(long.kind, "refused");
  assert.match(long.text, /^Not done: leg_length would be 0\.60 m, the most allowed is 0\.40 m \(where it already is\)\./);
  assert.equal(call(s, "resize", { part: "torso_height", factor: 0.5 }).kind, "body", "0.1 x 0.5 = 0.05 is the least allowed, so it is allowed");
  assert.match(call(call(s, "resize", { part: "torso_height", factor: 0.5 }).state, "resize", { part: "torso_height", factor: 0.5 }).text, /^Not done: torso_height would be 0\.03 m, the least allowed is 0\.05 m \(where it already is\)\./);
});

test("scale grows or shrinks the whole robot, as far as the limits allow, and says when they stopped it", () => {
  const s = robot(); // torso 0.5 x 0.22 x 0.1, legs 0.2 + 0.2, radius 0.02
  const a = call(s, "scale", { factor: 1.5 });
  assert.equal(a.kind, "body");
  assert.deepEqual(a.state.design.torso, { length: 0.75, width: 0.33, height: 0.15 });
  assert.deepEqual(a.state.design.legs.map((l) => [l.thigh, l.shin, l.radius]), [[0.3, 0.3, 0.03], [0.3, 0.3, 0.03]]);
  assert.equal(a.text, `The robot is now x1.5 the size. ${BODY_CHANGED}`);
  // twice: the torso's length (0.5 -> 0.9 at most) stops it at x1.8
  const twice = call(s, "scale", { factor: 2 });
  assert.equal(twice.kind, "body");
  assert.equal(twice.state.design.torso.length, 0.9);
  assert.match(twice.text, /^The robot is now x1\.8 the size, as big as the limits allow \(you asked for x2\)\./);
  assert.deepEqual(validateDesign(twice.state.design), []);
  // at the limit already: refused
  assert.match(call(twice.state, "scale", { factor: 1.2 }).text, /^Not done: the robot is already as big as the limits allow\./);
  // smaller
  const half = call(s, "scale", { factor: 0.5 });
  assert.equal(half.kind, "body");
  assert.deepEqual(validateDesign(half.state.design), []);
  assert.match(half.text, /as small as the limits allow \(you asked for x0\.5\)/, "the legs (0.08 at least) stop it");
  assert.equal(call(s, "scale", { factor: 1 }).kind, "none");
  assert.match(call(s, "scale", { factor: 2.5 }).text, /^Not done: factor must be a number from 0\.5 to 2\./);
});

test("a factor of 1, six legs on a six-legged robot, and morphing to the drawn body when it already is, change nothing and say so", () => {
  const s = robot();
  assert.equal(call(s, "resize", { part: "torso_width", factor: 1 }).kind, "none");
  assert.equal(call(s, "set_legs", { pairs: 2 }).kind, "none");
  assert.match(call(s, "set_legs", { pairs: 2 }).text, /^No change/);
  assert.equal(call(s, "morph", { preset: "original" }).kind, "none");
});

test("morph sets body and looks together; original and reset bring the drawn robot back", () => {
  const s = call(robot(), "rename", { name: "Pixel" }).state;
  const dog = call(s, "morph", { preset: "dog" });
  assert.equal(dog.state.look.torso, "brown");
  assert.equal(dog.state.look.face, "happy");
  assert.equal(dog.state.name, "Pixel", "a morph keeps the name");
  assert.equal(dog.state.original.name, "quadruped");
  const back = call(dog.state, "morph", { preset: "original" });
  assert.equal(bodyKey(back.state.design), bodyKey(s.original));
  assert.equal(back.state.look.torso, null);
  const reset = call(dog.state, "reset", {});
  assert.equal(reset.kind, "body");
  assert.equal(reset.state.edits, 0);
  assert.equal(bodyKey(reset.state.design), bodyKey(s.original));
  assert.equal(call(call(robot(), "set_face", { face: "cool" }).state, "reset", {}).kind, "looks", "a reset that only undid looks keeps the brain");
});

test("bad arguments are refused with the choices, whatever the schema let through; the state is never changed", () => {
  const s = robot();
  const frozen = JSON.stringify(s);
  for (const [tool, args, why] of [
    ["set_color", { part: "tail", color: "red" }, /part must be one of torso, legs/],
    ["set_color", { part: "legs", color: "teal" }, new RegExp(`color must be one of ${COLOR_NAMES.join(", ")}`)],
    ["set_shape", { part: "torso", shape: "pointy" }, /shape must be one of boxy, round/],
    ["set_face", { face: "grumpy" }, /face must be one of happy/],
    ["rename", { name: "" }, /1 to 24 characters/],
    ["rename", { name: "x".repeat(25) }, /1 to 24 characters/],
    ["rename", { name: "a\nb" }, /control characters/],
    ["resize", { part: "torso_depth", factor: 1.2 }, /part must be one of torso_length/],
    ["resize", { part: "torso_length", factor: 3 }, /factor must be a number from 0.5 to 2/],
    ["resize", { part: "torso_length", factor: "big" }, /factor must be a number/],
    ["set_legs", { pairs: 4 }, /pairs must be 2/],
    ["morph", { preset: "dragon" }, /preset must be one of dog/],
    ["fly", {}, /there is no tool "fly"/],
  ] as const) {
    const o = call(s, tool, args);
    assert.equal(o.kind, "refused", `${tool} ${JSON.stringify(args)}`);
    assert.match(o.text, why);
    assert.ok(o.text.startsWith("Not done: "));
  }
  assert.equal(JSON.stringify(s), frozen, "the state passed in was not modified");
});

test("the state file round-trips, and what this module did not write is not taken", () => {
  const s = call(call(robot(), "morph", { preset: "spider" }).state, "set_color", { part: "torso", color: "red" }).state;
  assert.deepEqual(parseRobot(serializeRobot(s)), s);
  assert.equal(parseRobot("not json"), undefined);
  assert.equal(parseRobot("{}"), undefined);
  assert.equal(parseRobot(JSON.stringify({ ...s, design: { ...s.design, torso: { length: 9, width: 0.2, height: 0.1 } } })), undefined, "a body outside the limits is not a robot");
  assert.equal(parseRobot(JSON.stringify({ ...s, version: 2 })), undefined);
});

test("update_robot: one call does a combined ask in a fixed order (reset, morph, scale, legs, color, face, name) with the nine tools' own edits", async () => {
  const { applyUpdateRobot } = await import("../robot-model.ts");
  const s = robot();
  const spider = applyUpdateRobot(s, { morph: "spider", color: "red" });
  assert.equal(spider.kind, "body");
  assert.equal(spider.state.design.legs.length, 3);
  assert.equal(spider.state.look.torso, "red", "the colour came after the morph, so it overrides the preset's black");
  assert.deepEqual(spider.state.look.legs, ["red", "red", "red"]);
  assert.equal(spider.text, `The robot is now a spider. The whole robot is now red. ${BODY_CHANGED}`);
  // the same result as the separate tools in that order
  const two = call(call(s, "morph", { preset: "spider" }).state, "set_color", { part: "all", color: "red" }).state;
  assert.deepEqual({ ...spider.state, edits: 0 }, { ...two, edits: 0 });
  // the order is fixed whatever the keys' order: reset first, then morph
  const reset = applyUpdateRobot(call(s, "set_face", { face: "angry" }).state, { color: "blue", reset: true, morph: "dog" });
  assert.equal(reset.state.look.face, "happy", "reset, then the dog's own face; the angry one is gone");
  assert.equal(reset.state.look.torso, "blue");
  // looks only: the brain still fits
  const looks = applyUpdateRobot(s, { color: "green", part: "legs", face: "cool", name: "Pixel" });
  assert.equal(looks.kind, "looks");
  assert.ok(looks.text.endsWith(LOOKS_ONLY));
  assert.deepEqual(looks.state.look.legs, ["green", "green", "green"]);
  assert.equal(looks.state.name, "Pixel");
  // four and six legs are the pairs
  assert.equal(applyUpdateRobot(s, { legs: 6 }).state.design.legs.length, 3);
  assert.equal(applyUpdateRobot(s, { legs: 3 }).state.design.legs.length, 3);
  // a refused step is reported and the others apply
  const partial = applyUpdateRobot(s, { scale: 2, name: "x".repeat(30), color: "pink" });
  assert.equal(partial.kind, "body");
  assert.match(partial.text, /Not done: the name must be 1 to 24 characters\./);
  assert.match(partial.text, /The whole robot is now pink\./);
  // all refused, nothing to do, unknown fields, a part with no colour
  assert.equal(applyUpdateRobot(s, { name: "" }).kind, "refused");
  assert.equal(applyUpdateRobot(s, {}).kind, "refused");
  assert.match(applyUpdateRobot(s, { colour: "red" }).text, /unknown field "colour"/);
  assert.match(applyUpdateRobot(s, { part: "legs" }).text, /part needs a color/);
  assert.equal(applyUpdateRobot(s, { scale: 1 }).kind, "none");
  assert.strictEqual(applyUpdateRobot(s, { scale: 1 }).state, s);
});

test("do(skill): only a skill that came home can be chosen; the body and looks are untouched, the brain still fits", async () => {
  const { SKILL_CHANGED } = await import("../robot-model.ts");
  const s = robot();
  const skills = { walk: { label: "walk" }, sprint: { label: "sprint", command: 1.2 } };
  const sprint = call2(s, "do", { skill: "sprint" }, { skills });
  assert.equal(sprint.kind, "skill");
  assert.equal(sprint.state.skill, "sprint");
  assert.equal(sprint.text, `The robot is now doing sprint. ${SKILL_CHANGED}`);
  assert.equal(bodyKey(sprint.state.design), bodyKey(s.design));
  assert.deepEqual(sprint.state.look, s.look);
  assert.match(call2(s, "do", { skill: "spin" }, { skills }).text, /^Not done: the robot has not learned spin; it can do walk, sprint\./);
  assert.match(call2(s, "do", { skill: "fly" }, { skills }).text, /^Not done: skill must be one of walk, sprint/);
  assert.match(call2(s, "do", { skill: "walk" }, {}).text, /^Not done: no skill has come home yet/);
  assert.match(call2(sprint.state, "do", { skill: "sprint" }, { skills }).text, /^No change: the robot is already doing sprint\./);
  // a reset forgets the skill with the rest; update_robot can carry it, after the body and looks
  assert.equal(call2(sprint.state, "reset", {}).state.skill, undefined);
  const { applyUpdateRobot } = await import("../robot-model.ts");
  const both = applyUpdateRobot(s, { morph: "dog", skill: "sprint" }, { skills });
  assert.equal(both.state.skill, "sprint");
  assert.equal(both.kind, "body");
  assert.equal(both.text, `The robot is now a dog. The robot is now doing sprint. ${BODY_CHANGED}`);
  assert.equal(applyUpdateRobot(s, { skill: "sprint" }, { skills }).kind, "skill");
});

test("a leg longer than 1.5 torso lengths is refused: every preset keeps within it, longer legs and a shorter torso are refused, and the robot is left as it was", () => {
  for (const p of MORPH_PRESETS.filter((x) => x !== "original")) assert.ok(reachRatio(morphDesign(p)!) <= REACH + 1e-9, `${p} reaches ${reachRatio(morphDesign(p)!).toFixed(3)} torso lengths`);
  const dog = applyRobotTool(initialRobot(morphDesign("dog")!), "morph", { preset: "giraffe" }).state;
  assert.equal(dog.design.torso.length, 0.5, "the giraffe's torso is 0.5 m (measured: it learns to walk with that torso, not with 0.45)");
  const stock = robot(); // torso 0.5, legs 0.2 + 0.2
  const longer = applyRobotTool(stock, "resize", { part: "leg_length", factor: 2 });
  assert.equal(longer.kind, "refused");
  assert.match(longer.text, /^Not done: the legs would be 0\.8 m long on a 0\.5 m torso, and a leg longer than 1\.5 torso lengths \(0\.75 m here\)/);
  assert.equal(longer.state, stock, "nothing changed");
  const shorter = applyRobotTool(dog, "resize", { part: "torso_length", factor: 0.6 });
  assert.equal(shorter.kind, "refused", "a shorter torso under the same legs would break it just as well");
  const ok = applyRobotTool(dog, "resize", { part: "leg_length", factor: 1.1 });
  assert.equal(ok.kind, "body");
  const whole = applyRobotTool(dog, "scale", { factor: 1.3 });
  assert.equal(whole.kind, "body", "scaling the whole robot keeps the ratio");
});
