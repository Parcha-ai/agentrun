// The workflow a new general workflow agent starts from, on any server: one agent node that does what its input's `task`
// asks and answers in `answer`. It needs no decision provider and has no code node, so a server with default settings
// runs it. Edit it, or paste another workflow over it, in the Workflow step once the agent is created.

/** The general starter workflow (agentrun-dsl v2). */
export const WORKFLOW_STARTER = {
  v: 2,
  name: "workflow",
  schemas: {
    Input: {
      type: "object",
      required: ["task"],
      additionalProperties: false,
      properties: {
        task: { type: "string", minLength: 1, description: "What the step is asked to do." },
      },
      examples: [{ task: "Write three lines on what this workflow could do next." }],
    },
    Answer: {
      type: "object",
      required: ["answer"],
      additionalProperties: false,
      properties: {
        answer: { type: "string" },
      },
    },
  },
  input: { schemaId: "Input" },
  output: { schemaId: "Answer", path: "step" },
  root: {
    node: "chain",
    steps: [
      {
        node: "agent",
        label: "step",
        state: { task: "{task}" },
        out: "Answer",
        as: "step",
        effort: "low",
        instructions: "Do what `task` asks and put your answer in `answer`.",
      },
    ],
  },
} as const;

/** A copy of the general starter, for one new agent. */
export const workflowStarter = () => structuredClone(WORKFLOW_STARTER) as unknown as Record<string, unknown>;
