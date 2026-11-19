// The grader's faux answer (learn/promote.ts GRADER_PROMPT), for every faux model of the tests: a request whose system
// text is the grader's is answered with its verdict, {"same": true|false, "differs_on": ...}. Two answers are the same
// when their JSON values (the last json fence, or the whole answer) are equal once the fields a faux varies are left
// out (VARIED: its prose and its reasons); else they differ on the first key whose values differ. An answer with no JSON
// is compared as its trimmed text.
import * as promote from "../../dist/learn/promote.js";

/** The fields a faux varies between two answers of the same decision: its words, never its decision. */
export const VARIED = Object.freeze(["why", "reason", "reasons", "rationale", "explanation", "evidence", "notes", "summary"]);

/** The grader's first line, which a request's system text holds (none on a build with no grader). */
const FIRST_LINE = typeof promote.GRADER_PROMPT === "string" ? promote.GRADER_PROMPT.split("\n")[0] : undefined;
/** Whether `system` is the grader's instructions. */
export const isGraderSystem = (system) => FIRST_LINE !== undefined && typeof system === "string" && system.includes(FIRST_LINE);

/** The answer between `label`'s <<< and >>> in the grader's user text, or undefined. */
const fenced = (text, label) => new RegExp(`${label}:\\n<<<\\n([\\s\\S]*?)\\n>>>`).exec(text)?.[1];

/** An answer's decision: its last json fence's value, else the whole answer's, else its trimmed text; VARIED left out. */
function decisionOf(answer) {
  const fences = [...answer.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  for (const text of [fences.at(-1), answer].filter((one) => one !== undefined)) {
    try {
      return strip(JSON.parse(text.trim()));
    } catch {
      // not JSON: the next reading
    }
  }
  return answer.trim();
}
const strip = (value) => (Array.isArray(value) ? value.map(strip) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !VARIED.includes(key)).map(([key, one]) => [key, strip(one)])) : value);

/** The grader's verdict on its user text (graderUserText), as the reply's text. */
export function graderVerdict(user) {
  const [agent, draft] = [fenced(user, "The agent's answer"), fenced(user, "The workflow's answer")];
  if (agent === undefined || draft === undefined) return JSON.stringify({ same: false, differs_on: "the answers could not be read" });
  const [a, b] = [decisionOf(agent), decisionOf(draft)];
  if (JSON.stringify(a) === JSON.stringify(b)) return JSON.stringify({ same: true, differs_on: null });
  const keyed = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
  const key = keyed ? [...new Set([...Object.keys(a), ...Object.keys(b)])].find((one) => JSON.stringify(a[one]) !== JSON.stringify(b[one])) : undefined;
  return JSON.stringify({ same: false, differs_on: key ?? "the answer" });
}

/** Every string in `value`, depth first. */
const stringsOf = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : []);

/** A gateway request body's grader verdict, when its system text is the grader's (Messages' `system`, Responses'
 *  `instructions` or a system/developer input, Chat Completions' system message); else undefined. */
export function graderAnswerOfBody(body) {
  const strings = stringsOf(body);
  if (!strings.some(isGraderSystem)) return undefined;
  const user = strings.find((one) => one.includes("The agent's answer:\n<<<"));
  return user === undefined ? undefined : graderVerdict(user);
}

/** A pi faux model's grader verdict on `context` (pi-ai's: its systemPrompt and its last user message), else undefined. */
export function graderAnswerOfContext(context) {
  if (!isGraderSystem(context.systemPrompt ?? "")) return undefined;
  const user = context.messages.filter((m) => m.role === "user").at(-1);
  const text = typeof user?.content === "string" ? user.content : (user?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
  return graderVerdict(text);
}
