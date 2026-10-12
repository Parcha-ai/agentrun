// The robot's tools: nine small pi tools that edit ONE file in the workspace, creature/robot.json (robot-model.ts holds what each does). They take no path and every argument is an enum or a bounded number,
// so a small local model cannot get a file name or a unit wrong; the creature page watches the file and redraws. The result text says whether the walking brain still fits (looks only) or no longer does
// (a body change), so the model can tell the user the truth. Every host registers them in the same place (agent.ts); a host with no computer refuses. Portable: no Node API.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { COLOR_NAMES, COLOR_PARTS, FACE_NAMES, MORPH_PRESETS, NAME_MAX, RESIZE_PARTS, SHAPE_NAMES, SHAPE_PARTS, SKILL_NAMES, applyRobotTool, applyUpdateRobot, initialRobot, parseRobot, serializeRobot, validateDesign, type Design, type RobotContext, type RobotState } from "./robot-model.ts";

/** The robot's state file, and the design the creature page publishes when it saves the user's drawing (what `reset` returns to). Relative to the workspace. */
export const ROBOT_FILE = "creature/robot.json";
export const DESIGN_FILE = "creature/design.json";
/** The skills that came home (D2's format): `{version: 1, default, skills: {<name>: {policy, command, label}}}`; a run with only home/policy.json has the one skill, walk. */
export const SKILLS_FILE = "home/skills.json";
export const POLICY_FILE = "home/policy.json";

/** The nine tools' names, in the order they are registered and offered. */
export const ROBOT_TOOLS = ["set_color", "set_shape", "set_face", "rename", "resize", "scale", "set_legs", "morph", "reset", "do", "update_robot"] as const;

/** The creature page's own default body, for a robot whose drawing was never published (04-walks-home/tab/src/design.ts `defaultDesign`). */
const DRAWN_DEFAULT: Design = { version: 1, name: "quadruped", legDof: 3, torso: { length: 0.5, width: 0.22, height: 0.1 }, legs: [{ x: 0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }, { x: -0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }] };

const text = (t: string, isError = false) => ({ ...(isError ? { isError: true as const } : {}), content: [{ type: "text" as const, text: t }] });

const oneOf = <T extends string>(values: readonly T[], description: string) => Type.Unsafe<T>({ type: "string", enum: [...values], description });

type Env = NonNullable<Parameters<Parameters<typeof defineTool>[0]["execute"]>[1]["env"]>;
type Ctx = Parameters<Env["readTextFile"]>[1];

async function load(env: Env, context: Ctx): Promise<RobotState | { problem: string }> {
  const have = await env.readTextFile(ROBOT_FILE, context);
  if (have.ok) {
    const state = parseRobot(have.value);
    return state ?? { problem: `${ROBOT_FILE} is not a robot state this tool can read` };
  }
  if (have.error.code !== "not_found") return { problem: `${ROBOT_FILE} could not be read: ${have.error.message}` };
  // the first edit: the robot starts as the body the user drew (the page publishes it as creature/design.json), else the default body
  const drawn = await env.readTextFile(DESIGN_FILE, context);
  if (drawn.ok) {
    try {
      const design = JSON.parse(drawn.value) as Design;
      if (validateDesign(design).length === 0) return initialRobot(design);
    } catch {
      // a design file that is not JSON: the default body
    }
  }
  return initialRobot(DRAWN_DEFAULT);
}

/** The skills this robot has: from home/skills.json, else walk when a single policy came home, else none. */
export async function loadSkills(env: Env, context: Ctx): Promise<Record<string, { label?: string; command?: number }>> {
  const have = await env.readTextFile(SKILLS_FILE, context);
  if (have.ok) {
    try {
      const m = JSON.parse(have.value) as { skills?: Record<string, { label?: unknown; command?: unknown }> };
      const out: Record<string, { label?: string; command?: number }> = {};
      for (const [name, v] of Object.entries(m.skills ?? {})) if ((SKILL_NAMES as readonly string[]).includes(name)) out[name] = { ...(typeof v?.label === "string" ? { label: v.label } : {}), ...(typeof v?.command === "number" ? { command: v.command } : {}) };
      return out;
    } catch {
      return {};
    }
  }
  const single = await env.readTextFile(POLICY_FILE, context);
  return single.ok ? { walk: { label: "walk" } } : {};
}

/** A tool registration whose `skill` enum names only these skills: what the small local model is offered (the registry's own enum is the whole list, so every host agrees). */
export function narrowSkills<T extends { parameters: unknown }>(tool: T, skills: readonly string[]): T {
  const schema = JSON.parse(JSON.stringify(tool.parameters)) as { properties?: Record<string, { enum?: unknown[] }> };
  const prop = schema.properties?.skill;
  if (prop?.enum) prop.enum = prop.enum.filter((n) => skills.includes(String(n)));
  return { ...tool, parameters: schema };
}

async function edit(env: Env | undefined, context: Ctx, tool: string, args: Record<string, unknown>) {
  const apply = async (state: RobotState) => {
    const skills = tool === "do" || (tool === "update_robot" && args.skill !== undefined) ? await loadSkills(env!, context) : {};
    return tool === "update_robot" ? applyUpdateRobot(state, args, { skills }) : applyRobotTool(state, tool, args, { skills });
  };
  if (!env) return text("Not done: there is no computer to keep the robot's file on.", true);
  const state = await load(env, context);
  if ("problem" in state) return text(`Not done: ${state.problem}.`, true);
  const outcome = await apply(state);
  if (outcome.kind === "refused") return { ...text(outcome.text, true), details: { kind: outcome.kind } };
  if (outcome.kind !== "none") {
    const made = await env.createDir("creature", { recursive: true }, context);
    if (!made.ok && made.error.code !== "invalid") return text(`Not done: the robot's folder could not be made: ${made.error.message}.`, true);
    const wrote = await env.writeFile(ROBOT_FILE, serializeRobot(outcome.state), context);
    if (!wrote.ok) return text(`Not done: the robot's file could not be written: ${wrote.error.message}.`, true);
  }
  return { ...text(outcome.text), details: { kind: outcome.kind } };
}

