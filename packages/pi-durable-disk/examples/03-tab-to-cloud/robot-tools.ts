// The robot's tools: nine small pi tools that edit ONE file in the workspace, creature/robot.json (robot-model.ts holds what each does). They take no path and every argument is an enum or a bounded number,
// so a small local model cannot get a file name or a unit wrong; the creature page watches the file and redraws. The result text says whether the walking brain still fits (looks only) or no longer does
// (a body change), so the model can tell the user the truth. Every host registers them in the same place (agent.ts); a host with no computer refuses. Portable: no Node API.
import { configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { buildRobot } from "./build-robot.ts";
import { BRAIN_PROVIDER } from "./providers.ts";
import { CANCELLED, FLAG_SKILLS, FLAG_WAIT, NO_REPORT, readScene, runText, tryText, waitForAttempt } from "./flag-goal.ts";
import { COLOR_NAMES, FACE_NAMES, LOOK_PARTS, type CodeBody, MORPH_PRESETS, NAME_MAX, RESIZE_PARTS, SHAPE_NAMES, SHAPE_PARTS, SKILL_NAMES, applyRobotTool, applyUpdateRobot, initialRobot, parseRobot, serializeRobot, validateDesign, type Design, type RobotContext, type RobotState } from "./robot-model.ts";

/** The robot's state file, and the design the creature page publishes when it saves the user's drawing (what `reset` returns to). Relative to the workspace. */
export const ROBOT_FILE = "creature/robot.json";
export const DESIGN_FILE = "creature/design.json";
/** The skills that came home (D2's format): `{version: 1, default, skills: {<name>: {policy, command, label}}}`; a run with only home/policy.json has the one skill, walk. */
export const SKILLS_FILE = "home/skills.json";
export const POLICY_FILE = "home/policy.json";

/** The nine tools' names, in the order they are registered and offered. */
export const ROBOT_TOOLS = ["set_color", "set_shape", "set_face", "rename", "resize", "scale", "set_legs", "morph", "reset", "do", "build_robot", "update_robot"] as const;
/** A body the agent wrote as code: the files its build leaves in the workspace, and the page's report. */
export const BODY_FILE = "robot/body.json";
export const BODY_XML = "robot/body.xml";
export const BUILD_FILE = "robot/build.json";

/** The creature page's own default body, for a robot whose drawing was never published (04-walks-home/tab/src/design.ts `defaultDesign`). */
const DRAWN_DEFAULT: Design = { version: 1, name: "quadruped", legDof: 3, torso: { length: 0.5, width: 0.22, height: 0.1 }, legs: [{ x: 0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }, { x: -0.8, thigh: 0.2, shin: 0.2, radius: 0.02 }] };

const text = (t: string, isError = false) => ({ ...(isError ? { isError: true as const } : {}), content: [{ type: "text" as const, text: t }] });

const oneOf = <T extends string>(values: readonly T[], description: string) => Type.Unsafe<T>({ type: "string", enum: [...values], description });

type Env = NonNullable<Parameters<Parameters<typeof defineTool>[0]["execute"]>[1]["env"]>;
type Ctx = Parameters<Env["readTextFile"]>[1];
type ToolApi = Parameters<Parameters<typeof defineTool>[0]["execute"]>[1];

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

/** The robot as a body written as code (robot/body.json, written by `node robot/build.mjs`), or none: the name, the tags it has, how many legs. */
export async function loadCodeBody(env: Env, context: Ctx): Promise<CodeBody | undefined> {
  const have = await env.readTextFile(BODY_FILE, context);
  if (!have.ok) return undefined;
  try {
    const b = JSON.parse(have.value) as { name?: unknown; tag_list?: unknown; legs?: unknown; tags?: unknown; colors?: unknown };
    if (typeof b.name !== "string" || !Array.isArray(b.tag_list)) return undefined;
    const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
    const tags = record(b.tags), colors = record(b.colors);
    return {
      name: b.name, tags: b.tag_list.filter((t): t is string => typeof t === "string"), legs: typeof b.legs === "number" ? b.legs : 0,
      ...(tags ? { pieceTags: Object.fromEntries(Object.entries(tags).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((t): t is string => typeof t === "string")])) } : {}),
      ...(colors ? { pieceColors: Object.fromEntries(Object.entries(colors).filter(([, v]) => typeof v === "string") as [string, string][]) } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The tools that change a preset body: with a body written as code the agent changes its body by writing the file, so these are not offered to it. */
export const SHAPE_TOOLS: readonly string[] = ["resize", "scale", "set_legs", "morph"];

/**
 * On a body written as code the shape tools follow the model that drives the conversation, in both directions. The
 * cloud agent changes the body by writing its file, so they are not offered to it. The browser's own model can only call
 * tools, and its prompt names them, so they stay offered and answer CODE_BODY_REFUSAL. Reconciled at every robot call on
 * a code body, committed from inside the call, so the next request lists the right ones. A model switch configures the
 * same: cloudAgent removes them, and the browser's model's agent lists its prompt's tools.
 */
async function shapeToolsForDriver(api: ToolApi, context: Ctx): Promise<void> {
  const agent = await api.agent(context as never);
  // The shape tools as this conversation's registry has them: its robot-tools extension stays selected when they are removed.
  const shapeTools: readonly ToolRegistration[] = agent.extensions.flatMap((e) => e.tools ?? []).filter((t) => SHAPE_TOOLS.includes(t.name));
  const present = agent.tools.filter((t) => SHAPE_TOOLS.includes(t.name));
  if (agent.model?.provider !== BRAIN_PROVIDER) {
    if (present.length > 0) await api.commit((tx) => configure(tx, api.conversationId, { tools: { remove: present } }), context as never);
    return;
  }
  const missing = shapeTools.filter((t) => !present.some((p) => p.name === t.name));
  if (missing.length > 0) await api.commit((tx) => configure(tx, api.conversationId, { tools: [...agent.tools, ...missing] }), context as never);
}

/** The robot as it is now: its file, or the body the user drew before the first edit (what a tool would start from). */
export async function currentRobot(env: Env, context: Ctx): Promise<RobotState | { problem: string }> {
  return load(env, context);
}

/** Whether a skill was taught for the body now in robot/body.xml: its policy file's mjcf_sha256 against the xml's sha256 (the page's own test, Policy.load). Undefined when either file cannot be read. */
async function fitsBody(env: Env, context: Ctx, policy: string | undefined, skill: string): Promise<Record<string, boolean> | undefined> {
  const xml = await env.readTextFile(BODY_XML, context);
  const file = await env.readTextFile(`home/${policy ?? `skills/${skill}.json`}`, context);
  if (!xml.ok || !file.ok) return undefined;
  try {
    const taught = (JSON.parse(file.value) as { mjcf_sha256?: unknown }).mjcf_sha256;
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(xml.value)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { [skill]: typeof taught === "string" && taught === sha };
  } catch {
    return undefined;
  }
}

/** The skills this robot has: from home/skills.json, else walk when a single policy came home, else none. */
export async function loadSkills(env: Env, context: Ctx): Promise<Record<string, { label?: string; command?: number; policy?: string }>> {
  const have = await env.readTextFile(SKILLS_FILE, context);
  if (have.ok) {
    try {
      const m = JSON.parse(have.value) as { skills?: Record<string, { label?: unknown; command?: unknown; policy?: unknown }> };
      const out: Record<string, { label?: string; command?: number; policy?: string }> = {};
      for (const [name, v] of Object.entries(m.skills ?? {})) if (/^[\w-]{1,40}$/.test(name)) out[name] = { ...(typeof v?.label === "string" ? { label: v.label } : {}), ...(typeof v?.command === "number" ? { command: v.command } : {}), ...(typeof v?.policy === "string" ? { policy: v.policy } : {}) };
      return out;
    } catch {
      return {};
    }
  }
  const single = await env.readTextFile(POLICY_FILE, context);
  return single.ok ? { walk: { label: "walk" } } : {};
}

/**
 * The skill the robot plays when none is chosen, as the page picks it (04's parseSkills): the manifest's `default` when it names one of its skills, else its
 * first skill; walk when only home/policy.json came home; none when no skill did.
 */
export async function defaultSkill(env: Env, context: Ctx): Promise<string | undefined> {
  const have = await env.readTextFile(SKILLS_FILE, context);
  if (have.ok) {
    try {
      const m = JSON.parse(have.value) as { default?: unknown; skills?: Record<string, unknown> };
      const names = m.skills && typeof m.skills === "object" && !Array.isArray(m.skills) ? Object.keys(m.skills) : [];
      return typeof m.default === "string" && names.includes(m.default) ? m.default : names[0];
    } catch {
      return undefined;
    }
  }
  return (await env.readTextFile(POLICY_FILE, context)).ok ? "walk" : undefined;
}

/** One edit at a time per computer: pi runs the calls of one model turn together ("a red spider" is two), and each edit is read-modify-write on the same file, so the later write would drop the earlier one. */
const lines = new WeakMap<object, Promise<unknown>>();
function queued<T>(env: object | undefined, run: () => Promise<T>): Promise<T> {
  if (!env) return run();
  const next = (lines.get(env) ?? Promise.resolve()).then(run);
  lines.set(env, next.catch(() => undefined));
  return next;
}
function edit(api: ToolApi, context: Ctx, tool: string, args: Record<string, unknown>, attempt?: RobotState["attempt"]) {
  return queued(api.env, () => editNow(api, context, tool, args, attempt));
}

async function editNow(api: ToolApi, context: Ctx, tool: string, args: Record<string, unknown>, attempt?: RobotState["attempt"]) {
  const env = api.env;
  if (!env) return text("Not done: there is no computer to keep the robot's file on.", true);
  const body = await loadCodeBody(env, context);
  if (body) await shapeToolsForDriver(api, context);
  const apply = async (state: RobotState) => {
    const skills = tool === "do" || (tool === "update_robot" && args.skill !== undefined) ? await loadSkills(env!, context) : {};
    const skillFits = body && skills && typeof args.skill === "string" && skills[args.skill] ? await fitsBody(env!, context, skills[args.skill]!.policy, args.skill) : undefined;
    return tool === "update_robot" ? applyUpdateRobot(state, args, { skills, ...(skillFits ? { skillFits } : {}), ...(body ? { body } : {}) }) : applyRobotTool(state, tool, args, { skills, ...(skillFits ? { skillFits } : {}), ...(body ? { body } : {}) });
  };
  const loaded = await load(env, context);
  if ("problem" in loaded) return text(`Not done: ${loaded.problem}.`, true);
  const state = body && loaded.edits === 0 ? { ...loaded, name: body.name } : loaded; // a body written as code starts out with the name its file gave it
  const outcome = await apply(state);
  if (outcome.kind === "refused") return { ...text(outcome.text, true), details: { kind: outcome.kind } };
  if (outcome.kind !== "none") {
    const made = await env.createDir("creature", { recursive: true }, context);
    if (!made.ok && made.error.code !== "invalid") return text(`Not done: the robot's folder could not be made: ${made.error.message}.`, true);
    const wrote = await env.writeFile(ROBOT_FILE, serializeRobot(attempt ? { ...outcome.state, attempt } : outcome.state), context);
    if (!wrote.ok) return text(`Not done: the robot's file could not be written: ${wrote.error.message}.`, true);
  }
  return { ...text(outcome.text), details: { kind: outcome.kind } };
}

/**
 * `do` with a place and a goal (flag-goal.ts, D0's page): with a flag in the scene, `do walk` or `do sprint` is one
 * measured request, written with this call's id. A skill that has come home starts as always, the page sets the robot
 * back at the start and reports the run (at the flag, a fall, when it stops closing on the flag, or at 15 s), and the
 * answer carries that report. One that has not come home is tried with the page's untrained brain instead of refused,
 * and fails where everyone can see it. The browser's own model starts the same run, and its turn does not wait for the
 * report (it is locked to the skills home, so it never asks for a try). Other skills, or no flag: `do` as it always was.
 */
async function doSkill(api: ToolApi, context: Ctx, args: Record<string, unknown>) {
  const env = api.env;
  const skill = typeof args.skill === "string" ? args.skill : undefined;
  if (!env || !skill || !FLAG_SKILLS.includes(skill) || !(await readScene(env as never, context as never))) return edit(api, context, "do", args);
  const learned = (await loadSkills(env, context))[skill] !== undefined;
  const brain = (await api.agent(context as never)).model?.provider === BRAIN_PROVIDER;
  const attempt = { id: api.callId, skill, learned };
  const signal = (context as { abortSignal?: AbortSignal }).abortSignal;
  const wait = (timeoutMs: number) => waitForAttempt(env as never, context as never, attempt.id, { timeoutMs, ...(signal ? { signal } : {}) });
  if (learned) {
    const started = await edit(api, context, "do", args, attempt);
    if ((started as { isError?: boolean }).isError || brain) return started;
    const report = await wait(FLAG_WAIT.runMs);
    const said = started.content.map((c) => c.text).join("");
    const how = report === "cancelled" ? CANCELLED : report ? runText(report) : NO_REPORT;
    return { ...text(`${said} ${how}`), details: { kind: "skill", ...(typeof report === "object" ? { attempt: report } : {}) } };
  }
  if (brain) return edit(api, context, "do", args);
  // The untrained try: the request alone (the skill the robot is doing stays as it was), written in turn with the other edits of this turn.
  const problem = await queued(env, async () => {
    const loaded = await load(env, context);
    if ("problem" in loaded) return `Not done: ${loaded.problem}.`;
    const made = await env.createDir("creature", { recursive: true }, context);
    if (!made.ok && made.error.code !== "invalid") return `Not done: the robot's folder could not be made: ${made.error.message}.`;
    const wrote = await env.writeFile(ROBOT_FILE, serializeRobot({ ...loaded, attempt }), context);
    return wrote.ok ? undefined : `Not done: the robot's file could not be written: ${wrote.error.message}.`;
  });
  if (problem) return text(problem, true);
  const report = await wait(FLAG_WAIT.tryMs);
  const said = typeof report === "object" ? tryText(report) : `Not learned yet: the robot was asked to try ${skill}. ${report === "cancelled" ? CANCELLED : NO_REPORT}`;
  return { ...text(said), details: { kind: "try", ...(typeof report === "object" ? { attempt: report } : {}) } };
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
        parameters: Type.Object({ part: oneOf(LOOK_PARTS, "Which part, by its tag (torso, head, neck, tail, legs, front_legs, back_legs, arms, wings, eyes, jaw, belly, plates, horns, spikes, decoration), or all for the whole robot. A part the robot does not have is refused."), color: oneOf(COLOR_NAMES, "The colour.") }),
        execute: (args, api, context) => edit(api, context, "set_color", args),
      }),
      defineTool({
        name: "set_shape",
        description: "Make the torso or the legs boxy or round. Looks only: the walking brain still fits.",
        parameters: Type.Object({ part: oneOf(LOOK_PARTS, "Which part, by its tag, or all. On a robot built from the preset bodies only torso and legs can be reshaped."), shape: oneOf(SHAPE_NAMES, "The shape.") }),
        execute: (args, api, context) => edit(api, context, "set_shape", args),
      }),
      defineTool({
        name: "set_face",
        description: "Give the robot a face. Looks only: the walking brain still fits.",
        parameters: Type.Object({ face: oneOf(FACE_NAMES, "The face; none removes it.") }),
        execute: (args, api, context) => edit(api, context, "set_face", args),
      }),
      defineTool({
        name: "rename",
        description: "Give the robot a new name. Looks only: the walking brain still fits.",
        parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: NAME_MAX, description: `The new name, 1 to ${NAME_MAX} characters.` }) }),
        execute: (args, api, context) => edit(api, context, "rename", args),
      }),
      defineTool({
        name: "resize",
        description: "Make one part of the body longer, shorter, wider or thicker by a factor. This changes the body: the walking brain no longer fits. A size past a limit is refused with the limit.",
        parameters: Type.Object({ part: oneOf(RESIZE_PARTS, "Which dimension."), factor }),
        execute: (args, api, context) => edit(api, context, "resize", args),
      }),
      defineTool({
        name: "scale",
        description: "Make the whole robot bigger or smaller by a factor, as far as the limits allow. This changes the body: the walking brain no longer fits.",
        parameters: Type.Object({ factor }),
        execute: (args, api, context) => edit(api, context, "scale", args),
      }),
      defineTool({
        name: "set_legs",
        description: "Give the robot 2 pairs of legs (four legs) or 3 pairs (six legs). This changes the body: the walking brain no longer fits.",
        parameters: Type.Object({ pairs: Type.Unsafe<2 | 3>({ type: "integer", enum: [2, 3], description: "2 for four legs, 3 for six legs." }) }),
        execute: (args, api, context) => edit(api, context, "set_legs", args),
      }),
      defineTool({
        name: "morph",
        description: "Turn the robot into an animal: a preset sets the body and the looks together (original is the robot the user drew). This changes the body: the walking brain no longer fits.",
        parameters: Type.Object({ preset: oneOf(MORPH_PRESETS, "Which animal.") }),
        execute: (args, api, context) => edit(api, context, "morph", args),
      }),
      defineTool({
        name: "reset",
        description: "Undo every change made with these tools: the looks and the body go back to the robot the user drew.",
        parameters: Type.Object({}),
        execute: (_args, api, context) => edit(api, context, "reset", {}),
      }),
      defineTool({
        name: "do",
        description: "Make the robot do one of the skills it has learned (walk, sprint, backwards, turn-left, turn-right, spin, wave, get-up). The body is unchanged: the walking brain still fits. With a flag in the scene, walk or sprint not learned yet makes it try (an untrained attempt that fails) instead of being refused, and the answer says how far it got and whether it reached the flag; any other skill it has not learned is refused.",
        parameters: Type.Object({ skill: Type.String({ pattern: "^[\\w-]{1,40}$", description: "Which skill: the name of one it has learned (the ones in home/skills.json; the usual ones are walk, sprint, backwards, turn-left, turn-right, spin, wave, get-up)." }) }),
        execute: (args, api, context) => doSkill(api, context, args),
      }),
      defineTool({
        name: "build_robot",
        description: "Check the robot you built: put the helper files in robot/ if they are missing, then report what the creature page made of robot/body.xml (compiled in MuJoCo, held at its standing pose for 3 s): its pieces, motors, weight, how high it stands, its tags, any warning, or MuJoCo's own error. First write robot/body.mjs and run `node robot/build.mjs`.",
        parameters: Type.Object({}),
        execute: async (_args, api, context) => {
          if (!api.env) return text("Not built: there is no computer to keep the robot's files on.", true);
          if (await loadCodeBody(api.env, context)) await shapeToolsForDriver(api, context);
          const r = await buildRobot(api.env as never, context as never, { sha256: async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("") });
          return text(r.text, r.isError);
        },
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
          part: Type.Optional(oneOf(LOOK_PARTS, "The part to paint, by its tag; the whole robot when absent.")),
          face: Type.Optional(oneOf(FACE_NAMES, "The face; none removes it.")),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: NAME_MAX, description: `The new name, 1 to ${NAME_MAX} characters.` })),
          skill: Type.Optional(Type.String({ pattern: "^[\\w-]{1,40}$", description: "A skill the robot has learned, done last." })),
        }),
        execute: (args, api, context) => edit(api, context, "update_robot", args as Record<string, unknown>),
      }),
    ],
  });
}
