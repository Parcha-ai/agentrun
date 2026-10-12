// The robot as one line the small model reads before the user's turn (D1's window spec, format T7): its name, its body, its legs, colors, shapes, face, what
// it is doing and which skills came home. D1 scored v3 with this line as the assistant's own last message (state questions 7/42 -> 37/42, commands within a
// point). The wording is D1's reference, verbatim: the model was scored on exactly these bytes. Pure.
import { bodyKey, morphDesign, SKILL_NAMES, type RobotState } from "./robot-model.ts";

const PRESETS = ["dog", "spider", "giraffe", "lizard", "stubby"] as const;

/**
 * "doing": the skill the state names; with none named, the skills manifest's default (`defaultSkill`, home/skills.json's `default`, normally walk) when any
 * skill is home, since that is what the page plays; else "nothing" (the spec as D1 corrected it with D3).
 */
export function stateLine(s: RobotState, skillsHome: readonly string[], defaultSkill?: string): string {
  const key = bodyKey(s.design);
  const preset = PRESETS.find((p) => bodyKey(morphDesign(p)) === key);
  const changed = key !== bodyKey(s.original);
  const body = preset ?? (changed ? "reshaped" : "as drawn");
  const pairs = s.design.legs.length;
  const c = (x: string | null) => x ?? "default";
  const legs = s.look.legs.slice(0, pairs);
  const names = pairs === 3 ? ["front legs", "middle legs", "back legs"] : ["front legs", "back legs"];
  const legColors = legs.every((x) => x === legs[0]) ? `legs ${c(legs[0] ?? null)}` : legs.map((x, i) => `${names[i]} ${c(x)}`).join(", ");
  const home = SKILL_NAMES.filter((n) => skillsHome.includes(n)); // D2's order
  return `[Robot now: named ${s.name}; body ${body}${changed ? ", changed since drawn" : ""}; ${2 * pairs} legs; colors torso ${c(s.look.torso)}, ${legColors}; `
    + `shapes torso ${s.look.shape.torso}, legs ${s.look.shape.legs}; face ${s.look.face === "none" ? "no face" : s.look.face}; `
    + `doing ${s.skill ?? (home.length > 0 && defaultSkill ? defaultSkill : "nothing")}; skills home: ${home.length ? home.join(", ") : "none yet"}.]`;
}
