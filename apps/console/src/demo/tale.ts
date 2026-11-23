// The demo's story: Larkspur, an invented marketplace, runs its merchant onboarding and its buyer support on AgentRun.
// Seven agents, a month of their runs, and the handful of runs a tour stops at. Every company, person, address, order
// and figure here is made up; hosts end in `.example`. Nothing is read from the server, and no key or secret is here.
import { batchWorkflow, juryWorkflow, kybWorkflow } from "@/demo/dwf/workflows";
import type { Beat, GateAnswer } from "./script";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const MODELS = { default: "anthropic/claude-sonnet-5-5", fast: "openai/gpt-6-luna", strong: "anthropic/claude-opus-5-5", codex: "openai/gpt-6.1-sol" } as const;

export type DemoAgent = {
  id: string; name: string; description: string; kind: "agentic" | "workflow"; harness: string; model: string;
  instructions?: string; workflow?: unknown; tools: string[]; learning?: boolean; maxCostUsd?: number;
  /** Days ago it was made, and its saved revisions' notes, oldest first. */
  madeDaysAgo: number; notes: (string | null)[];
  /** A connected agent: a Claude Code or Codex setup on a developer's machine, run from here as it is set up there. */
  native?: { runtime: "claude-code" | "codex"; project: string; selector: { kind: "project" } | { kind: "agent"; name: string }; version: string; skills: string[]; mcp: string[] };
  /** What a learning agent holds beyond the Refund desk's full story: its corrections, and a workflow it is checking. */
  learned?: { corrections: string; checking?: { name: string; description: string; readme: string; workflow: object } };
  /** An agent made or edited in the demo: its definitions as saved, oldest first, in place of the story's. */
  saved?: Record<string, unknown>[];
  /** The revision a person made current again, when it is not the latest. */
  current?: number;
  /** When a person archived it. */
  archivedAt?: number;
};

