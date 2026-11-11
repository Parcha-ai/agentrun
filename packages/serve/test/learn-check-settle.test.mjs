// checkProposal settles a run's new notes in one order (learn/check.ts settled): each note alone against the seed, then
// one holder a rule with the rest as alternates, then the holders' shared checks, a refused holder's next alternate
// holding its rule in its place. A property over every small answer of 3 or 4 notes, drawn from new rules, repeats,
// notes superseding a note of the seed, two superseding the same one, a supersede of a note the seed does not hold and a
// repeat of the seed's own rule, on a seed whose index is at 199 or 200 lines: run as proposeRun runs the checks (each
// pass leaves out what it names), what is kept is a valid set, one note a rule, and no left-out note of a rule nothing
// kept holds could have been kept beside it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProposal } from "../dist/learn/check.js";
import { INDEX_LINES, parseNoteFile, ruleOf } from "../dist/learn/notes.js";

const text = (name, body, supersedes = []) => `---\nname: ${name}\ndescription: ${name}, as a rule\ntype: feedback\n${supersedes.length ? `supersedes: [${supersedes.join(", ")}]\n` : ""}---\n${body}\n`;
/** The pool: each a note a run may propose. */
const POOL = [
  { file: "n1.md", body: "Rule one: check the totals.", supersedes: [] },
  { file: "n1-again.md", body: "rule ONE:  check the totals.", supersedes: [] },
  { file: "n2.md", body: "Rule two: name the source.", supersedes: [] },
  { file: "s1.md", body: "Rule three replaces old zero.", supersedes: ["old-0.md"] },
  { file: "s1-again.md", body: "Rule three replaces old zero.", supersedes: [] },
  { file: "s2.md", body: "Rule four replaces old zero too.", supersedes: ["old-0.md"] },
  { file: "gone.md", body: "Rule five replaces a note that is not there.", supersedes: ["missing.md"] },
  { file: "old-again.md", body: "Old rule number 1.", supersedes: [] },
];

/** A seed whose index holds `lines` active notes, old-0.md to old-<lines-1>.md, each its own rule. */
function seedOf(lines) {
  const actives = Array.from({ length: lines }, (_, i) => ({ file: `old-${i}.md`, text: text(`Old ${i}`, `Old rule number ${i}.`) }));
  return {
    files: ["MEMORY.md", ...actives.map(({ file }) => file)],
    active: actives.map(({ file, text: t }) => parseNoteFile(file, t)),
    rules: new Map(actives.map(({ file }, i) => [ruleOf(`Old rule number ${i}.`), file])),
  };
}

const change = (note) => ({ path: note.file, status: "added", mode: "100644", bytes: Buffer.from(text(note.file.replace(/\.md$/, ""), note.body, note.supersedes)) });

/** What survives the checks as proposeRun runs them: each pass leaves out every note it names, until a pass passes (its
 *  notes) or names none it can leave out (nothing kept). */
function survivors(base, notes) {
  let kept = [...notes];
  for (let pass = 0; pass <= notes.length; pass++) {
    if (!kept.length) return [];
    const result = checkProposal({ base, changes: kept.map(change) });
    if (result.ok) return result.notes.map(({ file }) => file);
    const named = new Set(result.problems.flatMap(({ path }) => (path === undefined ? [] : [path])));
    if (!named.size || result.problems.some(({ path }) => path === undefined)) return [];
    kept = kept.filter(({ file }) => !named.has(file));
  }
  assert.fail("the passes never settled");
}

/** Whether `set` may join `base` as it is, read here apart from the checks: what each note supersedes is active and
 *  named once, at most 8 superseded, the index within its lines, and one note a rule (the seed's rules held, unless the
 *  note supersedes the one it repeats). */
function valid(base, lines, set) {
  const active = new Set(base.active.map(({ file }) => file));
  const rules = new Map(base.rules);
  const replaced = new Set();
  let count = lines;
  for (const note of set) {
    if (note.supersedes.some((old) => !active.has(old) || replaced.has(old))) return false;
    for (const old of note.supersedes) replaced.add(old);
    const rule = ruleOf(note.body);
    const holder = rules.get(rule);
    if (holder !== undefined && !note.supersedes.includes(holder)) return false;
    rules.set(rule, note.file);
    count += 1 - note.supersedes.length;
  }
  return replaced.size <= 8 && count <= INDEX_LINES;
}

/** Every ordered pick of `k` notes of `pool`. */
function* picks(pool, k, taken = []) {
  if (taken.length === k) return yield taken;
  for (const note of pool) if (!taken.includes(note)) yield* picks(pool, k, [...taken, note]);
}

for (const lines of [INDEX_LINES - 1, INDEX_LINES]) {
  test(`every answer of 3 or 4 notes on a seed of ${lines} lines keeps a valid set, one note a rule, and no left-out note that could have been kept`, () => {
    const base = seedOf(lines);
    let cases = 0;
    for (const k of [3, 4]) {
      for (const answer of picks(POOL, k)) {
        cases += 1;
        const kept = survivors(base, answer).map((file) => answer.find((note) => note.file === file));
        const said = `${lines} lines, ${answer.map(({ file }) => file).join(" ")}: kept ${kept.map(({ file }) => file).join(" ") || "nothing"}`;
        assert.ok(valid(base, lines, kept), `what is kept is valid: ${said}`);
        const held = new Set(kept.map(({ body }) => ruleOf(body)));
        for (const note of answer) {
          if (held.has(ruleOf(note.body))) continue;
          assert.ok(!valid(base, lines, [...kept, note]), `${note.file} could have been kept beside the rest: ${said}`);
        }
        const any = answer.some((note) => valid(base, lines, [note]));
        if (any) assert.ok(kept.length > 0, `a note could have been kept alone, and nothing was: ${said}`);
      }
    }
    assert.ok(cases > 2000, `${cases} answers read`);
  });
}
