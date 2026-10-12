// The SOPs code mode runs on, as the host installs them: text that travels with the task, never engine code.
//   ROBOT_SOP   the session's instructions for writing a robot as code (D3's robot/body.mjs format, build_robot)
//   TEACH_SOP   the session's instructions for planning skills and writing each thread's brief (teach_skills)
//   TRAIN_SOP   each thread's instructions: writing and running its own training with D2's library (plan.threadInstructions)
// Changing what the agent does means editing these files, not teach-skills.ts.
import { existsSync, readFileSync } from "node:fs";

const read = (name: string): string => {
  const url = new URL(`./sop/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : "";
};

export const ROBOT_SOP = read("robot.md");
export const TEACH_SOP = read("teach.md");
export const TRAIN_SOP = read("train-skill.md");
