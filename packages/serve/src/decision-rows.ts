// A workflow run's decisions as timeline rows: one row per receipt its judge, pick, sift, route, ask and verify nodes
// committed to the run's store (`agentrun.decisions`), so a run shows its verdicts beside its model nodes' rows. The
// rows are read from the released store, as the rest of a workflow run's rows are.
import type { TimelineEvent } from "@parcha/pi-durable-agent/timeline";

type Answer = { type?: unknown; noul?: unknown; choice?: unknown; score?: unknown; legend?: unknown; confidence?: unknown; probabilities?: unknown };
type Receipt = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const two = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "?");

/** One answer as a reader says it: the answer, then how likely the provider thought it. */
function said(id: string, answer: Answer): string {
  if (answer.type === "refusal") return `${id} refused`;
  if (answer.type === "noul" && typeof answer.noul === "number") return `${id} ${answer.noul >= 0.5 ? "yes" : "no"} ${two(answer.noul >= 0.5 ? answer.noul : 1 - answer.noul)}`;
  if (answer.type === "choice") {
    const p = isObject(answer.probabilities) ? answer.probabilities[String(answer.choice)] : undefined;
    return `${id} ${String(answer.choice)} ${two(p ?? answer.confidence)}`;
  }
  if (answer.type === "score") {
    const level = isObject(answer.legend) ? answer.legend[String(answer.score)] : undefined;
    return `${id} ${String(level ?? answer.score)} ${two(answer.confidence)}`;
  }
  return `${id} ${String(answer.type ?? "answered")}`;
}

/** What the decision decided, in a line: a route's branch, else each answer. */
function summaryOf(receipt: Receipt): string {
  const node = String(receipt.node ?? "decision");
  const status = receipt.status;
  if (receipt.kind === "route") {
    const action = isObject(receipt.action) ? receipt.action : {};
    const taken = action.taken ?? action.branch;
    const flags = [action.unsure === true ? "unsure" : "", action.refused === true || (Array.isArray(receipt.refused) && receipt.refused.length) ? "refused" : ""].filter(Boolean);
    if (status !== "answered" || typeof taken !== "string") return `${node}: route ${String(status)}`;
    return `route: ${taken}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  }
  const head = typeof receipt.provider === "string" ? `${node} (${receipt.provider})` : node;
  const answers = isObject(receipt.answers) ? Object.entries(receipt.answers).map(([id, answer]) => said(id, isObject(answer) ? answer : {})) : [];
  if (status !== "answered") return `${head}: ${String(status)}${answers.length ? ` · ${answers.join(" · ")}` : ""}`;
  return `${head}: ${answers.join(" · ") || "answered"}`;
}

/** The sources the answers rest on, and the questions refused, one per line; null when there are none. */
function textOf(receipt: Receipt): string | null {
  const lines: string[] = [];
  for (const source of Array.isArray(receipt.evidence) ? receipt.evidence : []) {
    if (!isObject(source) || typeof source.url !== "string") continue;
    lines.push(`${typeof source.title === "string" && source.title ? `${source.title} ` : ""}${source.url}`);
  }
  if (Array.isArray(receipt.refused) && receipt.refused.length) lines.push(`refused: ${receipt.refused.map(String).join(", ")}`);
  if (typeof receipt.error === "string" && receipt.error) lines.push(receipt.error);
  return lines.length ? lines.join("\n") : null;
}

/** One `decision` row per receipt, in commit order. Each carries its own cost: unknown stays null, never $0. */
export function decisionRows(receipts: readonly Receipt[]): TimelineEvent[] {
  return receipts.map((receipt, place) => {
    const at = typeof receipt.at === "string" ? receipt.at : new Date(0).toISOString();
    const request = isObject(receipt.request) ? receipt.request : {};
    const cost = typeof receipt.cost_usd === "number" && Number.isFinite(receipt.cost_usd) ? receipt.cost_usd : null;
    return {
      id: `decision:${String(receipt.id ?? place)}:${String(request.index ?? 0)}`,
      timestamp: at, created_at: at, kind: "decision",
      summary: summaryOf(receipt), agent_label: typeof receipt.node === "string" ? receipt.node : null,
      tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null,
      text: textOf(receipt), usage: { usd: cost, requests: 1 },
    };
  });
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** `rows` with the decisions' rows among them by time, and their cost on the run's usage row, which stays last: one
 *  unknown cost makes the total unknown, never a lower figure. */
export function withDecisions(rows: readonly TimelineEvent[], receipts: readonly Receipt[]): TimelineEvent[] {
  if (!receipts.length) return [...rows];
  const decisions = decisionRows(receipts);
  const at = rows.findLastIndex((row) => row.kind === "usage");
  const rest = at < 0 ? [...rows] : rows.filter((_, i) => i !== at);
  for (const row of decisions) {
    const before = rest.findIndex((other) => other.timestamp > row.timestamp);
    rest.splice(before < 0 ? rest.length : before, 0, row);
  }
  const costs = decisions.map((row) => row.usage?.usd ?? null);
  const spent = costs.every((usd) => usd !== null) ? (costs as number[]).reduce((a, b) => a + b, 0) : null;
  const models = at < 0 ? { usd: 0, requests: 0 } : (rows[at]?.usage ?? { usd: null, requests: 0 });
  // Rounded off float noise only: a decision costs millionths of a dollar, and the row agrees with the run's cost.
  const usd = models.usd === null || spent === null ? null : Math.round((models.usd + spent) * 1e12) / 1e12;
  const base = at < 0 ? { ...decisions.at(-1)!, id: "decisions:usage", agent_label: null, text: null } : rows[at]!;
  const summary = `Cost so far: ${usd === null ? "unknown" : usd === 0 ? "$0" : usd < 0.0001 ? "<$0.0001" : `$${usd.toFixed(4)}`} over ${plural(models.requests, "model request")} and ${plural(decisions.length, "decision")}`;
  return [...rest, { ...base, kind: "usage", summary, usage: { usd, requests: models.requests + decisions.length } }];
}
