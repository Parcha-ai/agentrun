/** Where things live in an agent's learning repository. SPEC.md is the contract; these are its names. */
export const LAYOUT = Object.freeze({
  index: "learnings/INDEX.md",
  learnings: "learnings",
  skills: ".agents/skills",
  workflows: "workflows",
  memos: "memos",
});

/**
 * What a run's branch never touches, at any depth and in any spelling: the agent's definition and rules, the loop's own
 * skills (the review that merges a run), the checker's config, hooks, CI, package scripts and the spec. `names` match
 * any one path segment; `prefixes` match leading segments.
 */
export const LOCKED = Object.freeze({
  names: Object.freeze(["AGENTS.md", "agent.json", "package.json", "SPEC.md", ".agentrun", ".githooks", ".husky", ".github"]),
  prefixes: Object.freeze([".agents/skills/reflect", ".agents/skills/review"]),
});

/** Files that make git itself run something or read elsewhere: attributes (filters, drivers, LFS) and submodules. */
export const GIT_FILES = Object.freeze([".gitattributes", ".gitmodules"]);

/** Byte caps (UTF-8), and new notes per run. Over a cap is refused, never cut. */
export const CAPS = Object.freeze({
  note: 4096,
  index: 4096,
  memo: 16_384,
  file: 32_768,
  newNotes: 8,
  /** Changed paths in one run; over it nothing else is read. */
  changes: 64,
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
const fold = (names: readonly string[]) => names.map((name) => name.toLowerCase());
const LOCKED_NAMES = fold(LOCKED.names);
const LOCKED_PREFIXES = LOCKED.prefixes.map((prefix) => fold(prefix.split("/")));
const GIT_NAMES = fold(GIT_FILES);
/** 8.3 short names, and the long name each can stand for. */
const SHORT_NAMES: readonly [RegExp, string][] = [
  [/^agents~\d+\.md$/, "agents.md"], [/^agent~\d+\.jso$/, "agent.json"], [/^packag~\d+\.jso$/, "package.json"], [/^agents~\d+$/, ".agents"],
  [/^agentr~\d+$/, ".agentrun"], [/^githoo~\d+$/, ".githooks"], [/^github~\d+$/, ".github"], [/^gitatt~\d+$/, ".gitattributes"], [/^gitmod~\d+$/, ".gitmodules"],
];

/** Every name a filesystem may read `segment` as: any case, Unicode compatibility form, ignorable characters, trailing
 *  dots or spaces, an NTFS stream suffix, or the long name of an 8.3 short name. */
function spellings(segment: string): string[] {
  const bare = segment.replace(IGNORABLE, "");
  const out = new Set<string>();
  for (const form of [bare, bare.normalize("NFKC")]) {
    for (const cased of [form.toLowerCase(), form.toUpperCase().toLowerCase()]) out.add(cased.split(":")[0]!.replace(/[. ]+$/, ""));
  }
  for (const name of [...out]) for (const [short, long] of SHORT_NAMES) if (short.test(name)) out.add(long);
  return [...out];
}

const segmentsOf = (path: string) => path.split(/[\\/]/).map(spellings);
const named = (segments: string[][], names: readonly string[]) => segments.some((spelled) => spelled.some((name) => names.includes(name)));
const startsWith = (segments: string[][], prefix: readonly string[]) => prefix.length <= segments.length && prefix.every((part, at) => segments[at]!.includes(part));

/** True when a run may not touch `path`: a LOCKED name or prefix in any spelling, or one of the host's `extra` paths
 *  (a file, or a folder and everything in it). */
export function isLocked(path: string, extra: readonly string[] = []): boolean {
  const segments = segmentsOf(path);
  if (named(segments, LOCKED_NAMES) || LOCKED_PREFIXES.some((prefix) => startsWith(segments, prefix))) return true;
  return extra.some((locked) => startsWith(segments, fold(locked.replace(/\/+$/, "").split("/"))));
}

/** True when `path` is a `.gitattributes` or `.gitmodules`, at any depth and in any spelling. */
export const isGitFile = (path: string): boolean => named(segmentsOf(path), GIT_NAMES);