/** The workflow Support triage drafted from its runs, checked against its past tickets before it may answer one alone. */
const TRIAGE_WORKFLOW = {
  v: 2, name: "ticket-triage",
  schemas: {
    Ticket: { type: "object", required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" } } },
    Triage: { type: "object", required: ["queue", "urgency"], properties: { queue: { type: "string" }, urgency: { type: "integer" } } },
  },
  input: { schemaId: "Ticket" }, output: { schemaId: "Triage", path: "triage" },
  root: { node: "chain", steps: [
    { node: "call", label: "read the playbook", tool: "read", args: { path: "playbooks/triage.md" }, as: "playbook" },
    { node: "pick", label: "which queue", from: "playbook.queues", instructions: "Which queue does this ticket belong to, by what the buyer or seller asks for?", as: "queue", none: "hand back" },
    { node: "code", label: "score the urgency", as: "triage" },
  ] },
};
const TRIAGE_README = "# ticket-triage\n\nFiles a ticket under its queue (billing, shipping, account, merchant, abuse) and scores its urgency from the playbook: a chargeback, a locked account or a safety problem is 4 or more.\n\nDrafted from Support triage's runs. It is being checked against past tickets before it answers one alone; the first reply stays with the agent.\n";

export const AGENTS: DemoAgent[] = [
  {
    id: "refund-desk", name: "Refund desk", kind: "agentic", harness: "pi", model: MODELS.default, learning: true, maxCostUsd: 0.5, madeDaysAgo: 41,
    description: "Decides a buyer's refund request against the refund policy and the order's record, then writes to the buyer.",
    instructions: "You decide refund requests for Larkspur's marketplace.\n\n1. Read policies/refunds.md before every decision.\n2. Look the order up: when it was delivered, what was paid, what the carrier recorded.\n3. Decide: full refund, partial refund, return first, or decline. Quote the policy line you applied.\n4. Write the decision to decisions/<request id>.md.\n5. Email the buyer the decision in plain words. Never promise a date the policy does not give.",
    tools: ["read", "write", "web_fetch", "email_send", "ask_person"], notes: [null, "Quote the policy line in every decision", "Cap each run at $0.50"],
  },
  {
    id: "support-triage", name: "Support triage", kind: "agentic", harness: "pi", model: MODELS.fast, madeDaysAgo: 58,
    description: "Reads each new support ticket, files it under a queue with an urgency, and drafts the first reply.",
    instructions: "Triage one support ticket.\n\nPick the queue (billing, shipping, account, merchant, abuse), score urgency 1 to 5, and draft a first reply of at most four sentences. A ticket that mentions a chargeback, a locked account or a safety problem is urgency 4 or more.",
    tools: ["read", "write", "email_draft"], notes: [null, "Chargebacks are urgency 4 or more"], learning: true,
    learned: { corrections: "# Corrections\n\n- A ticket that names a chargeback is urgency 4 or more, whatever its tone.\n- \"Where is my parcel\" under four days since dispatch is urgency 1.\n- Never quote a payout date in the first reply.\n", checking: { name: "ticket-triage", description: "Files a ticket under its queue and scores its urgency from the playbook.", readme: TRIAGE_README, workflow: TRIAGE_WORKFLOW } },
  },
  {
    id: "kyb-check", name: "KYB check", kind: "workflow", harness: "pi", model: MODELS.default, workflow: kybWorkflow, madeDaysAgo: 33,
    description: "Checks a new merchant's certificate of incorporation against the state registry, and routes the unsure ones to a person.",
    tools: [], notes: [null, "Route unsure registry matches to review"],
  },
  {
    id: "certificate-review", name: "Certificate batch review", kind: "workflow", harness: "pi", model: MODELS.default, workflow: batchWorkflow, madeDaysAgo: 27,
    description: "Reads a batch of certificates of incorporation, four at a time: seal, signature, legibility and signs of alteration.",
    tools: [], notes: [null],
  },
  {
    id: "prohibited-goods-jury", name: "Prohibited goods jury", kind: "workflow", harness: "pi", model: MODELS.default, workflow: juryWorkflow, madeDaysAgo: 19,
    description: "Asks four decision models whether a merchant's storefront sells prohibited goods, and escalates when they disagree.",
    tools: [], notes: [null, "Four jurors in place of two"],
  },
  {
    id: "weekly-risk-brief", name: "Weekly risk brief", kind: "agentic", harness: "pi", model: MODELS.strong, madeDaysAgo: 36,
    description: "Once a week: what changed in card-network and marketplace rules, and what Larkspur should do about it.",
    instructions: "Write the weekly risk brief for Larkspur's risk team.\n\nSearch for rule changes from the card networks and consumer regulators in the last seven days. Read the primary source, never a summary of it. Write brief.md: at most five items, each with what changed, who it touches, the date it takes effect, and the source. Save the sources you read to sources.csv. Ask when two primary sources disagree.",
    tools: ["web_search", "web_fetch", "read", "write", "ask_person"], notes: [null, "At most five items", "Ask when primary sources disagree"],
  },
  {
    id: "pr-reviewer", name: "PR reviewer", kind: "agentic", harness: "codex", model: MODELS.codex, maxCostUsd: 1.5, madeDaysAgo: 22,
    description: "Reviews each pull request on the payments service for correctness, and posts one review.",
    instructions: "Review the pull request named in the input on its read-only checkout.\n\nRead the diff, then the code around each change. Try to break each changed function. Report only what you can quote a line for, ranked P0 to P2. Post one review comment.",
    tools: ["read", "bash", "web_fetch"], notes: [null, "Rank findings P0 to P2"], learning: true,
    learned: { corrections: "# Corrections\n\n- A migration that backfills must carry the tenant column: check it first.\n- Do not report style the linter already enforces.\n" },
  },
  // Two connected agents: a developer's own Claude Code and Codex setups, brought into view and run from here.
  {
    id: "architect", name: "Architect", kind: "agentic", harness: "claude-code", model: MODELS.strong, madeDaysAgo: 16,
    description: "Reads a design proposal against the payments service's code and says what it would break, before anyone builds it.",
    instructions: "You are the payments service's architect. For a proposal, name the modules it touches, the invariants it puts at risk (idempotency, ledger balance, tenant isolation), and the smallest change that gets the same result.",
    tools: [], notes: [null], native: { runtime: "claude-code", project: "larkspur/payments-service", selector: { kind: "agent", name: "architect" }, version: "2.1.330", skills: ["adr-writer", "ledger-invariants"], mcp: ["github"] },
  },
  {
    id: "code-reviewer", name: "Code reviewer", kind: "agentic", harness: "codex", model: MODELS.codex, madeDaysAgo: 11,
    description: "Reviews the working tree before a commit: correctness first, with the line behind each finding.",
    instructions: "Review the staged changes. Report only what you can quote a line for.",
    tools: [], notes: [null], native: { runtime: "codex", project: "larkspur/payments-service", selector: { kind: "project" }, version: "0.164.0", skills: ["review"], mcp: [] },
  },
];

/** How a demo run goes: its story as beats (an agent's) or the workflow whose graph it shows, what it cost, and how it
 *  ended. `startAgo`: how long before the demo was opened it started (negative: after). */
export type RunStory = {
  id: string; agent: string; title: string; startAgo: number; input: Record<string, unknown>;
  beats?: Beat[];
  /** A workflow run's graph: which of the sample graphs it shows. */
  graph?: "kyb" | "batch" | "jury";
  usd: number;
  /** The gates' answers, as offsets from the gate's ask. A story with a gate and no answer here waits for the person. */
  answered?: { afterMs: number; text?: string; decision?: "allow" | "deny" }[];
  fails?: { code: "run_failed" | "spend_cap_reached" | "wall_clock_timeout"; message: string };
  review?: { kind: string; node: string; reason: string };
  output?: unknown;
  files?: Record<string, string>;
  trigger?: string;
  effort?: "low" | "medium" | "high";
  /** A learning agent's run: the path it took, and what its learning did after it. */
  path?: "agent" | "workflow" | "handed_back";
  /** The tour stops here: listed under Settings → Demo. */
  hero?: true;
  /** A run stopped at its spend cap: how it ends once a person raises the cap. */
  afterCap?: string;
};

// A small seeded generator, so the month of runs is the same at every load.
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)];
const between = (rng: () => number, lo: number, hi: number) => lo + rng() * (hi - lo);
const money = (n: number) => n.toFixed(2);

// ---- Refund desk ---------------------------------------------------------------------------------------------------

const REFUND_POLICY = `# Refund policy (buyers)

- Refund window: 30 days from delivery.
- Damaged on arrival, with a photo: full refund. No return needed for orders under $250.
- Damaged on arrival, $250 or more: send a prepaid return label first; refund when the carrier scans it.
- Changed mind: return first, refund less the original shipping.
- Not delivered: full refund once the carrier's record shows no delivery scan for 7 days.
- Outside the window: decline, and offer the merchant's own warranty contact.
`;

