// The robot as the agent edits it: ONE state file in the workspace (creature/robot.json) holding the body (the design the physics is built from), the looks (colours, shapes, a face, a name) and the
// body the user drew (what `reset` and `morph original` return to). The agent's robot tools (robot-tools.ts) change it through `applyRobotTool`; the creature page (04-walks-home/tab) watches the file,
// redraws, and keeps or drops the walking brain by comparing the body with the one the policy was trained for. Looks never touch the body, so a looks-only change keeps the brain; a body change
// (a leg length, the number of legs, a morph) does not, and the result text says which, so the model reports it truthfully.
// Portable: no Node API, no DOM API, no import (the cloud host bundles this file with the agent: see APP_FILES). The body's limits are those of 04-walks-home/tab/src/design.ts; a test holds them equal.

export interface Torso { length: number; width: number; height: number }
export interface LegPair { x: number; thigh: number; shin: number; radius: number }
/** The creature page's design document (04-walks-home/tab/src/design.ts), as the physics reads it. */
export interface Design { version: 1; name: string; torso: Torso; legs: LegPair[]; legDof?: 2 | 3 }

export const LIMITS = {
  torso: { length: [0.2, 0.9], width: [0.1, 0.5], height: [0.05, 0.3] },
  pairs: [2, 3],
  thigh: [0.08, 0.4],
  shin: [0.08, 0.4],
  radius: [0.012, 0.04],
} as const;

export const COLOR_NAMES = ["red", "orange", "yellow", "green", "blue", "purple", "pink", "white", "black", "gray", "brown"] as const;
export type ColorName = (typeof COLOR_NAMES)[number];
/** What the page paints with. */
export const COLOR_HEX: Readonly<Record<ColorName, string>> = { red: "#d9423b", orange: "#f08a24", yellow: "#f2cf3a", green: "#4caf62", blue: "#3b78d9", purple: "#8a56c8", pink: "#ee8fbe", white: "#f4f4ef", black: "#2a2a2c", gray: "#8d9199", brown: "#8a5a36" };
export const FACE_NAMES = ["happy", "sleepy", "surprised", "angry", "cool", "none"] as const;
export type FaceName = (typeof FACE_NAMES)[number];
export const SHAPE_NAMES = ["boxy", "round"] as const;
export type ShapeName = (typeof SHAPE_NAMES)[number];
export const COLOR_PARTS = ["torso", "legs", "front_legs", "back_legs", "all"] as const;
export const SHAPE_PARTS = ["torso", "legs"] as const;
export const RESIZE_PARTS = ["torso_length", "torso_width", "torso_height", "leg_length", "leg_thickness"] as const;
export const MORPH_PRESETS = ["dog", "spider", "giraffe", "lizard", "stubby", "original"] as const;
export const NAME_MAX = 24;
/** Every skill the cluster teaches (D2's eight); only the ones that came home (home/skills.json) can be chosen. */
export const SKILL_NAMES = ["walk", "sprint", "backwards", "turn-left", "turn-right", "spin", "wave", "get-up"] as const;
export const SKILL_CHANGED = "The body is unchanged: the walking brain still fits.";

export interface Look {
  /** The torso's colour; null keeps the page's own. */
  torso: ColorName | null;
  /** One colour per leg pair, in the design's order (front to back); null keeps the page's own. Three entries at most. */
  legs: (ColorName | null)[];
  shape: { torso: ShapeName; legs: ShapeName };
  face: FaceName;
}

export interface RobotState {
  version: 1;
  /** What the user calls the robot. */
  name: string;
  /** The body the user drew. */
  original: Design;
  /** The body now. */
  design: Design;
  look: Look;
  /** The skill the robot is doing (a policy from home/skills.json); absent: the default one. */
  skill?: string;
  /** How many changes the tools made since the drawing. */
  edits: number;
}

export type ToolKind = "looks" | "body" | "skill" | "none" | "refused";
/** What the tools need to know about the run beyond the state: the skills that came home, with their labels. */
export interface RobotContext { skills?: Readonly<Record<string, { label?: string; command?: number }>> }
export interface ToolOutcome { state: RobotState; text: string; kind: ToolKind }

