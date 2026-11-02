// The workflow a new decision agent starts from. Adapted from the repository's smallest decision demo
// (examples/decision-demos/workflows/jury.json): one typed question (a judge node) on the server's decision provider
// (Jev, the default, or Parallel where Jev does not run) instead of four jurors on two providers. Its answer decides the
// case; an unclear answer, or one below the confidence the decision needs, stops the run for a person (escalate nodes
// and their predicates). It has no code node: a server runs code nodes only when its operator allows them
// (--allow-code-nodes), and refuses the run of a workflow that holds one otherwise. Edit it in the Workflow step once the
// agent is created.

/** The starter decision workflow (agentrun-dsl v2). */
export const DECISION_STARTER = {
  v: 2,
  name: "decision",
  schemas: {
    Input: {
      type: "object",
      required: ["case_id", "payment"],
      properties: {
        case_id: {
          type: "string",
        },
        payment: {
          type: "object",
          required: ["descriptor"],
          properties: {
            descriptor: {
              type: "string",
            },
            memo: {
              type: "string",
            },
            merchant_site: {
              type: "string",
            },
            amount: {
              type: "string",
            },
          },
          description: "What the payment says about itself: card descriptor, memo, and the merchant's own site text.",
        },
      },
      examples: [
        {
          case_id: "case-1",
          payment: {
            descriptor: "TILEWORKS SUPPLY CO 8885550142 OH",
            memo: "Invoice 4471: 40 pallets glazed ceramic floor tile",
            amount: "USD 18,420.00",
            merchant_site: "Tileworks Supply sells porcelain and ceramic tile to contractors across the Midwest.",
          },
        },
      ],
    },
    Verdict: {
      type: "object",
      additionalProperties: false,
      required: ["verdict"],
      properties: {
        verdict: {
          type: "string",
          enum: ["gambling", "not_gambling", "unclear"],
          description: "Is the payment described in `payment` a payment for gambling: staking money or a paid currency on a game of chance or skill for a chance to win money or prizes redeemable for money, including sweepstakes casinos and social casinos that pay out cash prizes?",
          criteria: {
            gambling: "It is a payment for gambling, as described.",
            not_gambling: "It pays for something else: goods, services or a transfer with no stake on a game.",
            unclear: "What the payment says about itself is not enough to tell.",
          },
        },
      },
    },
  },
  input: {
    schemaId: "Input",
  },
  output: {
    schemaId: "Verdict",
    path: "judged",
  },
  root: {
    node: "chain",
    steps: [
      {
        node: "judge",
        label: "judge",
        timeoutMs: 60000,
        state: {
          case_id: "{case_id}",
          payment: "{payment}",
        },
        out: "Verdict",
        as: "judged",
      },
      {
        node: "escalate",
        label: "unclear",
        when: {
          predicate: "field_equals",
          path: "judged.verdict",
          value: "unclear",
        },
        kind: "review",
        stage: "decision",
        summary: "A person decides case {case_id}: what the payment says is not enough to tell.",
      },
      {
        node: "escalate",
        label: "no-confidence",
        when: {
          predicate: "not",
          of: {
            predicate: "field_type",
            path: "judged$answers.answers.verdict.confidence",
            type: "number",
          },
        },
        kind: "review",
        stage: "decision",
        summary: "A person decides case {case_id}: the judge gave no confidence.",
      },
      {
        node: "escalate",
        label: "low-confidence",
        when: {
          predicate: "lt",
          path: "judged$answers.answers.verdict.confidence",
          n: 0.7,
        },
        kind: "review",
        stage: "decision",
        summary: "A person decides case {case_id}: the judge leaned {judged.verdict}, below the confidence this decision needs.",
      },
    ],
  },
} as const;

/** The decision providers a starter's judge can name with no model: Jev, the default, which a node names by naming none,
 *  then Parallel. OpenRouter needs a model on every node, and wherever its key is set Jev runs too. */
export const STARTER_PROVIDERS = ["jev", "parallel"] as const;

/** The starter for a server whose decision provider is `provider`: a copy whose judge names it, unless it is Jev. A
 *  Parallel judge answers with web research, so it gets the longer timeout the decision demos give it. */
export function decisionStarter(provider: string = "jev") {
  const workflow = structuredClone(DECISION_STARTER) as unknown as { root: { steps: Record<string, unknown>[] } } & Record<string, unknown>;
  if (provider !== "jev") Object.assign(workflow.root.steps[0]!, { provider, ...(provider === "parallel" ? { timeoutMs: 120000 } : {}) });
  return workflow;
}
