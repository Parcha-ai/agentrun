# Writing the robot

The robot is code you write: `robot/body.mjs`. It builds the body from pieces with the helper in `robot/lib.mjs`.
"Make a dinosaur robot" means writing a body that looks like a dinosaur: a body, legs, a neck, a head, a tail, plates,
its colours. There is no menu of presets and no fixed number of legs. Write what was asked for, build it, read what
came back, and fix your own code until it builds and stands.

## The loop, in this order
1. **Call `build_robot` first.** It puts the helper files in the workspace (`robot/lib.mjs`, `robot/build.mjs`,
   `robot/examples/dog.mjs`, `robot/examples/dino.mjs`) and answers `No robot is built yet. ... Write robot/body.mjs
   ...`. Never edit lib.mjs or build.mjs.
2. **Read before you write.** Read the example closest to what was asked (`cat robot/examples/dino.mjs`). The full
   format reference is the header comment of `robot/lib.mjs`.
3. **Write `robot/body.mjs`.**
4. **Run `node robot/build.mjs` in bash.** It runs your file and writes `robot/body.xml` and `robot/body.json`. It
   prints `wrote robot/body.xml and robot/body.json: N pieces, M motors, K spring joints, X kg, standing height Y m.
   Tags: ...` and any warnings. Or it prints `body.mjs: <the error>` and exits 1: fix that and run it again.
5. **Call `build_robot` again.** The robot page compiles the body in MuJoCo, holds its standing pose for 3 s, shows it
   and answers:
   - `Built dino: 32 pieces, 8 motors, 10 spring joints, 10.99 kg, stands 0.389 m high. Tags: ...`: it is built. Tell
     the user in one sentence what you built.
   - `Not built: MuJoCo: <its error>`: it names the element and the attribute. Fix that value. The robot on screen stays
     as it was.
   - A warning (it does not stand, it collapses): fix the stand angles, the joint ranges, the masses or the legs' reach.
   - `Written, but not checked: the creature page did not report ...`: the page is not open. Say so; do not claim it
     built.
6. **Fix and repeat** from step 3 until build_robot says `Built`. Warnings are advice, not refusals: read them and
   decide. Never claim it built or stands unless build_robot said so.

## The file
```js
import { robot, chain, mirror } from "./lib.mjs";
export default robot("name", torsoNode, { face: { tag: "head", at: [x, y, z] } });   // the face option is optional
```
Units are metres and radians. +x is forward, +y is the robot's left, +z is up. A node is one rigid piece:
- `pos: [x, y, z]`: where its origin sits in its parent.
- `shape` is `"box" | "sphere" | "capsule" | "cylinder" | "ellipsoid"`, with `size`: box `[hx, hy, hz]` half extents,
  sphere `[r]`, capsule or cylinder `[r, halfLength]` along its z, ellipsoid `[rx, ry, rz]`.
- A limb instead uses `from: [0,0,0], to: [0,0,-0.2]` with `size: [r]`.
- `color`: red, orange, yellow, green, blue, purple, pink, white, black, gray or brown, or `"#rrggbb"`.
- `mass` in kg (by default it comes from the volume).
- `tags: [...]`: what the piece is (below).
- `joint`: `{ axis: [0,1,0], range: [lo, hi], stand: angle, strength: 12 }` is a motor the robot learns to drive. With
  `passive: true, stiffness, damping` it is a spring instead: a tail or a neck that swings as the robot moves.
- `geoms: [...]`: extra pieces on the same rigid body (a nose, eyes, plates).
- `children: [...]`: the nodes hanging off this one.

Helpers: `chain(n, i => node)` hangs n segments off each other (tails, necks). `mirror(node, "_r")` makes the other side
from one side.

## Rules
- **Only the legs are motors.** Every joint that is not `passive: true` is a motor the trainer must learn, so ask only
  for leg joints: a hip and a knee per leg, 8 motors for four legs, is a good number. Neck, tail and jaw segments are
  `passive: true` springs (the dinosaur below has 8 motors and 10 springs).
- **Motors before springs.** Along one limb the motors come first; a spring above a motor is refused (build.mjs names
  the joint). Across limbs it doesn't matter: the limbs with motors are put first for you, so a tail can be listed
  before the legs.