export const LOOKS_ONLY = "Looks only: the walking brain still fits.";
export const BODY_CHANGED = "This changes the body: the walking brain no longer fits, so the robot will stumble until it is retrained.";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const m = (n: number) => `${n.toFixed(2)} m`;
const x = (f: number) => `x${r4(f)}`;
const inRange = (v: number, [lo, hi]: readonly [number, number] | readonly number[]) => Number.isFinite(v) && v >= lo! && v <= hi!;

/** The problems of a design (empty: buildable): the same rules as 04-walks-home/tab/src/design.ts. */
export function validateDesign(d: Design): string[] {
  const errs: string[] = [];
  if (d.version !== 1) errs.push(`version must be 1, got ${d.version}`);
  if (d.legDof !== undefined && d.legDof !== 2 && d.legDof !== 3) errs.push(`legDof must be 2 or 3, got ${d.legDof}`);
  for (const k of ["length", "width", "height"] as const) if (!inRange(d.torso[k], LIMITS.torso[k])) errs.push(`torso.${k} ${d.torso[k]} outside ${LIMITS.torso[k]}`);
  if (!Array.isArray(d.legs) || d.legs.length < LIMITS.pairs[0] || d.legs.length > LIMITS.pairs[1]) return [...errs, `legs must hold ${LIMITS.pairs[0]}..${LIMITS.pairs[1]} pairs`];
  d.legs.forEach((l, i) => {
    if (!inRange(l.x, [-1, 1])) errs.push(`legs[${i}].x ${l.x} outside -1..1`);
    for (const k of ["thigh", "shin", "radius"] as const) if (!inRange(l[k], LIMITS[k])) errs.push(`legs[${i}].${k} ${l[k]} outside ${LIMITS[k]}`);
  });
  return errs;
}

/** The body, as the policy knows it: every dimension the physics reads, never the name. Two designs with the same key build the same creature. */
export const bodyKey = (d: Design): string => JSON.stringify({ legDof: d.legDof === 3 ? 3 : 2, torso: d.torso, legs: d.legs.map((l) => [l.x, l.thigh, l.shin, l.radius]) });

export const defaultLook = (): Look => ({ torso: null, legs: [null, null, null], shape: { torso: "boxy", legs: "round" }, face: "none" });

/** The state a robot starts in: the body the user drew, no changes. */
export function initialRobot(drawn: Design, name?: string): RobotState {
  return { version: 1, name: name ?? drawn.name, original: clone(drawn), design: clone(drawn), look: defaultLook(), edits: 0 };
}

/** The presets `morph` offers: a body and the looks that go with it. "original" is the drawn body. */
const MORPHS: Record<Exclude<(typeof MORPH_PRESETS)[number], "original">, { design: Omit<Design, "name">; look: Partial<Look> }> = {
  dog: { design: { version: 1, legDof: 3, torso: { length: 0.55, width: 0.22, height: 0.11 }, legs: [{ x: 0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }, { x: -0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }] }, look: { torso: "brown", legs: ["brown", "brown", null], shape: { torso: "round", legs: "round" }, face: "happy" } },
  spider: { design: { version: 1, legDof: 3, torso: { length: 0.32, width: 0.3, height: 0.09 }, legs: [{ x: 0.8, thigh: 0.22, shin: 0.26, radius: 0.014 }, { x: 0, thigh: 0.22, shin: 0.26, radius: 0.014 }, { x: -0.8, thigh: 0.22, shin: 0.26, radius: 0.014 }] }, look: { torso: "black", legs: ["black", "black", "black"], shape: { torso: "round", legs: "round" }, face: "angry" } },
  giraffe: { design: { version: 1, legDof: 3, torso: { length: 0.45, width: 0.2, height: 0.09 }, legs: [{ x: 0.75, thigh: 0.34, shin: 0.34, radius: 0.018 }, { x: -0.75, thigh: 0.34, shin: 0.34, radius: 0.018 }] }, look: { torso: "yellow", legs: ["yellow", "yellow", null], shape: { torso: "round", legs: "round" }, face: "sleepy" } },
  lizard: { design: { version: 1, legDof: 3, torso: { length: 0.7, width: 0.18, height: 0.07 }, legs: [{ x: 0.8, thigh: 0.12, shin: 0.14, radius: 0.016 }, { x: -0.8, thigh: 0.12, shin: 0.14, radius: 0.016 }] }, look: { torso: "green", legs: ["green", "green", null], shape: { torso: "round", legs: "round" }, face: "cool" } },
  stubby: { design: { version: 1, legDof: 3, torso: { length: 0.6, width: 0.3, height: 0.14 }, legs: [{ x: 0.7, thigh: 0.12, shin: 0.12, radius: 0.03 }, { x: -0.7, thigh: 0.12, shin: 0.12, radius: 0.03 }] }, look: { torso: "orange", legs: ["orange", "orange", null], shape: { torso: "boxy", legs: "boxy" }, face: "surprised" } },
};
export const morphDesign = (preset: Exclude<(typeof MORPH_PRESETS)[number], "original">): Design => ({ ...clone(MORPHS[preset].design), name: preset });

