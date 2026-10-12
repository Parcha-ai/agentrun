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