/** The nine tools and the flat `update_robot` that does the same edits in one call (the two shapes plug onto the same state), as one extension. */
export function robotTools(): Extension {
  const factor = Type.Number({ minimum: 0.5, maximum: 2, description: "1 is no change, 2 is twice, 0.5 is half." });
  return defineExtension({
    name: "robot-tools",
    tools: [
      defineTool({
        name: "set_color",
        description: "Paint a part of the robot a colour. Looks only: the walking brain still fits.",
        parameters: Type.Object({ part: oneOf(COLOR_PARTS, "Which part: the torso, all the legs, the front legs, the back legs, or the whole robot."), color: oneOf(COLOR_NAMES, "The colour.") }),
        execute: (args, api, context) => edit(api.env, context, "set_color", args),
      }),
      defineTool({
        name: "set_shape",
        description: "Make the torso or the legs boxy or round. Looks only: the walking brain still fits.",
        parameters: Type.Object({ part: oneOf(SHAPE_PARTS, "Which part."), shape: oneOf(SHAPE_NAMES, "The shape.") }),
        execute: (args, api, context) => edit(api.env, context, "set_shape", args),
      }),
      defineTool({
        name: "set_face",
        description: "Give the robot a face. Looks only: the walking brain still fits.",
        parameters: Type.Object({ face: oneOf(FACE_NAMES, "The face; none removes it.") }),
        execute: (args, api, context) => edit(api.env, context, "set_face", args),
      }),
      defineTool({
        name: "rename",
        description: "Give the robot a new name. Looks only: the walking brain still fits.",
        parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: NAME_MAX, description: `The new name, 1 to ${NAME_MAX} characters.` }) }),
        execute: (args, api, context) => edit(api.env, context, "rename", args),
      }),
      defineTool({
        name: "resize",
        description: "Make one part of the body longer, shorter, wider or thicker by a factor. This changes the body: the walking brain no longer fits. A size past a limit is refused with the limit.",
        parameters: Type.Object({ part: oneOf(RESIZE_PARTS, "Which dimension."), factor }),
        execute: (args, api, context) => edit(api.env, context, "resize", args),
      }),
      defineTool({
        name: "scale",
        description: "Make the whole robot bigger or smaller by a factor, as far as the limits allow. This changes the body: the walking brain no longer fits.",
        parameters: Type.Object({ factor }),
        execute: (args, api, context) => edit(api.env, context, "scale", args),
      }),
      defineTool({
        name: "set_legs",
        description: "Give the robot 2 pairs of legs (four legs) or 3 pairs (six legs). This changes the body: the walking brain no longer fits.",
        parameters: Type.Object({ pairs: Type.Unsafe<2 | 3>({ type: "integer", enum: [2, 3], description: "2 for four legs, 3 for six legs." }) }),
        execute: (args, api, context) => edit(api.env, context, "set_legs", args),
      }),
      defineTool({
        name: "morph",
        description: "Turn the robot into an animal: a preset sets the body and the looks together (original is the robot the user drew). This changes the body: the walking brain no longer fits.",
        parameters: Type.Object({ preset: oneOf(MORPH_PRESETS, "Which animal.") }),
        execute: (args, api, context) => edit(api.env, context, "morph", args),
      }),
      defineTool({
        name: "reset",
        description: "Undo every change made with these tools: the looks and the body go back to the robot the user drew.",
        parameters: Type.Object({}),
        execute: (_args, api, context) => edit(api.env, context, "reset", {}),
      }),
      defineTool({
        name: "do",
        description: "Make the robot do one of the skills it has learned (walk, sprint, backwards, turn-left, turn-right, spin, rear-up, getup, jump). A skill it has not learned is refused. The body is unchanged: the walking brain still fits.",
        parameters: Type.Object({ skill: oneOf(SKILL_NAMES, "Which skill.") }),
        execute: (args, api, context) => edit(api.env, context, "do", args),
      }),
      defineTool({
        name: "update_robot",
        description: "Change the robot in one call: any of reset, morph, scale, legs, color (with the part it paints), face and name, applied in that order. A body change means the walking brain no longer fits.",
        parameters: Type.Object({
          reset: Type.Optional(Type.Boolean({ description: "Undo every change first." })),
          morph: Type.Optional(oneOf(MORPH_PRESETS, "Turn into this animal first.")),
          scale: Type.Optional(factor),
          legs: Type.Optional(Type.Unsafe<2 | 3 | 4 | 6>({ type: "integer", enum: [2, 3, 4, 6], description: "How many pairs of legs (2 or 3) or legs (4 or 6)." })),
          color: Type.Optional(oneOf(COLOR_NAMES, "The colour.")),
          part: Type.Optional(oneOf(COLOR_PARTS, "The part to paint; the whole robot when absent.")),
          face: Type.Optional(oneOf(FACE_NAMES, "The face; none removes it.")),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: NAME_MAX, description: `The new name, 1 to ${NAME_MAX} characters.` })),
          skill: Type.Optional(oneOf(SKILL_NAMES, "A skill the robot has learned, done last.")),
        }),
        execute: (args, api, context) => edit(api.env, context, "update_robot", args as Record<string, unknown>),
      }),
    ],
  });
}
