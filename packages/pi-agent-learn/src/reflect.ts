// The reflection a host asks of a Pi agent once its run has answered: one more message into the same conversation, whose
// reply holds the memo's two sections in the agent's own words. `parseReflection` reads the reply; `proposeLearning`
// writes the sections under the host's front matter, or the host's own lines when `reflectionProblem` or the guard
// refuses them.

/** The message a host sends after the run's answer. The agent's `learn` calls in reply are the run's notes and uses. */
export const REFLECT_PROMPT = [
  "The task is done. Before the run ends, reflect on it for your learning repository.",
  "",
  'First, call learn once for each general rule this run taught you that would help on other inputs, and with type "used"',
  "for each line of <learned> that helped. Call it for nothing when the run taught nothing general.",
  "",
  "Then reply with exactly these two sections and nothing else:",
  "",
  "## What happened",
  "Two or three sentences on what you did and how it went.",
  "",
  "## What could be better",
  'One line per point, each starting with "- ": what would have made the run right sooner or cheaper.',
  "",
  "Write about the work, never about this case's data: never a name, an id, an amount, an address or a document from the",
  "input, and never a key or a password. Use no other headings.",
].join("\n");

/** The memo's two sections the agent writes. */
export type Reflection = { readonly whatHappened: string; readonly couldBeBetter: string };

/** The most characters a section holds. */
export const REFLECTION_CHARS = 2000;

const HEADINGS = { whatHappened: "## What happened", couldBeBetter: "## What could be better" } as const;

/** The two sections out of the agent's reply, in either order, or undefined when either is missing, empty or given twice.
 *  A section runs from its heading to the next `## ` line or the reply's end. */
export function parseReflection(reply: string): Reflection | undefined {
  if (typeof reply !== "string") return undefined;
  const lines = reply.replace(/\r\n?/g, "\n").split("\n");
  const section = (heading: string): string | undefined => {
    const at = lines.flatMap((line, i) => (line.trimEnd() === heading ? [i] : []));
    if (at.length !== 1) return undefined;
    const rest = lines.slice(at[0]! + 1);
    const end = rest.findIndex((line) => line.startsWith("## "));
    const text = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
    return text === "" ? undefined : text;
  };
  const whatHappened = section(HEADINGS.whatHappened);
  const couldBeBetter = section(HEADINGS.couldBeBetter);
  return whatHappened === undefined || couldBeBetter === undefined ? undefined : { whatHappened, couldBeBetter };
}

/** Why the reflection cannot be the memo's, or undefined: a section that is empty, too long, holds a heading or a `---`
 *  line that would reshape the memo, or a control or invisible character. */
export function reflectionProblem(reflection: Reflection): string | undefined {
  if (reflection === null || typeof reflection !== "object") return "out of shape: not a reflection";
  for (const key of ["whatHappened", "couldBeBetter"] as const) {
    const text = reflection[key];
    if (typeof text !== "string" || text.trim() === "") return "out of shape: a section is empty";
    if (Array.from(text).length > REFLECTION_CHARS) return `out of shape: a section is over ${REFLECTION_CHARS} characters`;
    if (/^\s*(?:#|---)/m.test(text)) return "out of shape: a section holds a heading or a rule line";
    if (/[\p{Cc}\p{Cf}]/u.test(text.replace(/[\n\t]/g, ""))) return "out of shape: a section holds a control or invisible character";
  }
  return undefined;
}
