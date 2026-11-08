// A workflow run's decisions as timeline rows: one row per receipt its judge, pick, sift, route, ask and verify nodes
// committed to the run's store (`agentrun.decisions`), so a run shows its verdicts beside its model nodes' rows. The
// rows are read from the released store, as the rest of a workflow run's rows are.
import { CAPS, costLabel, cut, endedUsage, scrubUrls, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";

type Answer = { type?: unknown; noul?: unknown; choice?: unknown; score?: unknown; legend?: unknown; confidence?: unknown; probabilities?: unknown };
type Receipt = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const two = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "?");
/** A row's string as the timeline makes every row's: its URLs keep their origin, path and query keys, then it is cut. */
const clean = (text: string, max: number) => cut(scrubUrls(text), max);
/** How a host shows a row's text: its held values taken out (`redact`, the run's redactor, applied to a text whole
 *  before any cut), and `hold`, the characters a held value takes in its widest form, held back from the end of a text
 *  that was stored cut, where a value the stored cut split would sit. */
export type Shown = { redact: (text: string) => string; hold: number };

/** A receipt's error was stored cut: marked so, or exactly 2000 characters, where receipts cut it before. */
const storedCut = (receipt: Receipt): boolean => receipt.error_truncated === true || (typeof receipt.error === "string" && receipt.error.length === 2000);

/** How the request ended. A row stored before its status was kept says it by its rule and error: a rule is set only on
 *  an answered request, and an answered one carries no error. Such a row cannot tell a cancelled request from a failed one. */
const statusOf = (receipt: Receipt): unknown => receipt.status ?? (isObject(receipt.rule) && receipt.error === undefined ? "answered" : "failed");

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
  const status = statusOf(receipt);
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

/** The sources the answers rest on, and the questions refused, one per line; null when there are none. An error stored
 *  cut is redacted, then its tail held back, as `shown` says. */
function textOf(receipt: Receipt, shown?: Shown): string | null {
  const lines: string[] = [];
  for (const source of Array.isArray(receipt.evidence) ? receipt.evidence : []) {
    if (!isObject(source) || typeof source.url !== "string") continue;
    lines.push(`${typeof source.title === "string" && source.title ? `${source.title} ` : ""}${source.url}`);
  }
  if (Array.isArray(receipt.refused) && receipt.refused.length) lines.push(`refused: ${receipt.refused.map(String).join(", ")}`);
  if (typeof receipt.error === "string" && receipt.error) {
    const error = shown ? shown.redact(receipt.error) : receipt.error;
    lines.push(shown && storedCut(receipt) ? `${error.slice(0, Math.max(0, error.length - shown.hold))}…` : error);
  }
  return lines.length ? lines.join("\n") : null;
}

/** One `decision` row per receipt, in commit order. Each carries its own cost: unknown stays null, never $0. Its summary
 *  and text are cleaned and cut to `CAPS` as every timeline row's are: a batched sift's answers and a provider's sources
 *  are as long as the receipt, and a source's URL can carry a signed query or credentials. With `shown` (the server's),
 *  each is redacted whole first: a provider's error, a source's title and an answer can quote a held value. */
export function decisionRows(receipts: readonly Receipt[], shown?: Shown): TimelineEvent[] {
  const redact = shown?.redact ?? ((text: string) => text);
  return receipts.map((receipt, place) => {
    const at = typeof receipt.at === "string" ? receipt.at : new Date(0).toISOString();
    const request = isObject(receipt.request) ? receipt.request : {};
    const cost = typeof receipt.cost_usd === "number" && Number.isFinite(receipt.cost_usd) ? receipt.cost_usd : null;
    const text = textOf(receipt, shown);
    return {
      id: `decision:${String(receipt.id ?? place)}:${String(request.index ?? 0)}`,
      timestamp: at, created_at: at, kind: "decision",
      summary: clean(redact(summaryOf(receipt)), CAPS.summary), agent_label: typeof receipt.node === "string" ? redact(receipt.node) : null,
      tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null,
      text: text === null ? null : clean(redact(text), CAPS.text), usage: { usd: cost, requests: 1 },
    };
  });
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** `rows` with the decisions' rows among them by time, and their cost on the run's usage row, which stays last: one
 *  unknown cost makes the total unknown, never a lower figure. `receipts` null: the decisions could not be read, so the
 *  rows are as they were but the usage row's total is unknown, never the model nodes' alone. `ended`: the run has ended,
 *  so its usage row says its cost, never "so far" (costLabel). */
export function withDecisions(rows: readonly TimelineEvent[], receipts: readonly Receipt[] | null, shown?: Shown, { ended = false }: { ended?: boolean } = {}): TimelineEvent[] {
  const label = costLabel(ended);
  if (receipts === null) {
    const at = rows.findLastIndex((row) => row.kind === "usage");
    return rows.map((row, i) => {
      if (i !== at) return row;
      const requests = row.usage?.requests ?? 0;
      return { ...row, summary: `${label}: unknown over ${plural(requests, "model request")}; its decisions could not be read`, usage: { usd: null, requests } };
    });
  }
  if (!receipts.length) return ended ? rows.map(endedUsage) : [...rows];
  const decisions = decisionRows(receipts, shown);
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
  // While the total is unknown: the known charges' sum and how many have no price (costsofar/1), the model row's and the
  // decisions' together; none when the model row says neither.
  const modelsSoFar = models.usd !== null ? { known: models.usd, unpriced: 0 } : models.so_far_usd !== undefined && models.unpriced !== undefined ? { known: models.so_far_usd, unpriced: models.unpriced } : undefined;
  const unpriced = (modelsSoFar?.unpriced ?? 0) + costs.filter((cost) => cost === null).length;
  const soFar = usd === null && modelsSoFar && unpriced > 0 ? { so_far_usd: Math.round((modelsSoFar.known + costs.reduce<number>((a, b) => a + (b ?? 0), 0)) * 1e6) / 1e6, unpriced } : undefined;
  const dollars = (n: number) => (n === 0 ? "$0" : n < 0.0001 ? "<$0.0001" : `$${n.toFixed(4)}`);
  const said = usd !== null ? dollars(usd) : soFar ? `${dollars(soFar.so_far_usd)} known, ${soFar.unpriced} not priced,` : "unknown";
  const summary = `${label}: ${said} over ${plural(models.requests, "model request")} and ${plural(decisions.length, "decision")}`;
  return [...rest, { ...base, kind: "usage", summary, usage: { usd, requests: models.requests + decisions.length, ...(soFar ?? {}) } }];
}
