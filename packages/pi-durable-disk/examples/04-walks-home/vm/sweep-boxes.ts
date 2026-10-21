// The stop's sweep of a run's GPU boxes by label: every RUNNING box labelled pda-run=<run> and pda-role=gpu is found through pi-transport's provider.list and destroyed through it, then listed
// again until none is left or the wait ends (Modal can still list a destroyed sandbox as running for about 30 s). The ledger sweep (sweep-open.ts) stays beside it as the backstop for a create
// Modal has queued and not placed: it is invisible to a list, which sees running boxes only.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { BoxProvider } from "@parcha/pi-transport";

export interface SweepBoxesResult {
  readonly found: number;
  readonly destroyed: number;
  readonly left: number;
  readonly leftIds: readonly string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sweepBoxes(provider: BoxProvider, run: string, options: { waitMs?: number; pollMs?: number } = {}): Promise<SweepBoxesResult> {
  const labels = { "pda-run": run, "pda-role": "gpu" };
  const waitMs = options.waitMs ?? 60_000;
  const pollMs = options.pollMs ?? 2_000;
  const first = await provider.list(labels, context);
  if (!first.ok) throw new Error(`${first.error.code}: ${first.error.message}`);
  const seen = new Set(first.value.map((r) => r.id));
  const destroyed = new Set<string>();
  const deadline = Date.now() + waitMs;
  let listed = first.value;
  for (;;) {
    for (const ref of listed) {
      const attached = await provider.attach(ref.id, context);
      if (!attached.ok || attached.value === undefined) continue;
      const ended = await attached.value.destroy(context);
      if (ended.ok) destroyed.add(ref.id);
    }
    if (Date.now() + pollMs > deadline) break;
    await sleep(pollMs);
    const again = await provider.list(labels, context);
    if (!again.ok) throw new Error(`${again.error.code}: ${again.error.message}`);
    listed = again.value;
    if (listed.length === 0) return { found: seen.size, destroyed: destroyed.size, left: 0, leftIds: [] };
  }
  const last = await provider.list(labels, context);
  const leftIds = last.ok ? last.value.map((r) => r.id) : [...seen].filter((id) => !destroyed.has(id));
  return { found: seen.size, destroyed: destroyed.size, left: leftIds.length, leftIds };
}