type RefundCase = { buyer: string; email: string; order: string; item: string; amount: number; said: string; deliveredDaysAgo: number; decision: string; line: string; refund: number | null };
const REFUND_CASES: RefundCase[] = [
  { buyer: "Mara Ellison", email: "mara.ellison@mail.example", order: "LK-77120", item: "countertop blender", amount: 184, said: "The jar arrived cracked. Photo attached.", deliveredDaysAgo: 6, decision: "Full refund, no return", line: "Damaged on arrival, with a photo: full refund. No return needed for orders under $250.", refund: 184 },
  { buyer: "Teodor Vance", email: "t.vance@mail.example", order: "LK-76988", item: "standing desk frame", amount: 412.5, said: "One leg is bent and will not extend.", deliveredDaysAgo: 3, decision: "Return label first, then full refund", line: "Damaged on arrival, $250 or more: send a prepaid return label first; refund when the carrier scans it.", refund: 412.5 },
  { buyer: "Priya Raman", email: "priya.raman@mail.example", order: "LK-77342", item: "wool throw", amount: 68, said: "The colour is not what I expected. I would like to send it back.", deliveredDaysAgo: 11, decision: "Return first, refund less shipping", line: "Changed mind: return first, refund less the original shipping.", refund: 61.05 },
  { buyer: "Jonas Okoro", email: "jonas.okoro@mail.example", order: "LK-75510", item: "espresso grinder", amount: 229, said: "It stopped working after two months.", deliveredDaysAgo: 64, decision: "Declined, outside the window", line: "Outside the window: decline, and offer the merchant's own warranty contact.", refund: null },
  { buyer: "Annika Lindholm", email: "annika.l@mail.example", order: "LK-77411", item: "ceramic planter set", amount: 54, said: "The parcel never came. Tracking has not moved in ten days.", deliveredDaysAgo: -1, decision: "Full refund, not delivered", line: "Not delivered: full refund once the carrier's record shows no delivery scan for 7 days.", refund: 54 },
  { buyer: "Rafael Montes", email: "r.montes@mail.example", order: "LK-77203", item: "trail running shoes", amount: 139, said: "Wrong size sent. I ordered a 10 and got an 8.", deliveredDaysAgo: 4, decision: "Full refund, no return", line: "Damaged on arrival, with a photo: full refund. No return needed for orders under $250.", refund: 139 },
  { buyer: "Hye-jin Park", email: "hyejin.park@mail.example", order: "LK-77067", item: "cast iron skillet", amount: 47.5, said: "The handle has a hairline crack. Photo attached.", deliveredDaysAgo: 2, decision: "Full refund, no return", line: "Damaged on arrival, with a photo: full refund. No return needed for orders under $250.", refund: 47.5 },
  { buyer: "Calum Reyes", email: "calum.reyes@mail.example", order: "LK-76820", item: "bookshelf speaker pair", amount: 318, said: "One speaker buzzes at any volume.", deliveredDaysAgo: 9, decision: "Return label first, then full refund", line: "Damaged on arrival, $250 or more: send a prepaid return label first; refund when the carrier scans it.", refund: 318 },
];

const orderRecord = (c: RefundCase) => JSON.stringify({ order: c.order, item: c.item, paid_usd: c.amount, carrier: "Northline Parcel", delivered: c.deliveredDaysAgo < 0 ? null : `${c.deliveredDaysAgo} days ago`, last_scan: c.deliveredDaysAgo < 0 ? "Departed sort facility, 10 days ago" : "Delivered, signed at door", photo_attached: /photo/i.test(c.said) });
const refundEmail = (c: RefundCase) => ({ to: c.email, subject: `Your refund request for order ${c.order}`, body: c.refund === null ? `Hi ${c.buyer.split(" ")[0]}, thank you for writing. Order ${c.order} was delivered ${c.deliveredDaysAgo} days ago, which is outside our 30-day refund window, so we can't refund it. The merchant's warranty may still cover it; their contact is on your order page.` : `Hi ${c.buyer.split(" ")[0]}, we're sorry about the ${c.item}. ${c.decision.startsWith("Return") ? "We've sent a prepaid return label to this address; your refund" : "Your refund"} of $${money(c.refund)} goes back to your original payment method${c.decision.startsWith("Return") ? " once the carrier scans the parcel" : ""}.` });
const refundNote = (c: RefundCase, id: string) => `# ${id}: ${c.decision}\n\n- Buyer: ${c.buyer}\n- Order: ${c.order} (${c.item}), $${money(c.amount)}\n- Buyer said: "${c.said}"\n- Order record: ${c.deliveredDaysAgo < 0 ? "no delivery scan for 10 days" : `delivered ${c.deliveredDaysAgo} days ago`}\n- Policy line applied: "${c.line}"\n- Refund: ${c.refund === null ? "none" : `$${money(c.refund)}`}\n`;

/** A refund decided by the agent, step by step: the costly path, before the agent's learned workflow took it over. */
export function refundByAgent(c: RefundCase, id: string): Beat[] {
  return [
    { k: "user", text: `Refund request ${id}: ${c.buyer} asks for $${money(c.amount)} back on order ${c.order} (${c.item}). "${c.said}"` },
    { k: "think", text: "I need the refund policy and this order's delivery record before I decide anything." },
    { k: "tool", tool: "read", label: "Read policies/refunds.md", input: "policies/refunds.md", result: REFUND_POLICY, ms: 300 },
    { k: "tool", tool: "web_fetch", label: `Fetched orders.larkspur.example/orders/${c.order}`, input: `https://orders.larkspur.example/orders/${c.order}`, result: orderRecord(c), ms: 1400 },
    { k: "think", text: `${c.deliveredDaysAgo < 0 ? "There is no delivery scan, and the last movement was ten days ago" : `It was delivered ${c.deliveredDaysAgo} days ago`}. The line that applies: "${c.line}"` },
    { k: "say", text: `Decision: ${c.decision}. Writing it down, then telling the buyer.` },
    { k: "tool", tool: "write", label: `Wrote decisions/${id}.md`, input: `decisions/${id}.md`, result: `Successfully wrote decisions/${id}.md`, ms: 250, saved: `decisions/${id}.md` },
    { k: "approval", tool: "email_send", label: `Send email to ${c.email}`, args: refundEmail(c), because: "email_send is set to ask: this agent emails buyers only with your OK", result: `Sent to ${c.email}.`, denied: "The owner declined this call. The email was not sent.", price: "not metered" },
    { k: "final", text: `${c.decision} for ${c.buyer} on order ${c.order}${c.refund === null ? "" : `: $${money(c.refund)}`}. The buyer has the decision by email, and the note is in decisions/${id}.md.`, declined: `${c.decision} for ${c.buyer} on order ${c.order}. You declined the email, so the buyer has not been told. The note is in decisions/${id}.md.` },
  ];
}

