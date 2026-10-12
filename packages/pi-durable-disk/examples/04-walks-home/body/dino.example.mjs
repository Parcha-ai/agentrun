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
