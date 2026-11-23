// A faux model for the agent-scout package's agent: it answers the repository the run's first message names with two
// suggestions (a TypeScript one and a Python one) and a third whose client path is under .github/, which the server's
// check drops, as one fenced json block that meets the package's schema. Its `commit` is the one the checkout line in its
// system prompt names (the server's checkout of the repository), else empty.
const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");

const INSTRUCTIONS = "You triage support tickets for the help desk of this app. Each run gives one ticket: its subject and its body, as the customer wrote them. Decide its category (billing, bug, how-to, account or other) and its priority: urgent when the customer cannot use the product or was charged wrongly, high when a feature is broken, normal otherwise. Never invent facts the ticket does not state; when unsure, choose the cautious value and say why in reason.";

export const suggestionsFor = () => [
  {
    key: "ticket-triage", title: "Triage support tickets", summary: "Reads a new support ticket and answers its category and priority, with why.",
    why: "Every ticket lands in src/support/inbox.ts as needs_triage, and a person sets its category and priority by hand; the keyword rules in classify() miss most billing questions.",
    impact: "high",
    evidence: [{ path: "src/support/inbox.ts", line: 42, quote: "status: 'needs_triage', // a person sets category and priority" }, { path: "src/support/classify.ts", line: 7, quote: "if (/refund|invoice/i.test(text)) return 'billing';" }],
    agent: {
      name: "Support ticket triage", description: "Sorts a support ticket into a category and a priority, and says why.", instructions: INSTRUCTIONS,
      inputs: [{ name: "subject", type: "string", description: "the ticket's subject line", required: true }, { name: "body", type: "string", description: "the ticket's text as the customer wrote it", required: true }],
      output: [{ name: "category", type: "string", description: "the ticket's category", enum: ["billing", "bug", "how-to", "account", "other"] }, { name: "priority", type: "string", description: "how soon it needs a person", enum: ["urgent", "high", "normal"] }, { name: "reason", type: "string", description: "why, in one sentence" }],
      tools: [], tier: "fast",
    },
    integration: { language: "typescript", path: "src/support/ticket-triage-agent.ts", call_site: { path: "src/support/inbox.ts", line: 42, note: "Call runTicketTriage with the ticket's subject and body when it is saved, and set its category and priority from the answer." } },
  },
  {
    key: "refund-review", title: "Review refund requests", summary: "Reads a refund request with its order and answers approve, reject or escalate, with why.",
    why: "Refund requests wait in the admin queue (app/refunds.py) for a person to read the customer's reason against the order; most are routine and the queue takes days.",
    impact: "medium",
    evidence: [{ path: "app/refunds.py", line: 12, quote: "refund.status = 'pending_review'  # someone in ops reads it" }],
    agent: {
      name: "Refund review", description: "Reads a refund request against its order and recommends approve, reject or escalate.", instructions: INSTRUCTIONS.replace("triage support tickets", "review refund requests"),
      inputs: [{ name: "reason", type: "string", description: "the customer's reason, as written", required: true }, { name: "order_total", type: "number", description: "the order's total in dollars", required: true }, { name: "days_since_order", type: "integer", description: "days since the order", required: false }],
      output: [{ name: "decision", type: "string", description: "what to do", enum: ["approve", "reject", "escalate"] }, { name: "flags", type: "string_list", description: "anything unusual" }, { name: "reason", type: "string", description: "why, in one sentence" }],
      tools: ["web_fetch"], tier: "balanced",
    },
    integration: { language: "python", path: "app/refund_review_agent.py", call_site: { path: "app/refunds.py", line: 12, note: "Call run_refund_review with the request's reason and order total, and approve at once when it says approve under $50." } },
  },
];
const broken = () => ({ ...structuredClone(suggestionsFor()[0]), key: "workflow-writer", integration: { language: "typescript", path: ".github/workflows/agent.ts", call_site: { path: "a.ts", line: 1, note: "Never: a workflow file is not a client." } } });

export default function reply(context, faux) {
  const system = [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").map((m) => textOf(m.content))].join("\n");
  const commit = /is checked out in repo\/ at the head of its default branch \S+, commit ([0-9a-f]{40}) \(ref repo\/head\)/.exec(system)?.[1] ?? "";
  const first = textOf(context.messages.find((m) => m.role === "user")?.content);
  const repo = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?=[\s.,]|$)/.exec(first)?.[1] ?? "unknown/unknown";
  const answer = { repository: repo, commit, app: "A help desk and billing app for small shops.", suggestions: [...suggestionsFor(), broken()] };
  return faux.message(`Scanned ${repo}.\n\n\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\``);
}