const same = (a: RobotState, b: RobotState) => bodyKey(a.design) === bodyKey(b.design);

const refuse = (state: RobotState, why: string): ToolOutcome => ({ state, text: `Not done: ${why}`, kind: "refused" });

const PART_WORDS: Record<(typeof COLOR_PARTS)[number], string> = { torso: "torso", legs: "legs", front_legs: "front legs", back_legs: "back legs", all: "whole robot" };

/** Apply one tool call to the robot's state. Pure: the state in is never changed; the outcome says what the model is told. Arguments are checked here as well as by the tool's schema. */
export function applyRobotTool(prev: RobotState, tool: string, args: Record<string, unknown>, context: RobotContext = {}): ToolOutcome {
  const state = clone(prev);
  const done = (kind: ToolKind, text: string): ToolOutcome => ({ state: { ...state, edits: state.edits + 1 }, text: `${text} ${kind === "looks" ? LOOKS_ONLY : kind === "body" ? BODY_CHANGED : ""}`.trim(), kind });
  // a reset, and a body change, drop the skill with the body it was taught on; a skill is chosen again with `do`
  switch (tool) {
    case "set_color": {
      const part = args.part, color = args.color;
      if (!COLOR_PARTS.includes(part as never)) return refuse(prev, `part must be one of ${COLOR_PARTS.join(", ")}.`);
      if (!COLOR_NAMES.includes(color as never)) return refuse(prev, `color must be one of ${COLOR_NAMES.join(", ")}.`);
      const c = color as ColorName;
      const n = state.design.legs.length;
      const front = [0], back = [n - 1];
      if (part === "torso" || part === "all") state.look.torso = c;
      if (part === "legs" || part === "all") state.look.legs = state.look.legs.map(() => c);
      if (part === "front_legs") for (const i of front) state.look.legs[i] = c;
      if (part === "back_legs") for (const i of back) state.look.legs[i] = c;
      return done("looks", `The ${PART_WORDS[part as (typeof COLOR_PARTS)[number]]} ${part === "all" ? "is" : part === "torso" ? "is" : "are"} now ${c}.`);
    }
    case "set_shape": {
      const part = args.part, shape = args.shape;
      if (!SHAPE_PARTS.includes(part as never)) return refuse(prev, `part must be one of ${SHAPE_PARTS.join(", ")}.`);
      if (!SHAPE_NAMES.includes(shape as never)) return refuse(prev, `shape must be one of ${SHAPE_NAMES.join(", ")}.`);
      state.look.shape[part as "torso" | "legs"] = shape as ShapeName;
      return done("looks", `The ${part} ${part === "torso" ? "is" : "are"} now ${shape}.`);
    }
    case "set_face": {
      if (!FACE_NAMES.includes(args.face as never)) return refuse(prev, `face must be one of ${FACE_NAMES.join(", ")}.`);
      state.look.face = args.face as FaceName;
      return done("looks", args.face === "none" ? "The face is gone." : `The face is now ${args.face}.`);
    }
    case "rename": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (name.length < 1 || name.length > NAME_MAX) return refuse(prev, `the name must be 1 to ${NAME_MAX} characters.`);
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(name)) return refuse(prev, "the name may not hold control characters.");
      state.name = name;
      return done("looks", `The robot is now called ${name}.`);
    }
    case "resize": {
      const part = args.part, factor = args.factor;
      if (!RESIZE_PARTS.includes(part as never)) return refuse(prev, `part must be one of ${RESIZE_PARTS.join(", ")}.`);
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0.5 || factor > 2) return refuse(prev, "factor must be a number from 0.5 to 2.");
      const d = state.design;
      const check = (label: string, value: number, [lo, hi]: readonly [number, number] | readonly number[], old: number): string | undefined => {
        const at = (limit: number) => (Math.abs(limit - old) < 1e-9 ? "where it already is" : `about ${x(r4(limit / old))}`);
        if (value > hi!) return `${label} would be ${m(value)}, the most allowed is ${m(hi!)} (${at(hi!)}).`;
        if (value < lo!) return `${label} would be ${m(value)}, the least allowed is ${m(lo!)} (${at(lo!)}).`;
        return undefined;
      };
      let result = "";
      if (part === "torso_length" || part === "torso_width" || part === "torso_height") {
        const key = part.slice("torso_".length) as keyof Torso;
        const value = r4(d.torso[key] * (factor as number));
        const problem = check(part, value, LIMITS.torso[key], d.torso[key]);
        if (problem) return refuse(prev, problem);
        d.torso[key] = value;
        result = `The ${part.replace("_", " ")} is now ${m(value)} (${x(factor as number)}).`;
      } else if (part === "leg_length") {
        for (const l of d.legs) {
          const thigh = r4(l.thigh * (factor as number)), shin = r4(l.shin * (factor as number));
          const problem = check("leg_length", thigh, LIMITS.thigh, l.thigh) ?? check("leg_length", shin, LIMITS.shin, l.shin);
          if (problem) return refuse(prev, problem);
        }
        for (const l of d.legs) { l.thigh = r4(l.thigh * (factor as number)); l.shin = r4(l.shin * (factor as number)); }
        result = `The legs are now ${m(d.legs[0]!.thigh + d.legs[0]!.shin)} long (${x(factor as number)}).`;
      } else {
        for (const l of d.legs) {
          const problem = check("leg_thickness", r4(l.radius * (factor as number)), LIMITS.radius, l.radius);
          if (problem) return refuse(prev, problem);
        }
        for (const l of d.legs) l.radius = r4(l.radius * (factor as number));
        result = `The legs are now ${m(d.legs[0]!.radius * 2)} thick (${x(factor as number)}).`;
      }
      if (same({ ...state }, prev)) return { state: prev, text: "No change: that factor leaves the body as it is.", kind: "none" };
      return done("body", result);
    }
    case "scale": {
      const factor = args.factor;
      if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0.5 || factor > 2) return refuse(prev, "factor must be a number from 0.5 to 2.");
      const d = state.design;
      // The whole robot, torso and legs together. A size the limits do not allow is not refused here: the robot grows (or shrinks) as far as they allow and the result says so, so "twice as big" always does something.
      const dims: [number, readonly number[]][] = [[d.torso.length, LIMITS.torso.length], [d.torso.width, LIMITS.torso.width], [d.torso.height, LIMITS.torso.height]];
      for (const l of d.legs) dims.push([l.thigh, LIMITS.thigh], [l.shin, LIMITS.shin], [l.radius, LIMITS.radius]);
      let reach = factor;
      for (const [v, [lo, hi]] of dims) reach = factor >= 1 ? Math.min(reach, hi! / v) : Math.max(reach, lo! / v);
      reach = factor >= 1 ? Math.floor(reach * 1000) / 1000 : Math.ceil(reach * 1000) / 1000; // never past a limit by rounding
      if ((factor > 1 && reach <= 1) || (factor < 1 && reach >= 1)) return refuse(prev, `the robot is already ${factor > 1 ? "as big" : "as small"} as the limits allow.`);
      if (factor === 1) return { state: prev, text: "No change: that factor leaves the body as it is.", kind: "none" };
      d.torso = { length: r4(d.torso.length * reach), width: r4(d.torso.width * reach), height: r4(d.torso.height * reach) };
      for (const l of d.legs) { l.thigh = r4(l.thigh * reach); l.shin = r4(l.shin * reach); l.radius = r4(l.radius * reach); }
      const clipped = Math.abs(reach - factor) > 1e-9;
      return done("body", clipped ? `The robot is now ${x(r4(reach))} the size, as ${factor > 1 ? "big" : "small"} as the limits allow (you asked for ${x(factor)}).` : `The robot is now ${x(factor)} the size.`);
    }
    case "set_legs": {
      const pairs = args.pairs;
      if (pairs !== 2 && pairs !== 3) return refuse(prev, "pairs must be 2 (four legs) or 3 (six legs).");
      const d = state.design;
      if (d.legs.length === pairs) return { state: prev, text: `No change: the robot already has ${pairs * 2} legs.`, kind: "none" };
      if (pairs === 3) {
        const avg = (k: "thigh" | "shin" | "radius") => r4(d.legs.reduce((s, l) => s + l[k], 0) / d.legs.length);
        d.legs = [d.legs[0]!, { x: 0, thigh: avg("thigh"), shin: avg("shin"), radius: avg("radius") }, d.legs[d.legs.length - 1]!];
        state.look.legs = [state.look.legs[0] ?? null, state.look.legs[0] ?? null, state.look.legs[1] ?? null];
      } else {
        d.legs = [d.legs[0]!, d.legs[d.legs.length - 1]!];
        state.look.legs = [state.look.legs[0] ?? null, state.look.legs[2] ?? null, null];
      }
      return done("body", `The robot now has ${pairs * 2} legs.`);
    }
    case "morph": {
      const preset = args.preset;
      if (!MORPH_PRESETS.includes(preset as never)) return refuse(prev, `preset must be one of ${MORPH_PRESETS.join(", ")}.`);
      if (preset === "original") {
        state.design = clone(state.original);
        state.look = defaultLook();
        state.name = state.original.name;
        if (same({ ...state }, prev) && JSON.stringify(state.look) === JSON.stringify(prev.look)) return { state: prev, text: "No change: the robot is already the one the user drew.", kind: "none" };
        return done("body", "The robot is the one the user drew again.");
      }
      const target = MORPHS[preset as Exclude<(typeof MORPH_PRESETS)[number], "original">];
      state.design = { ...clone(target.design), name: state.design.name } as Design;
      state.look = { ...defaultLook(), ...clone(target.look) } as Look;
      return done("body", `The robot is now a ${preset}.`);
    }
    case "do": {
      const skill = args.skill;
      const have = Object.keys(context.skills ?? {});
      if (typeof skill !== "string" || !SKILL_NAMES.includes(skill as never)) return refuse(prev, `skill must be one of ${SKILL_NAMES.join(", ")}.`);
      if (have.length === 0) return refuse(prev, "no skill has come home yet: the robot can only do what its brain was taught.");
      if (!have.includes(skill)) return refuse(prev, `the robot has not learned ${skill}; it can do ${have.join(", ")}.`);
      if ((prev.skill ?? "walk") === skill && prev.skill !== undefined) return { state: prev, text: `No change: the robot is already doing ${skill}.`, kind: "none" };
      state.skill = skill;
      const label = context.skills?.[skill]?.label;
      return done("skill", `The robot is now doing ${skill}${label && label !== skill ? ` (${label})` : ""}. ${SKILL_CHANGED}`);
    }
    case "reset": {
      state.design = clone(state.original);
      state.look = defaultLook();
      state.name = state.original.name;
      delete state.skill;
      return { state: { ...state, edits: 0 }, text: `Everything is back to the robot the user drew. ${same(state, prev) ? LOOKS_ONLY : BODY_CHANGED}`, kind: same(state, prev) ? "looks" : "body" };
    }
    default:
      return refuse(prev, `there is no tool ${JSON.stringify(tool)}.`);
  }
}

