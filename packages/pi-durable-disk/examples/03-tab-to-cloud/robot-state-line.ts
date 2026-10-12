// The robot as one line the small model reads before the user's turn (D1's window spec, format T7): its name, its body, its legs, colors, shapes, face, what
// it is doing and which skills came home. D1 scored v3 with this line as the assistant's own last message (state questions 7/42 -> 37/42, commands within a
// point). The wording is D1's reference, verbatim: the model was scored on exactly these bytes. Pure.
import { bodyKey, morphDesign, SKILL_NAMES, type RobotState } from "./robot-model.ts";

const PRESETS = ["dog", "spider", "giraffe", "lizard", "stubby"] as const;

/**
 * "doing": the skill the state names; with none named, the default the page plays (`defaultSkill`, robot-tools.ts defaultSkill; walk when not given) when any
 * skill is home; else "nothing" (the spec as D1 corrected it with D3). `null`: the page plays nothing by itself (a floor with a flag, where the robot
 * waits at the start for the ask).
 */
export function stateLine(s: RobotState, skillsHome: readonly string[], defaultSkill?: string | null): string {
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
    + `doing ${s.skill ?? (home.length > 0 && defaultSkill !== null ? (defaultSkill ?? "walk") : "nothing")}; skills home: ${home.length ? home.join(", ") : "none yet"}.]`;
}

/** A body written as code, as its robot/body.json describes it: what the state line needs. */
export interface CodeBodyFacts {
  /** body.json's `name`: what the body is. A rename changes the robot's name, not this. */
  readonly body: string;
  /** body.json's `tag_list`: the tags the body has, in its order. */
  readonly tags: readonly string[];
  /** body.json's `tags` and `colors`: each piece's tags and colour (a name or #rrggbb), in body.json's order. */
  readonly pieceTags: Readonly<Record<string, readonly string[]>>;
  readonly pieceColors: Readonly<Record<string, string>>;
  /** How many legs it has. */
  readonly legs: number;
}

/**
 * Each tag's colour now: its own set_color, else a set_color on all, else the body's own colour for it, which is the
 * colour of the first piece carrying the tag in body.json's order (a node comes before its extra pieces, so the head is
 * the head's colour, not its eyes').
 */
export function codeTagColors(body: CodeBodyFacts, overrides: Readonly<Record<string, string | null>> = {}): [string, string][] {
  return body.tags.map((tag) => {
    const set = overrides[tag] ?? overrides.all;
    if (set) return [tag, set];
    const first = Object.entries(body.pieceTags).find(([, tags]) => tags.includes(tag))?.[0];
    return [tag, (first !== undefined ? body.pieceColors[first] : undefined) ?? "gray"];
  });
}

/**
 * The state line on a body written as code (D1's v6 format, verbatim: v6 was trained on these bytes). Tags keep their
 * underscores, as the look tools name them; there is no shapes field. Skills home are listed in the order given (a code
 * body's skills are the ones its threads were planned with, not D2's eight).
 */
export function codeStateLine(robot: { readonly name: string; readonly face: string; readonly skill?: string }, body: CodeBodyFacts, overrides: Readonly<Record<string, string | null>>, skillsHome: readonly string[], defaultSkill?: string | null): string {
  const colors = codeTagColors(body, overrides).map(([t, c]) => `${t} ${c}`).join(", ");
  const doing = robot.skill ?? (skillsHome.length > 0 && defaultSkill !== null ? (defaultSkill ?? "walk") : "nothing");
  return `[Robot now: named ${robot.name}; body ${body.body}, built from code; ${body.legs} legs; colors ${colors}; face ${robot.face === "none" ? "no face" : robot.face}; `
    + `doing ${doing}; skills home: ${skillsHome.length ? skillsHome.join(", ") : "none yet"}.]`;
}