- **Tag every piece**, from these 16: torso, head, neck, tail, legs, front_legs, back_legs, arms, wings, eyes, jaw,
  belly, plates, horns, spikes, decoration. The look tools ("paint the plates orange", "give it a face") reach a piece
  only through its tags, online and offline. A piece with no tag becomes decoration.
- **Legs carry two tags:** `["legs", "front_legs"]` or `["legs", "back_legs"]`, on every piece of the leg and its foot.
- **Name nothing the helper names:** the root body is torso, each leg's foot is `<body>_foot`, and the keyframes are
  stand and home. The foot is the last piece at the tip of a limb tagged legs, and any shape works; if the tip is not
  the foot, mark the foot piece with `foot: true`.
- **Stance:** at their `stand` angles the feet must reach the floor and hold the body up. Put the mass low and between
  the feet, and use wide feet for a heavy body.
- **Weight:** 1 to 30 kg in total, with the torso the heaviest piece. Tails, necks and decorations stay light.

## Changing it later
Its size, its legs and its shape change by editing `robot/body.mjs` and running the loop again from step 4. Once
`robot/body.json` exists you are no longer offered resize, scale, set_legs or morph. The look tools still work on it by
tag: set_color and set_shape with a part such as tail, plates or wings (or all); set_face on the head; rename; reset
back to the body's own colours.

## After a body change
Skills taught to an earlier body do not fit a new body: the robot stumbles until it learns them again. When the body
changes, say so, and offer to teach it again.

## Two bodies that build and stand (copy one and change it)
These are `robot/examples/dog.mjs` and `robot/examples/dino.mjs` as `robot/body.mjs` would import the helper (`./lib.mjs`;
the copies in `robot/examples/` import `../lib.mjs`).
```js
// A small dog: a box torso, four two-joint legs, a head, a tail. Copy it, change it, make it yours.
import { robot, mirror } from "./lib.mjs";

const leg = (x, side) => {
  const l = {
    name: `leg_${x > 0 ? "front" : "back"}`, pos: [x, 0.12, 0], tags: ["legs", x > 0 ? "front_legs" : "back_legs"],
    joint: { axis: [0, 1, 0], range: [-1, 1], stand: -0.45 },                       // the hip swings the whole leg forward and back
    shape: "capsule", from: [0, 0, 0], to: [0, 0, -0.2], size: [0.02], color: "brown",
    children: [{
      name: "shin", pos: [0, 0, -0.2], tags: ["legs", x > 0 ? "front_legs" : "back_legs"],
      joint: { axis: [0, 1, 0], range: [0, 2.3], stand: 0.9 },                       // the knee bends it back
      shape: "capsule", from: [0, 0, 0], to: [0, 0, -0.2], size: [0.018], color: "brown",
      geoms: [{ shape: "sphere", size: [0.023], pos: [0, 0, -0.2], color: "black", friction: "1.2 0.05 0.01" }], // the foot
    }],
  };
  return side === "left" ? l : mirror(l);
};

export default robot("dog", {
  shape: "box", size: [0.28, 0.1, 0.06], color: "brown", tags: ["torso"], mass: 2.4,
  geoms: [
    { shape: "sphere", size: [0.07], pos: [0.34, 0, 0.05], color: "brown", tags: ["head"] },        // the head
    { shape: "capsule", from: [0.4, 0, 0.03], to: [0.46, 0, 0.03], size: [0.03], color: "black", tags: ["head"] }, // the nose
  ],
  children: [leg(0.2, "left"), leg(0.2, "right"), leg(-0.2, "left"), leg(-0.2, "right"),
    { name: "tail", pos: [-0.28, 0, 0.04], tags: ["tail"], joint: { axis: [0, 1, 0], range: [-0.6, 0.9], stand: 0.3, passive: true, stiffness: 0.4, damping: 0.05 }, shape: "capsule", from: [0, 0, 0], to: [-0.2, 0, 0.06], size: [0.015], color: "brown", mass: 0.08 }],
});
```