/** The same refund once the agent's learned workflow serves it: one call runs the steps, with no model in most of them. */
export function refundByWorkflow(c: RefundCase, id: string): Beat[] {
  return [
    { k: "user", text: `Refund request ${id}: ${c.buyer} asks for $${money(c.amount)} back on order ${c.order} (${c.item}). "${c.said}"` },
    {
      k: "tool", tool: "learned_workflow", label: "Ran the learned workflow refund-decision", input: "refund-decision", ms: 2600, saved: `decisions/${id}.md`,
      result: JSON.stringify({ decision: c.decision, policy_line: c.line, refund_usd: c.refund, note: `decisions/${id}.md` }),
      nodes: [
        { label: "read the policy", kind: "call", status: "ok", duration_ms: 12 },
        { label: "look the order up", kind: "call", status: "ok", duration_ms: 940 },
        { label: "which policy line applies", kind: "pick", status: "ok", duration_ms: 610, model: "jev", tier: "fast" },
        { label: "work out the refund", kind: "code", status: "ok", duration_ms: 3 },
        { label: "write the decision note", kind: "call", status: "ok", duration_ms: 18 },
        { label: "draft the email", kind: "extract", status: "ok", duration_ms: 980, model: MODELS.fast.split("/")[1], tier: "fast" },
      ],
    },
    { k: "approval", tool: "email_send", label: `Send email to ${c.email}`, args: refundEmail(c), because: "email_send is set to ask: this agent emails buyers only with your OK", result: `Sent to ${c.email}.`, denied: "The owner declined this call. The email was not sent.", price: "not metered" },
    { k: "final", text: `${c.decision} for ${c.buyer} on order ${c.order}${c.refund === null ? "" : `: $${money(c.refund)}`}. The buyer has the decision by email, and the note is in decisions/${id}.md.`, declined: `${c.decision} for ${c.buyer} on order ${c.order}. You declined the email, so the buyer has not been told. The note is in decisions/${id}.md.` },
  ];
}

export const REFUND_WORKFLOW = {
  v: 2, name: "refund-decision",
  schemas: {
    Request: { type: "object", required: ["order", "said"], properties: { order: { type: "string" }, said: { type: "string" } } },
    Decision: { type: "object", required: ["decision", "policy_line", "refund_usd"], properties: { decision: { type: "string" }, policy_line: { type: "string" }, refund_usd: { type: ["number", "null"] } } },
  },
  input: { schemaId: "Request" }, output: { schemaId: "Decision", path: "decision" },
  root: { node: "chain", steps: [
    { node: "call", label: "read the policy", tool: "read", args: { path: "policies/refunds.md" }, as: "policy" },
    { node: "call", label: "look the order up", tool: "web_fetch", args: { url: "https://orders.larkspur.example/orders/${input.order}" }, as: "order" },
    { node: "pick", label: "which policy line applies", from: "policy.lines", instructions: "Which line of the refund policy covers what the buyer said, given the order's record?", as: "line", none: "hand back" },
    { node: "code", label: "work out the refund", as: "decision" },
    { node: "call", label: "write the decision note", tool: "write", as: "note" },
    { node: "extract", label: "draft the email", instructions: "Tell the buyer the decision in plain words. Promise no date the policy does not give.", out: "Decision", as: "email", tier: "fast" },
  ] },
};

// ---- Support triage ------------------------------------------------------------------------------------------------

type Ticket = { subject: string; body: string; queue: string; urgency: number; reply: string };
const TICKETS: Ticket[] = [
  { subject: "Charged twice for one order", body: "My card shows two charges of $62.40 for order LK-77290. Please fix this.", queue: "billing", urgency: 3, reply: "Thanks for flagging this. One of the two charges is a pending authorisation that drops off within three business days; if it settles, we refund it the same day." },
  { subject: "Chargeback notice on my shop", body: "I got a chargeback notice for $480 and my payout is on hold. I shipped this order with tracking.", queue: "merchant", urgency: 4, reply: "We've opened the dispute for you. Upload the tracking record and the delivery confirmation from your orders page, and your payout is released as soon as the network accepts them." },
  { subject: "Can't log in after phone change", body: "I changed my number and the code goes to the old one. Locked out since yesterday.", queue: "account", urgency: 4, reply: "We can move your sign-in to the new number after a quick identity check. Reply with the last four digits of the card on your account and the postcode of your delivery address." },
  { subject: "Where is my parcel?", body: "Order LK-77018 says out for delivery for four days now.", queue: "shipping", urgency: 2, reply: "The carrier's last scan was at the local depot four days ago. We've asked them to trace it; if it has not moved in three more days we refund you in full." },
  { subject: "Listing looks like a counterfeit", body: "This shop sells 'designer' bags at $30. Pretty sure they are fake.", queue: "abuse", urgency: 4, reply: "Thank you for reporting this. Our trust team is reviewing the shop today, and the listing is hidden while they do." },
  { subject: "Invoice for my accountant", body: "Can I get a VAT invoice for order LK-76455?", queue: "billing", urgency: 1, reply: "Of course. Your VAT invoice is on the order's page under Documents, and we've emailed you a copy as well." },
  { subject: "Payout schedule question", body: "When do weekly payouts land? New seller here.", queue: "merchant", urgency: 1, reply: "Welcome! Weekly payouts leave every Tuesday for sales cleared up to the Sunday before, and land in one to two business days." },
  { subject: "Item smells of smoke", body: "The jacket I bought reeks of cigarette smoke. Listed as new.", queue: "shipping", urgency: 2, reply: "That's not what 'new' means, and we're sorry. You can open a refund request from the order's page; with a short note like this one it is approved without a return." },
];

export function triageBeats(t: Ticket, n: number): Beat[] {
  return [
    { k: "user", text: `Ticket #${n}: ${t.subject}\n\n${t.body}` },
    { k: "tool", tool: "read", label: "Read playbooks/queues.md", input: "playbooks/queues.md", result: "billing: charges, invoices, refunds already decided\nshipping: where is it, wrong or damaged item\naccount: sign-in, profile, deletion\nmerchant: payouts, chargebacks, listings\nabuse: counterfeit, fraud, safety\n\nUrgency 4 or more: a chargeback, a locked account, a safety problem.", ms: 200 },
    { k: "say", text: `Queue: ${t.queue}. Urgency: ${t.urgency} of 5.` },
    { k: "tool", tool: "email_draft", label: "Saved a draft reply", input: t.subject, result: `Draft saved: "Re: ${t.subject}"`, ms: 500 },
    { k: "final", text: `Filed under ${t.queue}, urgency ${t.urgency}. Draft reply: "${t.reply}"` },
  ];
}

