// Typechecked with the serve package (tsconfig.test.json), never run: the types a caller of the web package's root
// needs to hold its answers, named from the root, since the package exports no deeper entry. A name the root drops
// fails the typecheck here.
import type { Cost, DecideContext, FetchAnswer, PageAnswers, Tokens, Verdict, Verdicts } from "@parcha/agentrun-web";

const verdict: Verdict = 0.5;
const tokens: Tokens = { in: 10, out: null, basis: "counted" };
const cost: Cost = { usd: null, basis: "none" };
const verdicts: Verdicts = { verdicts: [verdict, null], model: null, tokens, cost, questions_sha256: [], temperature_sent: null, temperature_applied: "unknown" };
const answers: PageAnswers = { wall: null, injection: null, model: verdicts.model, tokens, cost, questions_sha256: [], temperature_sent: null, temperature_applied: false };
const context: DecideContext = { signal: new AbortController().signal, deadlineMs: 1_000 };
const urlOf = (answer: FetchAnswer): string => answer.url;

export const held = { answers, context, urlOf };
