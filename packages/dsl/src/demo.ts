import { runWorkflow, type Workflow, type WorkflowDeps } from "./workflow.js";

export const supportTriage: Workflow = {
  v: 2,
  name: "support-triage",
  schemas: {
    Input: {
      type: "object", additionalProperties: false, required: ["ticket"],
      properties: { ticket: { type: "string", minLength: 1 } },
    },
    Triage: {
      type: "object", additionalProperties: false, required: ["category", "urgent"],
      properties: {
        category: {
          type: "string", description: "Which team should handle the request in `ticket`?",
          enum: ["billing", "technical", "general"],
          criteria: {
            billing: "Invoices, payments, refunds, or a duplicate charge.",
            technical: "A broken feature, integration, or service outage.",
            general: "Other requests or requests with no clear team.",
          },
        },
        urgent: { type: "boolean", description: "Does `ticket` describe an urgent problem needing immediate attention?" },
      },
    },
    Result: {
      type: "object", additionalProperties: false, required: ["queue", "priority"],
      properties: {
        queue: { type: "string", enum: ["billing", "technical", "general"] },
        priority: { type: "string", enum: ["high", "normal"] },
      },
    },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "Result", path: "result" },
  root: {
    node: "chain", steps: [
      { node: "judge", label: "understand", state: { ticket: "{ticket}" }, out: "Triage", as: "triage" },
      {
        node: "escalate", label: "check-confidence",
        when: { predicate: "lt", path: "triage$answers.confidence.category", n: 0.7 },
        kind: "human_review", stage: "triage",
        summary: "The category is uncertain. A person should choose the queue.",
      },
      {
        node: "code", label: "choose-queue",
        code: "s => ({ result: { queue: s.triage.category, priority: s.triage.urgent ? 'high' : 'normal' } })",
      },
    ],
  },
};

export const demoScenarios = {
  billing: {
    title: "A clear request", ticket: "I was charged twice for my monthly subscription. Can you refund the duplicate?",
    category: "billing", probabilities: { billing: 0.94, technical: 0.02, general: 0.04 }, confidence: 0.91, urgency: 0.12,
  },
  technical: {
    title: "An urgent outage", ticket: "Our checkout integration is down. Every payment is failing and customers cannot order.",
    category: "technical", probabilities: { billing: 0.04, technical: 0.93, general: 0.03 }, confidence: 0.9, urgency: 0.96,
  },
  ambiguous: {
    title: "An uncertain request", ticket: "Something is wrong with my account. It might be the plan, or the connection. Can you take a look?",
    category: "general", probabilities: { billing: 0.3, technical: 0.3, general: 0.4 }, confidence: 0.12, urgency: 0.25,
  },
} as const;

export type DemoScenario = keyof typeof demoScenarios;

export async function runTriageDemo(scenario: DemoScenario = "billing", runJudge?: WorkflowDeps["runJudge"]) {
  const fixture = demoScenarios[scenario];
  if (!fixture) throw new Error(`Unknown scenario: ${String(scenario)}`);
  const events: Array<{ type: string; label: string; detail?: unknown }> = [];
  const scriptedJudge: NonNullable<WorkflowDeps["runJudge"]> = async () => ({
    model: "scripted-demo", cost_usd: 0,
    answers: {
      category: { type: "choice", choice: fixture.category, probabilities: { ...fixture.probabilities }, confidence: fixture.confidence },
      urgent: { type: "noul", noul: fixture.urgency },
    },
  });
  const input = { ticket: fixture.ticket };
  const result = await runWorkflow(supportTriage, input, { runJudge: runJudge ?? scriptedJudge, onEvent: event => events.push(event) });
  return { scenario, mode: runJudge ? "live" : "scripted", input, result, events };
}