// ---- Weekly risk brief ---------------------------------------------------------------------------------------------

export const BRIEF_MD = `# Weekly risk brief

Five changes that touch Larkspur this week.

## 1. Dispute response window shortens to 9 days
- **What changed:** the card network's acquirer bulletin cuts the time to answer a first chargeback from 20 days to 9.
- **Who it touches:** every merchant with an open dispute; our dispute desk's queue.
- **Takes effect:** the first of next quarter.
- **What to do:** move the reminder email from day 10 to day 3, and auto-attach tracking records.
- **Source:** cardnetwork.example/bulletins/2026-41

## 2. Marketplace seller identity checks: annual re-verification
- **What changed:** the consumer regulator's final rule asks marketplaces to re-verify high-volume sellers once a year.
- **Who it touches:** about 1,900 of our merchants (over 200 sales a year).
- **Takes effect:** in six months.
- **What to do:** schedule the KYB check agent to re-run each merchant on the anniversary of onboarding.
- **Source:** regulator.example/rules/marketplace-sellers-final

## 3. Bear spray added to the restricted-shipping list in two more states
- **What changed:** two states now bar mail-order sale of deterrent sprays over 4 oz.
- **Who it touches:** 14 outdoor-gear merchants.
- **Takes effect:** already in force.
- **What to do:** add both states to the prohibited goods jury's rules; re-run the 14 storefronts.
- **Source:** statecode.example/title-12/ch-7

## 4. Refund timing disclosure
- **What changed:** guidance says a refund email must not name a date unless the policy guarantees it.
- **Who it touches:** the Refund desk agent's emails.
- **Takes effect:** guidance, in force now.
- **What to do:** nothing new. The agent's instructions already say "never promise a date the policy does not give".
- **Source:** regulator.example/guidance/refund-communications

## 5. Fraud score threshold for manual review
- **What changed:** the network recommends manual review above a fraud score of 72, down from 80.
- **Who it touches:** payout holds; about 3% more orders a week would be held.
- **Takes effect:** recommendation only.
- **What to do:** decide at Thursday's risk review; no change this week.
- **Source:** cardnetwork.example/bulletins/2026-39
`;
export const SOURCES_CSV = `url,title,read_at,used_in\ncardnetwork.example/bulletins/2026-41,Dispute timeframes update,08:02,1\nregulator.example/rules/marketplace-sellers-final,Marketplace seller verification: final rule,08:03,2\nstatecode.example/title-12/ch-7,Deterrent sprays: mail-order sales,08:05,3\nregulator.example/guidance/refund-communications,Refund communications guidance,08:06,4\ncardnetwork.example/bulletins/2026-39,Fraud score guidance,08:07,5\n`;

const BRIEF_OPENING: Beat[] = [
  { k: "user", text: "Write this week's risk brief." },
  { k: "think", text: "I'll look for rule changes from the card networks and the consumer regulator in the last seven days, and read each primary source myself." },
  { k: "tool", tool: "web_search", label: "Searched the web for \"card network acquirer bulletin dispute timeframe change\"", input: "card network acquirer bulletin dispute timeframe change", result: JSON.stringify({ results: [{ url: "https://cardnetwork.example/bulletins/2026-41", title: "Dispute timeframes update" }, { url: "https://paymentsweekly.example/news/dispute-window", title: "Networks shorten dispute windows" }] }), ms: 1500 },
  { k: "tool", tool: "web_fetch", label: "Fetched cardnetwork.example/bulletins/2026-41", input: "https://cardnetwork.example/bulletins/2026-41", result: "Bulletin 2026-41. Effective the first day of next quarter, acquirers must respond to a first chargeback within 9 calendar days (previously 20)…", ms: 1900 },
  { k: "tool", tool: "web_search", label: "Searched the web for \"marketplace seller verification final rule\"", input: "marketplace seller verification final rule", result: JSON.stringify({ results: [{ url: "https://regulator.example/rules/marketplace-sellers-final", title: "Marketplace seller verification: final rule" }] }), ms: 1300 },
  { k: "tool", tool: "web_fetch", label: "Fetched regulator.example/rules/marketplace-sellers-final", input: "https://regulator.example/rules/marketplace-sellers-final", result: "Final rule. Online marketplaces must re-verify the identity of each high-volume third-party seller at least annually…", ms: 2100 },
  { k: "tool", tool: "web_fetch", label: "Fetched paymentsweekly.example/news/dispute-window", input: "https://paymentsweekly.example/news/dispute-window", result: "…sources say the new 9-day window applies from the first of the month after next, a month later than the bulletin's date…", ms: 1700 },
];
const BRIEF_QUESTION = "The network's bulletin says the 9-day dispute window starts on the first of next quarter; a trade article says a month later. Which date should the brief give?";
const BRIEF_CLOSING: Beat[] = [
  { k: "think", text: "The bulletin is the primary source, so its date goes in, with the source beside it." },
  { k: "tool", tool: "web_fetch", label: "Fetched statecode.example/title-12/ch-7", input: "https://statecode.example/title-12/ch-7", result: "Chapter 7. Deterrent sprays exceeding 4 ounces may not be sold by mail order to an address in this state…", ms: 1600 },
  { k: "tool", tool: "write", label: "Wrote brief.md", input: "brief.md", result: "Successfully wrote brief.md", ms: 300, saved: "brief.md" },
  { k: "tool", tool: "write", label: "Wrote sources.csv", input: "sources.csv", result: "Successfully wrote sources.csv", ms: 200, saved: "sources.csv" },
  { k: "final", text: "This week's brief is in brief.md: five items, led by the dispute response window shortening to 9 days from next quarter. The sources I read are in sources.csv." },
];
export const briefBeats = (): Beat[] => [...BRIEF_OPENING, { k: "ask", question: BRIEF_QUESTION }, ...BRIEF_CLOSING];

