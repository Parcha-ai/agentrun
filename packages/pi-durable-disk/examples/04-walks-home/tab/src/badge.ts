// The live badge on the model card: what really runs in this tab, from this page's own measurement. It exists only after an answer that passed
// the judge (so never next to a failure), and an answer whose speed could not be measured says so instead of repeating an older speed.

export function badgeText(answer: { judged?: string; tokens_per_s?: number }, sizeBytes: number | null): string | null {
  if (answer.judged !== 'passed' || !sizeBytes) return null;
  const rate = typeof answer.tokens_per_s === 'number' && Number.isFinite(answer.tokens_per_s) && answer.tokens_per_s > 0 ? `${answer.tokens_per_s.toFixed(1)} tokens/s` : 'speed not measured';
  return `running in this tab: ${Math.round(sizeBytes / 1e6)} MB · ${rate} · no model server`;
}