/** Parse creature/robot.json; undefined when it is not a state this module wrote (the page then ignores it). */
export function parseRobot(text: string): RobotState | undefined {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return undefined; }
  const s = v as Partial<RobotState> | null;
  if (!s || typeof s !== "object" || s.version !== 1 || typeof s.name !== "string" || !s.design || !s.original || !s.look || !Array.isArray(s.look.legs)) return undefined;
  if (validateDesign(s.design).length > 0 || validateDesign(s.original).length > 0) return undefined;
  if (s.skill !== undefined && typeof s.skill !== "string") return undefined;
  return s as RobotState;
}

export const serializeRobot = (s: RobotState): string => `${JSON.stringify(s, null, 1)}\n`;

export const UPDATE_KEYS = ["reset", "morph", "scale", "legs", "color", "part", "face", "name", "skill"] as const;

/**
 * The flat form of the same edits (`update_robot`): one call with any of reset, morph, scale, legs, color (and the part it paints, "all" when absent), face and name, applied in a fixed order (reset, morph,
 * scale, legs, color, face, name) so a combined ask ("a red spider") is one call. Each step is `applyRobotTool`'s own, so the state edits and their results are the nine tools'. A step the limits refuse is
 * reported and the others still apply; the call is refused only when nothing applied and something was refused. `legs` is the number of pairs (2 or 3) or of legs (4 or 6).
 */