// ---- PR reviewer ---------------------------------------------------------------------------------------------------

type Pull = { n: number; title: string; verdict: string; findings: string };
const PULLS: Pull[] = [
  { n: 2184, title: "Retry payout webhooks with backoff", verdict: "1 P1, 1 P2", findings: "P1 payouts/retry.ts:48: the backoff doubles from 0, so every retry fires at once. P2 the new test never advances its fake clock." },
  { n: 2191, title: "Add idempotency keys to refund endpoint", verdict: "No findings", findings: "The key is checked before the ledger write, and a replay returns the first answer. I tried a concurrent pair and a key reused with another body; both hold." },
  { n: 2197, title: "Migrate dispute table to partitioned storage", verdict: "1 P0", findings: "P0 migrations/0412.sql:31: the backfill copies rows without the tenant column, so every dispute lands in the default partition." },
  { n: 2203, title: "Round currency amounts at the ledger boundary", verdict: "1 P2", findings: "P2 ledger/round.ts:12: half-even rounding is right for USD, but JPY has no minor unit and still gets two decimal places." },
];
export function reviewBeats(p: Pull): Beat[] {
  return [
    { k: "user", text: `Review pull request #${p.n}: ${p.title}` },
    { k: "tool", tool: "bash", label: `Ran git diff origin/main...pr-${p.n} --stat`, input: `git diff origin/main...pr-${p.n} --stat`, result: " 6 files changed, 214 insertions(+), 38 deletions(-)", ms: 700 },
    { k: "tool", tool: "bash", label: `Ran git diff origin/main...pr-${p.n}`, input: `git diff origin/main...pr-${p.n}`, result: "diff --git a/payouts/retry.ts b/payouts/retry.ts\n…", ms: 900 },
    { k: "think", text: "I'll read the code around each change, then try to break each changed function with an input the tests do not cover." },
    { k: "tool", tool: "bash", label: "Ran npm test -- --run changed", input: "npm test -- --run changed", result: "Test Files  4 passed (4)\n     Tests  31 passed (31)", ms: 4200 },
    { k: "final", text: `PR #${p.n} (${p.title}): ${p.verdict}. ${p.findings}` },
  ];
}
const REVIEW_CAPPED: Beat[] = [
  { k: "user", text: "Review pull request #2210: Rewrite settlement batching (4,100 changed lines)" },
  { k: "tool", tool: "bash", label: "Ran git diff origin/main...pr-2210 --stat", input: "git diff origin/main...pr-2210 --stat", result: " 58 files changed, 2903 insertions(+), 1197 deletions(-)", ms: 800 },
  { k: "think", text: "This is a large change. I'll take the settlement core first, then the callers." },
  { k: "tool", tool: "bash", label: "Ran git diff origin/main...pr-2210 -- settlement/", input: "git diff origin/main...pr-2210 -- settlement/", result: "diff --git a/settlement/batch.ts b/settlement/batch.ts\n…", ms: 1300 },
  { k: "tool", tool: "bash", label: "Ran npm test -- --run settlement", input: "npm test -- --run settlement", result: "Test Files  11 passed (11)\n     Tests  142 passed (142)", ms: 6100 },
  { k: "error", text: "The run reached its spend cap of $1.50 before it finished. Nothing was posted to the pull request." },
];

// ---- The connected agents -----------------------------------------------------------------------------------------

const PROPOSALS = [
  { ask: "Proposal: move refunds to an async queue so the API answers in under 100 ms.", says: "It touches refunds/api.ts, ledger/post.ts and the webhook sender. At risk: idempotency (a retried request would enqueue twice) and the ledger's balance between enqueue and post. Smallest change: keep the ledger write in the request, and queue only the processor call and the email." },
  { ask: "Proposal: one database per tenant for the dispute tables.", says: "It touches every dispute query and the nightly settlement job. At risk: cross-tenant reports, which join disputes to payouts. Smallest change: partition the two largest tables by tenant and leave the rest; that gets the isolation without 400 connection pools." },
  { ask: "Proposal: replace the cron-based payout batcher with event-driven payouts.", says: "It touches payouts/batch.ts and the bank file writer. At risk: the bank's cut-off, which the batcher meets by construction. Smallest change: keep the batch at the cut-off and send events for status only." },
];
export function architectBeats(p: (typeof PROPOSALS)[number]): Beat[] {
  return [
    { k: "user", text: p.ask },
    { k: "tool", tool: "Grep", label: "Searched the code for the modules the proposal names", input: "refund|ledger|payout", result: "refunds/api.ts\nledger/post.ts\npayouts/batch.ts\nwebhooks/send.ts", ms: 800 },
    { k: "tool", tool: "Read", label: "Read docs/adr/0007-ledger-invariants.md", input: "docs/adr/0007-ledger-invariants.md", result: "Every money movement is one ledger transaction, written before the caller is answered…", ms: 400 },
    { k: "think", text: "The proposal's speed-up comes from one slow call. The invariants only need the ledger write to stay where it is." },
    { k: "final", text: p.says },
  ];
}
export function workingTreeReviewBeats(p: Pull): Beat[] {
  return [
    { k: "user", text: `Review my staged changes: ${p.title}` },
    { k: "tool", tool: "shell", label: "Ran git diff --staged", input: "git diff --staged", result: "diff --git a/ledger/round.ts b/ledger/round.ts\n…", ms: 500 },
    { k: "tool", tool: "shell", label: "Ran npm test -- --run changed", input: "npm test -- --run changed", result: "Test Files  3 passed (3)", ms: 3100 },
    { k: "final", text: `${p.verdict}. ${p.findings}` },
  ];
}

// ---- The month of runs ---------------------------------------------------------------------------------------------

