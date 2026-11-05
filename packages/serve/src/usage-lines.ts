// The lines one run adds to GET /usage: by meter its tokens, its paid tools and its browser time, else one line (by
// agent, by day). A part whose cost is unknown counts the run as unpriced on its line and adds what is known of it, so
// no sum is ever null and none passes an unknown cost as $0.

/** A run's meters, from its store (cap.ts metersIn) or its live rows: each null when one of its charges is unknown. */
export type RunMeters = { tools: number | null; tokens: number | null; browser: { usd: number | null }; others: number | null; known?: { tokens: number; browser: number; others: number } };

/** One run's parts of /usage's lines. `usd`: its cost, null when unknown; `soFar`: what it is known to have spent then;
 *  `key`: its line when it has one alone (`tokens` by meter); `meters`: its meters, by meter only. */
export function runLines(run: { usd: number | null; soFar: number; key: string; meters?: RunMeters }): { name: string; usd: number; unpriced: boolean }[] {
  const { usd, soFar, key, meters } = run;
  const tokens = meters && (usd !== null && meters.tools !== null ? usd - meters.tools : usd === null && meters.tools === null ? meters.tokens : null);
  // Each meter's known dollars, whatever else of it is unknown: an unknown line's own, and on tokens what the run spent
  // so far beside the other meters' known dollars, so no meter's dollars land on another's line, nor on none.
  const known = meters?.known ?? { tokens: 0, browser: 0, others: 0 };
  const knownOn = (name: string) => (name === "browser_time" ? known.browser : name === "tools" ? known.others : Math.max(0, soFar - known.browser - known.others));
  // Each apart, an unknown one unknown (unpriced on its own line), never $0 nor the other's.
  const browser = meters ? meters.browser.usd : 0;
  const tools = meters?.others;
  const parts: [string, number | null][] = !meters ? [[key, usd]] : [[key, tokens ?? null], ...(tools !== 0 ? [["tools", tools ?? null] as [string, number | null]] : []), ...(browser !== 0 ? [["browser_time", browser] as [string, number | null]] : [])];
  // Its known dollars when unknown: the whole of what it spent so far on a line of its own (by agent, by day), else its
  // meter's own known dollars.
  const lines = parts.map(([name, part]) => (part !== null ? { name, usd: part, unpriced: false } : { name, unpriced: true, usd: meters ? knownOn(name) : soFar }));
  // What it spent so far beyond every line (an ended workflow's other conversations' model requests and its decisions'
  // receipts, which its root store does not hold) is model and decision spend: on tokens, the meter of all but paid tools
  // and browser time, never on tools or browser_time; so the lines sum to what it spent.
  const beyond = usd === null && meters ? soFar - lines.reduce((sum, line) => sum + line.usd, 0) : 0;
  const rest = beyond > 0 ? lines.find((line) => line.name === key) : undefined;
  if (rest) rest.usd += beyond;
  return lines;
}
