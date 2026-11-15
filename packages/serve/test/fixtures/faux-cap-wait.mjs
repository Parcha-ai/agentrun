// The subagent faux model (faux-subagent.mjs, its replies and its fixed usage) at the shape of a real run near its cap: a
// request's worst case far above what it costs. $6 and $120 a million input and output tokens with a 2,000-token output
// allowance: a request costs $0.018 (1,000 input and 100 output tokens), is held at about $0.25, and needs at least about
// $0.13 (its input and a 1,024-token answer, the least the cap limits it to), so a $0.50 cap covers a run's real cost
// several times over but only two requests' worst cases at once, and no third beside them even at its least.
// The host's budget note (a <system-reminder> it adds to the person's message near a small cap) is read past, as a model
// reads past it, so the person's first line still says what to do.
import reply from "./faux-subagent.mjs";

export { LOG_ENV, RELEASE_ENV, usage } from "./faux-subagent.mjs";
export const cost = { input: 6, output: 120, cacheRead: 0, cacheWrite: 0 };
export const maxTokens = 2000;

const NOTE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const unnoted = (content) => (typeof content === "string" ? content.replace(NOTE, "") : Array.isArray(content) ? content.map((part) => (part?.type === "text" ? { ...part, text: part.text.replace(NOTE, "") } : part)) : content);

export default function (context, faux) {
  return reply({ ...context, messages: context.messages.map((m) => (m.role === "user" ? { ...m, content: unnoted(m.content) } : m)) }, faux);
}
