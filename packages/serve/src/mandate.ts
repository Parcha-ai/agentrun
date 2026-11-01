// The ordered mandate a run's profile pack puts in its system prompt, after the instructions: the skills the run uses, in
// the order the pack names them; the run's writer skill, last, right before the deliverable; and the file the deliverable
// goes to, or the final message. One wording on every harness: how a skill is loaded is said where it is loaded (the
// harness's skill listing and its tool, or the skill written out below the mandate), not here.

/** A run's profile as it is pinned in its serve.json when the run is made: the pack's name, the effort row it used, the
 *  row's thinking level if the pack sets one, every skill in order, and the output type with its file and writers. */
export type PinnedProfile = {
  name: string;
  effort: string;
  thinking?: string;
  skills: string[];
  output?: { type: string; file?: string; skills: string[] };
};

const quoted = (name: string) => `\`${name}\``;

/** `a`, `a and b`, `a, b and c`. */
const listed = (names: readonly string[]) => (names.length < 3 ? names.map(quoted).join(" and ") : `${names.slice(0, -1).map(quoted).join(", ")} and ${quoted(names.at(-1)!)}`);

/** The mandate for `profile`. */
export function mandateOf(profile: PinnedProfile): string {
  const { name, skills, output } = profile;
  const lines: string[] = [];
  if (skills.length === 1) lines.push(`This run's profile (${name}) uses this skill: ${quoted(skills[0]!)}. It is listed to you as a skill or written out below.`);
  else if (skills.length > 1) lines.push(`This run's profile (${name}) uses these skills, in this order: first ${skills.map(quoted).join(", then ")}. Each is listed to you as a skill or written out below.`);
  if (output?.skills.length) {
    const one = output.skills.length === 1;
    lines.push(`Use ${listed(output.skills)}, the ${one ? "writer" : "writers"} for this run's output (${output.type}), right before you write the deliverable.`);
  }
  if (output?.file) lines.push(`Write the deliverable to ${quoted(output.file)} in your workspace.`);
  else if (output) lines.push(`This run's output (${output.type}) is your final message: write no deliverable file.`);
  return lines.join("\n");
}

/** The instructions, then the mandate for `profile` when the run has one; the instructions alone when it has none. */
export function withMandate(instructions: string, profile: PinnedProfile | undefined): string {
  const mandate = profile ? mandateOf(profile) : "";
  return mandate ? `${instructions.trim()}\n\n${mandate}` : instructions;
}