const KYB_REVIEW = { kind: "review", node: "route", reason: "The certificate's filing date and the registry's formation date do not agree, so the route was unsure and sent the merchant to a person." };
const JURY_REVIEW = { kind: "review", node: "route", reason: "The jurors did not agree on whether the storefront sells restricted goods." };
const BATCH_REVIEW = { kind: "review", node: "report", reason: "One certificate's check was interrupted, so its outcome is unknown and a person reads it." };

/** When the Refund desk's learned workflow began to serve its runs. */
export const TAKEOVER_DAYS_AGO = 12;

/** The runs the tour stops at, each in a state worth seeing; the month's other runs are made by `history`. */
export function heroes(): RunStory[] {
  const mara = REFUND_CASES[0];
  return [
    { id: "demo-run-refund-approval", agent: "refund-desk", title: "Refund request R-48213: Mara Ellison", startAgo: 14 * MIN, input: { content: `Refund request R-48213: ${mara.buyer}` }, beats: refundByWorkflow(mara, "R-48213"), usd: 0.0214, path: "workflow", trigger: "trg-demo-helpdesk-refunds", hero: true, files: { "decisions/R-48213.md": refundNote(mara, "R-48213") } },
    { id: "demo-run-brief-question", agent: "weekly-risk-brief", title: "Write this week's risk brief", startAgo: 47 * MIN, input: { content: "Write this week's risk brief." }, beats: briefBeats(), usd: 0.412, effort: "high", trigger: "trg-demo-weekly-brief", hero: true, files: { "brief.md": BRIEF_MD, "sources.csv": SOURCES_CSV } },
    { id: "demo-run-certificates-live", agent: "certificate-review", title: "Certificates: 20 new merchants", startAgo: 6_000, input: { documents: ["bramblewood-freight.pdf", "corvane-analytics.pdf", "…18 more"] }, graph: "batch", usd: 0.0931, review: BATCH_REVIEW, hero: true },
    { id: "demo-run-triage-live", agent: "support-triage", title: `Ticket #5512: ${TICKETS[1].subject}`, startAgo: 1_500, input: { content: TICKETS[1].subject }, beats: triageBeats(TICKETS[1], 5512).map((b) => ({ ...b, wait: (b.wait ?? 0) + 2600 })), usd: 0.0094, trigger: "trg-demo-helpdesk-tickets", hero: true },
    { id: "demo-run-review-capped", agent: "pr-reviewer", title: "Review PR #2210: Rewrite settlement batching", startAgo: 3 * HOUR + 12 * MIN, input: { content: "Review pull request #2210" }, beats: REVIEW_CAPPED, usd: 1.5, fails: { code: "spend_cap_reached", message: "The run reached its spend cap of $1.50 before it finished." }, afterCap: "Reviewed PR #2210. The settlement core is sound and its 142 tests pass. Two things to fix before merge: batch.ts retries a failed settlement without its idempotency key, and the new cut-off check reads the server's clock, not the bank's. Posted 2 review comments.", trigger: "trg-demo-pull-requests", hero: true },
    { id: "demo-run-kyb-review", agent: "kyb-check", title: "KYB: Corvane Analytics Inc.", startAgo: 2 * HOUR + 40 * MIN, input: { merchant: "Corvane Analytics Inc.", document: "corvane-analytics.pdf" }, graph: "kyb", usd: 0.0473, review: KYB_REVIEW, hero: true },
    { id: "demo-run-jury", agent: "prohibited-goods-jury", title: "Storefront: Saltmarsh Outdoor Gear Co.", startAgo: 5 * HOUR + 5 * MIN, input: { merchant: "Saltmarsh Outdoor Gear Co.", url: "https://saltmarsh-outdoor.example" }, graph: "jury", usd: 0.0188, review: JURY_REVIEW, hero: true },
    { id: "demo-run-brief-done", agent: "weekly-risk-brief", title: "Write this week's risk brief", startAgo: 7 * DAY + 47 * MIN, input: { content: "Write this week's risk brief." }, beats: briefBeats(), usd: 0.438, effort: "high", answered: [{ afterMs: 9 * MIN, text: "Use the bulletin's date. It is the primary source." }], trigger: "trg-demo-weekly-brief", files: { "brief.md": BRIEF_MD, "sources.csv": SOURCES_CSV }, hero: true },
    { id: "demo-run-refund-by-agent", agent: "refund-desk", title: "Refund request R-47391: Teodor Vance", startAgo: 19 * DAY + 3 * HOUR, input: { content: "Refund request R-47391: Teodor Vance" }, beats: refundByAgent(REFUND_CASES[1], "R-47391"), usd: 0.2082, path: "agent", answered: [{ afterMs: 6 * MIN, decision: "allow" }], files: { "decisions/R-47391.md": refundNote(REFUND_CASES[1], "R-47391") }, hero: true },
  ];
}

/** The month's other runs: what each agent did day by day, the same at every load. Newest first is the backend's order;
 *  these come oldest first. */
