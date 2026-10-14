export type Cost = { usd: number | null; parts: Record<string, number | null> };
/** The counters of agentrun.recording/1 section 6 that fold from a recording's lines. */
export function fold(events: readonly Record<string, unknown>[]): {
  processes: number; kills: number; paidCallsMade: number; unknown: number; modelTurns: { committed: number; reasked: ReAsked | null }; cost: Cost;
  judgeAsks: { answered: number; failed: number };
  repeated: { effects: number | null; agentToolCalls: number };
  askedTwice: number;
};
export function repeats(events: readonly Record<string, unknown>[]): { repeated: { effects: number | null; agentToolCalls: number }; askedTwice: number };
export const PI_LIVE_VERSION: number;
export type ReAsked = { proven: { turns: number; reasks: number }; possible: { turns: number; reasks: number } };
export function reAsked(events: readonly Record<string, unknown>[]): ReAsked | null;
export function readEvents(dir: string): Record<string, unknown>[];
