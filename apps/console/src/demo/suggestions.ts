// Suggested agents in the demo: the sample company's repository, already scanned, with what the scan suggested. Opening,
// creating, discarding and restoring a suggestion, and scanning again, change only this page's memory.
import type { operations } from "@/lib/api.generated";

type Answer<Id extends keyof operations> = operations[Id]["answer"];

type Suggestions = Answer<"listSuggestions">;
type Suggestion = Suggestions["suggestions"][number];
type Detail = Answer<"getSuggestion">;
type Scan = Suggestions["repositories"][number]["scan"];

const REPO = "larkspur/marketplace";
const BASE = `https://github.example/${REPO}`;
const COMMIT = "4f1c2a9d0b7e";
const at = (ms: number) => new Date(ms).toISOString();
const line = (path: string, n: number) => `${BASE}/blob/${COMMIT}/${path}#L${n}`;

type Seed = Omit<Suggestion, "repo" | "status" | "scan" | "decided_at" | "created"> & { files: Detail["files"] };
const SEEDS: Seed[] = [
  {
    id: "sug_demo_dispute_evidence", key: "dispute-evidence", impact: "high",
    title: "Gather a chargeback's evidence",
    summary: "Collect the order, delivery scans and messages a chargeback dispute needs, and say which are missing.",
    why: "disputes/submit.ts builds each dispute's evidence by hand from four services, and the comment above it says half the disputes lost last quarter were missing a delivery scan.",
    evidence: [
      { path: "disputes/submit.ts", line: 42, quote: "// TODO: evidence is assembled by support by hand; missing scans lose disputes", url: line("disputes/submit.ts", 42) },
      { path: "disputes/submit.ts", line: 57, quote: "const evidence = await collectEvidenceManually(dispute.id);", url: line("disputes/submit.ts", 57) },
    ],
    agent: {
      name: "Dispute evidence", description: "Gathers the evidence a chargeback dispute needs and lists what is missing.",
      inputs: [{ name: "dispute_id", type: "string", description: "The dispute to gather evidence for.", required: true }],
      output: [{ name: "missing", type: "string_list", description: "Evidence the dispute still needs." }, { name: "ready", type: "boolean", description: "Whether the dispute can be submitted." }],
      tools: ["web_fetch"], tier: "balanced",
      instructions: "Read the dispute, fetch the order, its delivery scans and the buyer's messages, and list what the card network asks for that is still missing.",
    },
    integration: { language: "typescript", path: "agents/dispute-evidence.ts", call_site: { path: "disputes/submit.ts", line: 57, note: "Replace the hand-built evidence with the agent's answer.", url: line("disputes/submit.ts", 57) } },
    files: [{ path: "agents/dispute-evidence.ts", content: "import { runAgent } from \"@parcha/agentrun\";\n\nexport async function disputeEvidence(disputeId: string) {\n  return runAgent(\"dispute-evidence\", { dispute_id: disputeId });\n}\n" }],
  },
  {
    id: "sug_demo_listing_review", key: "listing-review", impact: "medium",
    title: "Review a new listing against the prohibited-goods policy",
    summary: "Read a new listing's title, photos' alt text and description, and flag the ones the policy forbids.",
    why: "listings/moderation.ts sends every new listing to a review queue that a person clears by hand; most are fine.",
    evidence: [{ path: "listings/moderation.ts", line: 18, quote: "await reviewQueue.push(listing); // every listing, by hand", url: line("listings/moderation.ts", 18) }],
    agent: {
      name: "Listing review", description: "Flags a new listing the prohibited-goods policy forbids, with the line it breaks.",
      inputs: [{ name: "listing_url", type: "string", description: "The listing to review.", required: true }],
      output: [{ name: "verdict", type: "string", description: "allowed, forbidden or unsure.", enum: ["allowed", "forbidden", "unsure"] }],
      tools: ["web_fetch"], tier: "fast",
    },
    integration: { language: "typescript", path: "agents/listing-review.ts", call_site: { path: "listings/moderation.ts", line: 18, note: "Queue only the listings the agent marks forbidden or unsure.", url: line("listings/moderation.ts", 18) } },
    files: [{ path: "agents/listing-review.ts", content: "import { runAgent } from \"@parcha/agentrun\";\n\nexport async function reviewListing(url: string) {\n  return runAgent(\"listing-review\", { listing_url: url });\n}\n" }],
  },
  {
    id: "sug_demo_payout_notes", key: "payout-notes", impact: "low",
    title: "Explain a held payout to the seller",
    summary: "Write the seller a short note on why a payout is held and what clears it.",
    why: "payouts/hold.ts sets a hold reason code, and support answers each \"where is my payout\" ticket by looking it up.",
    evidence: [{ path: "payouts/hold.ts", line: 33, quote: "hold.reason = HoldReason.RiskReview; // seller sees nothing", url: line("payouts/hold.ts", 33) }],
    agent: {
      name: "Payout notes", description: "Writes a seller a plain note on why a payout is held and what clears it.",
      inputs: [{ name: "payout_id", type: "string", description: "The held payout.", required: true }],
      output: [{ name: "note", type: "string", description: "The note to the seller." }],
      tools: [], tier: "fast",
    },
    integration: { language: "typescript", path: "agents/payout-notes.ts", call_site: { path: "payouts/hold.ts", line: 33, note: "Send the agent's note with the hold.", url: line("payouts/hold.ts", 33) } },
    files: [{ path: "agents/payout-notes.ts", content: "import { runAgent } from \"@parcha/agentrun\";\n\nexport async function payoutNote(payoutId: string) {\n  return runAgent(\"payout-notes\", { payout_id: payoutId });\n}\n" }],
  },
];

