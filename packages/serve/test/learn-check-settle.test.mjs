// checkProposal settles a run's new notes in one order (learn/check.ts settled): each note alone against the seed, then
// one holder a rule with the rest as alternates, then the holders' shared checks, a refused holder's next alternate
// holding its rule in its place. A property over every small answer of 3 or 4 notes, drawn from new rules, repeats,
// notes superseding a note of the seed, two superseding the same one, a supersede of a note the seed does not hold and a
// repeat of the seed's own rule, on a seed whose index is well under its cap, at 199 or at 200 lines: run as proposeRun runs the checks (each
// pass leaves out what it names), what is kept is a valid set, each rule with a valid holder keeps exactly one copy, and
// a note left out as a duplicate repeats a note that is kept (or the seed's), never a holder that was refused.
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
  { file: "old0-again.md", body: "Old rule number 0.", supersedes: [] },
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
  // Each note left out as a duplicate, by the note it was said to repeat.
  const duplicates = new Map();
  const settle = () => {
    for (let pass = 0; pass <= notes.length; pass++) {
      if (!kept.length) return [];
      const result = checkProposal({ base, changes: kept.map(change) });
      if (result.ok) return result.notes.map(({ file }) => file);
      for (const { rule, path, detail } of result.problems) if (rule === "duplicate") duplicates.set(path, /^it says what (\S+) says$/.exec(detail)?.[1]);
      const named = new Set(result.problems.flatMap(({ path }) => (path === undefined ? [] : [path])));
      if (!named.size || result.problems.some(({ path }) => path === undefined)) return [];
      kept = kept.filter(({ file }) => !named.has(file));
    }
    assert.fail("the passes never settled");
  };
  return { files: settle(), duplicates };
}

/** Whether `set` may join `base` as it is, read here apart from the checks: what each note supersedes is active and
 *  named once, at most 8 superseded, the index within its lines, and one note a rule (the seed's rules held, unless the
 *  note supersedes the one it repeats). */
function valid(base, lines, set) {
  const active = new Set(base.active.map(({ file }) => file));
  // A seed note any note of the set supersedes keeps no rule after it.
  const going = new Set(set.flatMap((note) => note.supersedes));
  const rules = new Map([...base.rules].filter(([, holder]) => !going.has(holder)));
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

for (const lines of [10, INDEX_LINES - 1, INDEX_LINES]) {
  test(`every answer of 3 or 4 notes on a seed of ${lines} lines keeps a valid set, one copy of each rule with a valid holder, and no copy lost to a refused holder`, () => {
    const base = seedOf(lines);
    let cases = 0;
    for (const k of [3, 4]) {
      for (const answer of picks(POOL, k)) {
        cases += 1;
        const { files, duplicates } = survivors(base, answer);
        const kept = files.map((file) => answer.find((note) => note.file === file));
        const said = `${lines} lines, ${answer.map(({ file }) => file).join(" ")}: kept ${kept.map(({ file }) => file).join(" ") || "nothing"}`;
        assert.ok(valid(base, lines, kept), `what is kept is valid: ${said}`);
        // Each rule with a valid holder (a note of it the rest of what is kept has room for) keeps exactly one copy.
        for (const rule of new Set(answer.map(({ body }) => ruleOf(body)))) {
          const copies = kept.filter(({ body }) => ruleOf(body) === rule).length;
          assert.ok(copies <= 1, `one copy of a rule at most: ${said}`);
          const others = kept.filter(({ body }) => ruleOf(body) !== rule);
          const holdable = answer.some((note) => ruleOf(note.body) === rule && valid(base, lines, [...others, note]));
          if (holdable) assert.equal(copies, 1, `a rule with a valid holder keeps one copy: ${said}`);
        }
        // A note left out as a duplicate repeats a note that is kept, or one of the seed's: never a refused holder.
        for (const [file, holder] of duplicates) {
          assert.ok(files.includes(holder) || /^old-\d+\.md$/.test(holder), `${file} was left out as a repeat of ${holder}, which is not kept: ${said}`);
        }
        const any = answer.some((note) => valid(base, lines, [note]));
        if (any) assert.ok(kept.length > 0, `a note could have been kept alone, and nothing was: ${said}`);
      }
    }
    assert.ok(cases > 2000, `${cases} answers read`);
  });
}
