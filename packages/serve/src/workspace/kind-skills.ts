// The skills a run's computer kind brings: how to look, act, check and recover on a desktop (desktop-computer) or a phone
// (phone-computer). Each is the SKILL.md beside this file (kind-skills/<kind>/SKILL.md, copied next to the server by the
// build), laid in a run's .agents/skills/<name>/ with the agent's own skills (revision-skills.ts layRevisionSkills).
import { readFileSync } from "node:fs";

/** A kind's skill: its name (its folder under .agents/skills/, as its front matter says it) and its SKILL.md's text. */
export type KindSkill = { readonly name: string; readonly text: string };

/** The computer kinds that bring a skill. */
export type SkillKind = "desktop" | "phone";

const read = (kind: SkillKind): KindSkill => {
  const text = readFileSync(new URL(`./kind-skills/${kind}/SKILL.md`, import.meta.url), "utf8");
  const name = /^---\nname: ([a-z0-9-]+)\n/.exec(text)?.[1];
  if (!name) throw new Error(`the ${kind} kind's SKILL.md names no skill in its front matter`);
  return { name, text };
};

/** Each kind's skill, read once. */
export const KIND_SKILLS: Readonly<Record<SkillKind, KindSkill>> = Object.freeze({ desktop: read("desktop"), phone: read("phone") });

/** The skill a run's computer kind brings, if it brings one. */
export const kindSkillOf = (kind: string | undefined): KindSkill | undefined => (kind === "desktop" || kind === "phone" ? KIND_SKILLS[kind] : undefined);