```js
// A dinosaur: a heavy body, four thick two-joint legs, a neck that rises in four swinging segments to a head with eyes and a jaw, a tail of six segments that trails behind, and a row of plates down the back.
// The legs are the only trainable joints (8 motors); the neck and the tail are springs that swing as the body moves. Every piece carries tags, so "paint the plates orange" and "give it a face" work on this body too.
import { robot, mirror, chain } from "./lib.mjs";

const SKIN = "green", BELLY = "yellow", PLATE = "orange";

const leg = (name, x, front) => {
  const tags = ["legs", front ? "front_legs" : "back_legs"];
  const l = {
    name, pos: [x, 0.17, -0.03], tags,
    joint: { axis: [0, 1, 0], range: [-1, 1], stand: -0.4, strength: 14 },
    shape: "capsule", from: [0, 0, 0], to: [0, 0, -0.17], size: [0.032], color: SKIN, mass: 0.45,
    children: [{
      name: `${name}_shin`, pos: [0, 0, -0.17], tags,
      joint: { axis: [0, 1, 0], range: [0, 2.3], stand: 0.9, strength: 14 },
      shape: "capsule", from: [0, 0, 0], to: [0, 0, -0.17], size: [0.028], color: SKIN, mass: 0.3,
      geoms: [{ shape: "box", size: [0.05, 0.035, 0.015], pos: [0.02, 0, -0.18], color: BELLY, mass: 0.1, friction: "1.4 0.05 0.01", tags }], // a flat foot
    }],
  };
  return l;
};

const neck = chain(4, (i) => ({
  name: `neck${i}`, pos: i === 0 ? [0.3, 0, 0.06] : [0.07, 0, 0.05], tags: ["neck"],
  joint: { axis: [0, 1, 0], range: [-0.5, 0.5], stand: -0.18, passive: true, stiffness: 3, damping: 0.4 },
  shape: "capsule", from: [0, 0, 0], to: [0.07, 0, 0.05], size: [0.04 - i * 0.004], color: SKIN, mass: 0.2,
  children: i < 3 ? [] : [{
    name: "head", pos: [0.07, 0, 0.05], tags: ["head"], shape: "ellipsoid", size: [0.1, 0.055, 0.05], color: SKIN, mass: 0.35,
    geoms: [
      { shape: "ellipsoid", size: [0.06, 0.045, 0.02], pos: [0.07, 0, -0.04], color: BELLY, tags: ["head", "jaw"], mass: 0.05 },   // the jaw
      { shape: "sphere", size: [0.013], pos: [0.05, 0.045, 0.02], color: "white", tags: ["head", "eyes"], mass: 0.01 },             // the eyes
      { shape: "sphere", size: [0.013], pos: [0.05, -0.045, 0.02], color: "white", tags: ["head", "eyes"], mass: 0.01 },
    ],
  }],
}));

const tail = chain(6, (i) => ({
  name: `tail${i}`, pos: i === 0 ? [-0.3, 0, 0.02] : [-0.1, 0, 0], tags: ["tail"],
  joint: { axis: [0, 1, 0], range: [-0.45, 0.45], stand: 0.04, passive: true, stiffness: 1.2 - i * 0.15, damping: 0.25 },
  shape: "capsule", from: [0, 0, 0], to: [-0.1, 0, 0], size: [0.045 - i * 0.006], color: SKIN, mass: 0.25 - i * 0.03,
}));

export default robot("dino", {
  name: "torso", shape: "ellipsoid", size: [0.32, 0.17, 0.12], color: SKIN, mass: 5, tags: ["torso"],
  geoms: [
    { shape: "ellipsoid", size: [0.26, 0.14, 0.06], pos: [0, 0, -0.07], color: BELLY, mass: 0.2, tags: ["torso", "belly"] },
    ...[-0.2, -0.07, 0.06, 0.19].map((x) => ({ shape: "box", size: [0.035, 0.012, 0.045 + 0.01 * (1 - Math.abs(x))], pos: [x, 0, 0.14], color: PLATE, mass: 0.03, tags: ["plates"] })), // plates down the back
  ],
  children: [leg("front_left", 0.22, true), mirror(leg("front_left", 0.22, true), "_r"), leg("back_left", -0.2, false), mirror(leg("back_left", -0.2, false), "_r"), neck, tail],
}, { face: { tag: "head", at: [0.1, 0, 0.02] } });
```
