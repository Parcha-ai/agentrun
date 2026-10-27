/** Where things live in an agent's learning repository. SPEC.md is the contract; these are its names. */
export const LAYOUT = Object.freeze({
  /** Never touched by the loop: the agent's definition and its standing rules. */
  untouched: Object.freeze(["agent.json", "AGENTS.md"]),
  index: "learnings/INDEX.md",
  learnings: "learnings",
  skills: ".agents/skills",
  workflows: "workflows",
  memos: "memos",
});

/** Byte caps (UTF-8), and new notes per run. Over a cap is refused, never cut. */
export const CAPS = Object.freeze({
  note: 4096,
  index: 4096,
  memo: 16_384,
  file: 32_768,
  newNotes: 8,
});

/** A run id: also a valid branch name under `runs/` (no `..`, no trailing `.` or `.lock`). */
export const RUN_ID = /^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?<!\.)$/;
export const LEARNING_ID = /^L-[0-9a-f]{12}$/;
export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The shared skills convention's name: lowercase letters, digits and single dashes. */
export const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type Kind = "note" | "index" | "skill" | "workflow" | "readme" | "memo";
export type Place = { kind: Kind; id?: string; name?: string };

const PLACES: readonly [RegExp, Kind, RegExp | undefined][] = [
  [/^learnings\/INDEX\.md$/, "index", undefined],
  [/^learnings\/([^/]+)\.md$/, "note", LEARNING_ID],
  [/^\.agents\/skills\/([^/]+)\/SKILL\.md$/, "skill", SKILL_NAME],
  [/^workflows\/([^/]+)\/workflow\.json$/, "workflow", WORKFLOW_NAME],
  [/^workflows\/([^/]+)\/README\.md$/, "readme", WORKFLOW_NAME],
  [/^memos\/([^/]+)\.md$/, "memo", RUN_ID],
];

/** Where `path` sits in the layout, or undefined when the layout does not hold it. */
export function placeOf(path: string): Place | undefined {
  for (const [pattern, kind, name] of PLACES) {
    const match = pattern.exec(path);
    if (!match) continue;
    if (!name) return { kind };
    if (!name.test(match[1]!)) return undefined;
    return kind === "note" || kind === "memo" ? { kind, id: match[1]! } : { kind, name: match[1]! };
  }
  return undefined;
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const LOCKED = LAYOUT.untouched.map((name) => name.toLowerCase());
const SHORT_NAMES = [/^agent~\d+\.jso$/, /^agents~\d+\.md$/];

function spellings(segment: string): string[] {
  const bare = segment.replace(IGNORABLE, "");
  const out = new Set<string>();
  for (const form of [bare, bare.normalize("NFKC")]) {
    for (const cased of [form.toLowerCase(), form.toUpperCase().toLowerCase()]) out.add(cased.split(":")[0]!.replace(/[. ]+$/, ""));
  }
  return [...out];
}

/** True when any segment of `path` names `AGENTS.md` or `agent.json`: any case, Unicode compatibility form, ignorable
 *  characters, trailing dots or spaces, an NTFS stream suffix or an 8.3 short name, with `/` or `\` as the separator. */
export function isUntouchable(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => spellings(segment).some((name) => LOCKED.includes(name) || SHORT_NAMES.some((short) => short.test(name))));
}
