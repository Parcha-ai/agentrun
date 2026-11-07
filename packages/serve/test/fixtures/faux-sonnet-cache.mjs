// The tests' faux model priced as Claude Sonnet 5.5 ($2 input, $10 output, $0.20 a cache read, $2.50 a cache write, a
// million tokens), its usage reported as Anthropic's API reports a growing conversation: each request reads the previous
// one's whole prompt from the cache, writes the rest, and has 3 tokens of input after the last breakpoint. Each reply
// writes a 4,000-character page (the `write` tool), so the conversation grows. Once the run has been billed $0.44, its next
// request finds no cache: its whole prompt is written. One run per process, so the state below is the run's.
export const cost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
/** What the run is billed before its one miss, and the content each reply writes. */
export const MISS_AFTER_USD = 0.44;
export const PAGE = "A line of the page written out. ".repeat(125);
const priceOf = (u) => (u.input * cost.input + u.output * cost.output + u.cacheRead * cost.cacheRead + u.cacheWrite * cost.cacheWrite) / 1e6;
let previous = 0;
let billed = 0;
let missed = false;
export function usage(_context, estimate) {
  // The faux core's estimate of the prompt (no cache: all of it input), in tokens.
  const prompt = estimate.input + estimate.cacheRead + estimate.cacheWrite;
  const miss = !missed && billed >= MISS_AFTER_USD;
  if (miss) missed = true;
  const cacheRead = miss ? 0 : Math.min(previous, Math.max(0, prompt - 3));
  previous = prompt;
  const tokens = { input: 3, output: estimate.output, cacheRead, cacheWrite: Math.max(0, prompt - cacheRead - 3) };
  billed += priceOf(tokens);
  return tokens;
}
export default function reply(context, faux) {
  const n = context.messages.filter((m) => m.role === "toolResult").length;
  return faux.message(faux.toolCall("write", { path: `page-${n}.md`, content: PAGE }), { stopReason: "toolUse" });
}
