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
  // The known part of a line whose run's cost is unknown: what the run spent so far beside its known other lines.
  const knownTokens = meters && tokens === null ? Math.max(0, soFar - (meters.browser.usd ?? 0) - (meters.others ?? 0)) : 0;
  // Each apart, an unknown one unknown (unpriced on its own line), never $0 nor the other's.
  const browser = meters ? meters.browser.usd : 0;
  const tools = meters?.others;
  const parts: [string, number | null][] = !meters ? [[key, usd]] : [[key, tokens ?? null], ...(tools !== 0 ? [["tools", tools ?? null] as [string, number | null]] : []), ...(browser !== 0 ? [["browser_time", browser] as [string, number | null]] : [])];
  // Its known dollars when unknown: the whole of what it spent so far on a line of its own (by agent, by day), else the
  // part beside its known meters on tokens.
  return parts.map(([name, part]) => (part !== null ? { name, usd: part, unpriced: false } : { name, unpriced: true, usd: meters ? (name === key ? knownTokens : 0) : soFar }));
}