export function applyUpdateRobot(prev: RobotState, args: Record<string, unknown>, context: RobotContext = {}): ToolOutcome {
  const unknown = Object.keys(args).filter((k) => !(UPDATE_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return refuse(prev, `unknown ${unknown.length === 1 ? "field" : "fields"} ${unknown.map((k) => JSON.stringify(k)).join(", ")}; the fields are ${UPDATE_KEYS.join(", ")}.`);
  const steps: [string, Record<string, unknown>][] = [];
  if (args.reset === true) steps.push(["reset", {}]);
  if (args.morph !== undefined) steps.push(["morph", { preset: args.morph }]);
  if (args.scale !== undefined) steps.push(["scale", { factor: args.scale }]);
  if (args.legs !== undefined) steps.push(["set_legs", { pairs: args.legs === 4 ? 2 : args.legs === 6 ? 3 : args.legs }]);
  if (args.color !== undefined) steps.push(["set_color", { part: args.part ?? "all", color: args.color }]);
  else if (args.part !== undefined) return refuse(prev, "part needs a color to paint it.");
  if (args.face !== undefined) steps.push(["set_face", { face: args.face }]);
  if (args.name !== undefined) steps.push(["rename", { name: args.name }]);
  if (args.skill !== undefined) steps.push(["do", { skill: args.skill }]);
  if (steps.length === 0) return refuse(prev, `say what to change: ${UPDATE_KEYS.filter((k) => k !== "part").join(", ")}.`);
  let state = prev;
  const lines: string[] = [];
  let kind: ToolKind = "none", applied = 0, refused = 0;
  for (const [tool, a] of steps) {
    const o = applyRobotTool(state, tool, a, context);
    if (o.kind === "refused") { refused++; lines.push(o.text); continue; }
    if (o.kind === "body" || (o.kind === "looks" && kind !== "body") || (o.kind === "skill" && kind === "none")) kind = o.kind;
    if (o.kind !== "none") applied++;
    state = o.state;
    lines.push(o.text.replace(` ${LOOKS_ONLY}`, "").replace(` ${BODY_CHANGED}`, "").replace(` ${SKILL_CHANGED}`, ""));
  }
  if (applied === 0 && refused > 0) return { state: prev, text: lines.join(" "), kind: "refused" };
  if (applied === 0) return { state: prev, text: lines.join(" "), kind: "none" };
  const tail = kind === "body" ? BODY_CHANGED : kind === "skill" ? SKILL_CHANGED : LOOKS_ONLY;
  return { state: { ...state, edits: prev.edits + 1 }, text: `${lines.join(" ")} ${tail}`, kind };
}
