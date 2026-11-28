// What a read cut from a longer text is told of what stands outside it (match.ts marksOf) must cover what the matcher's
// views hide there: at each place where a view reading the text from its start hides a character as a terminal does
// (match.ts shownIn's `hidden`: a character its reading with controls dropped keeps and its terminal reading does not),
// the marks must say a terminal sequence may be open there, or that a backspace stands after it. A read that starts at
// a place with neither counts what that view hides, and can end before the view has shown what it needs.
import { marksOf, shownIn } from "../../dist/redact/match.js";

/** The places in `text` a view hides that its marks miss, and how many hidden places were checked. */
export function uncovered(text) {
  const marks = marksOf(text);
  const hidden = new Set();
  for (const fold of [false, true]) for (const _ of shownIn(text, fold, undefined, Number.POSITIVE_INFINITY, 0, hidden));
  const missed = [];
  for (const end of hidden) {
    const at = end - 1;
    if (marks.openAt(at) === 0 && marks.backspacesFrom(at) === 0) missed.push(at);
  }
  return { checked: hidden.size, missed };
}

/** A tally of uncovered() over many texts: how many places were checked and missed, and the first texts with a place
 *  missed. */
export function coverTally() {
  const tally = { texts: 0, checked: 0, misses: 0, missed: [] };
  return {
    tally,
    add(text) {
      const { checked, missed } = uncovered(text);
      tally.texts++;
      tally.checked += checked;
      tally.misses += missed.length;
      if (missed.length > 0 && tally.missed.length < 20) tally.missed.push(`${JSON.stringify(text)} at ${missed.join(", ")}`);
    },
  };
}