export function history(opened: number, days = 30): RunStory[] {
  const rng = seeded(4757);
  const out: RunStory[] = [];
  let ticket = 4100;
  let refund = 46800;
  let n = 0;
  const id = () => `demo-run-${String(++n).padStart(4, "0")}`;
  for (let d = days; d >= 0; d--) {
    // Weekends are quiet; today has only its first hours.
    const worksOn = (ms: number) => { const dow = new Date(ms).getUTCDay(); return dow >= 1 && dow <= 5; };
    const weekday = worksOn(opened - d * DAY);
    const scale = (weekday ? 1 : 0.35) * (d === 0 ? 0.3 : 1);
    const at = () => d * DAY - Math.floor(between(rng, d === 0 ? 0.5 * HOUR : 0, d === 0 ? 7 * HOUR : 23 * HOUR)) + (d === 0 ? 8 * HOUR : 0);
    for (let i = 0; i < Math.round(between(rng, 14, 24) * scale); i++) {
      const t = pick(rng, TICKETS);
      out.push({ id: id(), agent: "support-triage", title: `Ticket #${++ticket}: ${t.subject}`, startAgo: at(), input: { content: t.subject }, beats: triageBeats(t, ticket), usd: between(rng, 0.006, 0.013), trigger: "trg-demo-helpdesk-tickets" });
    }
    for (let i = 0; i < Math.round(between(rng, 5, 10) * scale); i++) {
      const c = pick(rng, REFUND_CASES);
      const rid = `R-${++refund}`;
      // Before the takeover the agent decides each refund itself; after it, the learned workflow does, and now and then
      // hands one back (a request the policy's lines do not cover) for the agent to finish.
      const served = d < TAKEOVER_DAYS_AGO;
      const path = !served ? "agent" : rng() < 0.08 ? "handed_back" : "workflow";
      out.push({ id: id(), agent: "refund-desk", title: `Refund request ${rid}: ${c.buyer}`, startAgo: at(), input: { content: `Refund request ${rid}: ${c.buyer}` }, beats: path === "workflow" ? refundByWorkflow(c, rid) : refundByAgent(c, rid), usd: path === "workflow" ? between(rng, 0.017, 0.027) : path === "handed_back" ? between(rng, 0.12, 0.16) : between(rng, 0.17, 0.24), path, answered: [{ afterMs: between(rng, 1, 14) * MIN, decision: rng() < 0.04 ? "deny" : "allow" }], trigger: "trg-demo-helpdesk-refunds" });
    }
    for (let i = 0; i < Math.round(between(rng, 3, 6) * scale); i++) {
      // Most merchants pass; about one in eight has a registry record and a certificate that do not agree.
      const review = rng() < 0.12;
      const merchant = pick(rng, MERCHANTS);
      out.push({ id: id(), agent: "kyb-check", title: `KYB: ${merchant}`, startAgo: at(), input: { merchant }, graph: "kyb", usd: between(rng, 0.016, 0.018), ...(review ? { review: KYB_REVIEW } : {}) });
    }
    // The jury sits only for the storefronts a cheaper screen flags, and a split jury always goes to a person.
    if (rng() < 0.4 * scale) {
      const merchant = pick(rng, MERCHANTS);
      out.push({ id: id(), agent: "prohibited-goods-jury", title: `Storefront: ${merchant}`, startAgo: at(), input: { merchant }, graph: "jury", usd: between(rng, 0.015, 0.022), review: JURY_REVIEW });
    }
    // The certificates' schedule fires on weekdays, nine hours on from this time of day.
    if (d > 0 && worksOn(opened - d * DAY + 9 * HOUR)) out.push({ id: id(), agent: "certificate-review", title: `Certificates: ${Math.round(between(rng, 8, 20))} new merchants`, startAgo: d * DAY - 9 * HOUR, input: { documents: ["…"] }, graph: "batch", usd: 0, review: BATCH_REVIEW, trigger: "trg-demo-weekday-certificates" });
    if (weekday && d > 0) {
      for (let i = 0; i < Math.round(between(rng, 2, 5)); i++) {
        const p = pick(rng, PULLS);
        const failed = rng() < 0.05;
        out.push({ id: id(), agent: "pr-reviewer", title: `Review PR #${p.n - d * 7 - i}: ${p.title}`, startAgo: at(), input: { content: `Review pull request #${p.n}` }, beats: reviewBeats(p), usd: between(rng, 0.31, 0.92), trigger: "trg-demo-pull-requests", ...(failed ? { fails: { code: "run_failed" as const, message: "The checkout of the pull request's branch failed: the branch was deleted." } } : {}) });
      }
    }
    // The connected agents run when their developer asks: a few times a week.
    if (weekday && d < 16 && rng() < 0.45) { const p = pick(rng, PROPOSALS); out.push({ id: id(), agent: "architect", title: `Design review: ${p.ask.slice("Proposal: ".length).replace(/\.$/, "")}`, startAgo: at(), input: { content: p.ask }, beats: architectBeats(p), usd: between(rng, 0.22, 0.41) }); }
    if (weekday && d < 11) for (let i = 0; i < Math.round(between(rng, 0, 3)); i++) { const p = pick(rng, PULLS); out.push({ id: id(), agent: "code-reviewer", title: `Review staged changes: ${p.title}`, startAgo: at(), input: { content: p.title }, beats: workingTreeReviewBeats(p), usd: between(rng, 0.09, 0.2) }); }
    // The brief runs once a week; last week's is a hero, today's waits for its answer.
    if (d % 7 === 0 && d > 7) out.push({ id: id(), agent: "weekly-risk-brief", title: "Write this week's risk brief", startAgo: d * DAY + 47 * MIN, input: { content: "Write this week's risk brief." }, beats: briefBeats(), usd: between(rng, 0.38, 0.47), effort: "high", answered: [{ afterMs: between(rng, 4, 40) * MIN, text: "Use the primary source's date." }], trigger: "trg-demo-weekly-brief", files: { "brief.md": BRIEF_MD, "sources.csv": SOURCES_CSV } });
  }
  return out;
}

const MERCHANTS = ["Bramblewood Freight LLC", "Corvane Analytics Inc.", "Duskridge Holdings Ltd.", "Ellery & Thorn Supply Co.", "Fenwhistle Robotics Inc.", "Glasswing Ceramics LLC", "Harrowgate Logistics Corp.", "Saltmarsh Outdoor Gear Co.", "Tidewater Print Works", "Quillfeather Stationery Ltd."];

export type { GateAnswer };

// ---- What the Refund desk learned ----------------------------------------------------------------------------------

export const CORRECTIONS_MD = `# Corrections

- Quote the policy line you applied, word for word, in the decision note.
- "Wrong item sent" counts as damaged on arrival: full refund, no return under $250.
- Never name a refund date in the email. Say "to your original payment method".
- When the carrier's record has no delivery scan, check the last movement's age before deciding.
`;
export const LEARNED_README = `# refund-decision

Decides a buyer's refund request the way the agent did in its first 140 runs: read the policy, look the order up, pick
the policy line that applies, work the refund out in code, write the note, and draft the email.

Hands back to the agent when no policy line fits what the buyer said.
`;