/** A scan's run, held by the world as any run is: `holdScan` makes it, from `start` for about `ms`, and says when it ends. */
export type HoldScan = (scan: { repo: string; commit: string; start: number; ms: number; found: { path: string; line: number; quote: string; title: string }[] }) => { run_id: string; endsAt: number };

/** The demo's suggestions. `makeAgent` makes the agent a created suggestion becomes, as the world makes any agent; each
 *  scan is a run the world holds (`holdScan`), so the page's link to the scan's run opens it. */
export function createSuggestions({ opened, clock, makeAgent, holdScan }: { opened: number; clock: () => number; makeAgent: (definition: Record<string, unknown>) => { agent_id: string }; holdScan: HoldScan }) {
  const status = new Map<string, { status: Suggestion["status"]; decidedAt: number | null; created: Suggestion["created"] }>();
  const found = SEEDS.map((s) => ({ path: s.evidence[0].path, line: s.evidence[0].line, quote: s.evidence[0].quote, title: s.title }));
  const scanRun = (start: number, ms: number) => holdScan({ repo: REPO, commit: COMMIT, start, ms, found });
  const first = scanRun(opened - 2 * 86_400_000, 4 * 60_000);
  let scan: Scan = { run_id: first.run_id, agent_id: "suggestion-scanner", started_at: at(opened - 2 * 86_400_000), status: "completed", ended_at: at(first.endsAt), app: "larkspur-agentrun", commit: COMMIT, found: SEEDS.length, dropped: [], already_decided: 0, error: null };
  let scanEndsAt: number | null = null;
  let pulls = 2240;

  const scanNow = (): Scan => (scanEndsAt !== null && clock() >= scanEndsAt ? { ...scan, status: "completed", ended_at: at(scanEndsAt), found: SEEDS.length, already_decided: [...status.values()].filter((s) => s.status !== "open").length } : scan);
  const view = (s: Seed): Suggestion => {
    const { files: _files, ...rest } = s;
    const st = status.get(s.id);
    return { ...rest, repo: REPO, status: st?.status ?? "open", scan: { run_id: scan.run_id, commit: COMMIT, at: scan.ended_at ?? scan.started_at }, decided_at: st?.decidedAt ? at(st.decidedAt) : null, created: st?.created ?? null };
  };
  const list = (): Suggestions => {
    const views = SEEDS.map(view);
    const count = (k: Suggestion["status"]) => views.filter((v) => v.status === k).length;
    return {
      github: { connected: true, app: "larkspur-agentrun", installations: [{ account: "larkspur" }], install_url: null },
      repositories: [{ repo: REPO, scan: scanNow(), counts: { open: count("open"), created: count("created"), discarded: count("discarded") } }],
      suggestions: views,
    };
  };
  const detail = (id: string): Detail | null => {
    const s = SEEDS.find((x) => x.id === id);
    if (!s) return null;
    return { ...view(s), files: s.files, problems: [], github: { ready: true, reason: null, message: null, missing: [], install_url: null, permissions_url: null, installation_url: `${BASE}/settings/installations` } };
  };
  const decide = (id: string, to: "discarded" | "open"): Suggestion | null => {
    const s = SEEDS.find((x) => x.id === id);
    if (!s) return null;
    status.set(id, { status: to, decidedAt: to === "open" ? null : clock(), created: null });
    return view(s);
  };
  /** Makes the suggested agent, and opens the pull request that calls it where the scan found the work. */
  const create = (id: string, name?: string): Suggestion | null => {
    const s = SEEDS.find((x) => x.id === id);
    if (!s) return null;
    const was = status.get(id);
    if (was?.status === "created") return view(s);
    const made = makeAgent({ version: 1, name: name?.trim() || s.agent.name, description: s.agent.description, instructions: s.agent.instructions ?? s.summary, tools: s.agent.tools, skills: [] });
    pulls += 1;
    status.set(id, { status: "created", decidedAt: clock(), created: { agent_id: made.agent_id, template_id: `suggested-${s.key}`, branch: `agentrun/${s.key}`, pull_request: { number: pulls, url: `${BASE}/pull/${pulls}` }, pull_error: null } });
    return view(s);
  };
  /** Scans the repository again: the scan runs a few seconds, then finds the same suggestions, those decided kept as they are. */
  const rescan = (repo: string) => {
    if (repo !== REPO) return null;
    const running = scanNow().status === "running";
    if (!running) {
      const run = scanRun(clock(), 6_000);
      scan = { ...scan, run_id: run.run_id, started_at: at(clock()), status: "running", ended_at: null, found: null };
      scanEndsAt = run.endsAt;
    }
    return { repo, run_id: scan.run_id, agent_id: scan.agent_id, status: "running" as const, already_running: running };
  };
  const repositories = (): Answer<"listGitHubRepositories"> => ({ repositories: [{ full_name: REPO, private: true, account: "larkspur", installation: 41_207, default_branch: "main", description: "Larkspur's marketplace: listings, orders, payouts and disputes." }], truncated: false, unread: [] });
  return { list, detail, decide, create, rescan, repositories };
}
