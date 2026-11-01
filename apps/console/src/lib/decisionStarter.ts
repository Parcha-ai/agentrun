// The workflow a new decision agent starts from. Adapted from the repository's smallest decision demo
// (examples/decision-demos/workflows/jury.json): one typed question (a judge node) on the server's default decision
// provider, Jev, instead of four jurors on two providers. A clear answer decides the case; an unclear one goes to a
// person. Edit it in the Workflow step once the agent is created.

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
    Vote: {
      type: "object",
      additionalProperties: false,
      required: ["is_gambling"],
      properties: {
        is_gambling: {
          type: "boolean",
          description: "Is the payment described in `payment` a payment for gambling: staking money or a paid currency on a game of chance or skill for a chance to win money or prizes redeemable for money, including sweepstakes casinos and social casinos that pay out cash prizes?",
        },
      },
    },
    Decision: {
      type: "object",
      required: ["case_id", "decision", "why", "p"],
      properties: {
        case_id: {
          type: "string",
        },
        decision: {
          type: "string",
          enum: ["gambling", "not_gambling"],
        },
        why: {
          type: "string",
        },
        p: {
          type: "number",
        },
      },
    },
  },
  input: {
    schemaId: "Input",
  },
  output: {
    schemaId: "Decision",
    path: "decision",
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
        out: "Vote",
        as: "vote",
      },
      {
        node: "code",
        label: "threshold",
        as: "verdict",
        code: "(s) => {\n  const a = ((s[\"vote$answers\"] || {}).answers || {}).is_gambling;\n  const p = a && typeof a.noul === \"number\" ? a.noul : null;\n  if (p === null) return { action: \"human_review\", why: \"the judge gave no probability\", p };\n  if (p >= 0.7) return { action: \"auto_yes\", why: \"likely gambling (p \" + p.toFixed(2) + \")\", p };\n  if (p < 0.3) return { action: \"auto_no\", why: \"likely not gambling (p \" + p.toFixed(2) + \")\", p };\n  return { action: \"human_review\", why: \"unclear (p \" + p.toFixed(2) + \")\", p };\n}",
      },
      {
        node: "route",
        label: "outcome",
        valuePath: "verdict.action",
        as: "outcome_taken",
        branches: {
          auto_yes: {
            body: {
              node: "code",
              label: "decide_gambling",
              as: "decision",
              code: "(s) => ({ case_id: s.case_id, decision: \"gambling\", why: s.verdict.why, p: s.verdict.p })",
            },
          },
          auto_no: {
            body: {
              node: "code",
              label: "decide_not_gambling",
              as: "decision",
              code: "(s) => ({ case_id: s.case_id, decision: \"not_gambling\", why: s.verdict.why, p: s.verdict.p })",
            },
          },
          human_review: {
            body: {
              node: "escalate",
              label: "person_decides",
              when: {
                predicate: "field_equals",
                path: "verdict.action",
                value: "human_review",
              },
              kind: "review",
              stage: "decision",
              summary: "A person decides case {case_id}: {verdict.why}.",
            },
          },
        },
      },
    ],
  },
} as const;
