import { z } from 'zod';
import { defineWorkflow } from '@parcha/agentrun-dsl';

const Question = z.strictObject({ question: z.string().min(1) });
const Source = z.strictObject({ id: z.string(), text: z.string() });
const Finding = z.strictObject({ question: z.string(), answer: z.string(), sources: z.array(Source).min(1) });
const Report = z.strictObject({ answer: z.string(), findings: z.array(Finding).min(1) });

// Jev makes a specific evidence decision, using the complete passage and subquestion.
// Probabilities and candidate indexes remain in the execution trace.
// The host owns retention of the original source records.
const EvidenceDecision = {
  type: 'object', additionalProperties: false, required: ['answersQuestion'],
  properties: {
    answersQuestion: {
      type: 'boolean',
      description: "Does this candidate passage provide concrete information for answering `subquestion`? Evaluate the passage's claims, not keyword overlap. A partial answer, a condition, a limitation, or evidence contradicting the proposed answer counts; the passage need not settle the whole question.",
      criteria: {
        true: "Reports a specific fact, observation, rule or limitation bearing on the subquestion. Keep supporting and contrary evidence, including qualified answers; do not require proof that the answer holds in every situation.",
        false: "Only mentions the topic, promises an unspecified benefit, omits the information needed to bear on the subquestion, or describes a different subject without establishing relevance.",
      },
    },
  },
};

// A component with its own input, output, evidence and tests.
export const researchQuestion = defineWorkflow({
  name: 'research-one-question',
  schemas: { Question, Sources: z.strictObject({ sources: z.array(Source) }), Finding, EvidenceDecision },
  input: 'Question', output: { schema: 'Finding', path: 'finding' },
  steps: [
    { node: 'call', label: 'search', via: 'tool', tool: 'search',
      args: { question: '{question}' }, out: 'Sources', as: 'search', deadline_s: 15 },
    { node: 'sift', label: 'screen-evidence', itemsPath: 'search.sources',
      state: { subquestion: '{question}' }, out: 'EvidenceDecision', as: 'evidence',
      keep: { path: 'answersQuestion', gte: 0.8 } },
    { node: 'escalate', label: 'missing-evidence',
      when: { predicate: 'empty', path: 'evidence.items' },
      kind: 'needs_research', stage: 'evidence', summary: 'No selected evidence addresses: {question}' },
    { node: 'agent', label: 'write-finding',
      instructions: 'Answer this subquestion using only the selected sources. Preserve contrary evidence, conditions and uncertainty. Say what cannot be determined when evidence is partial; do not turn a conditional claim into an unconditional conclusion. Return the question, answer and cited source records.',
      state: { question: '{question}', sources: '{evidence.items}' }, out: 'Finding', as: 'finding' },
  ],
});

// The same component runs once per subquestion, with at most three in flight.
export const deepResearch = defineWorkflow({
  name: 'deep-research',
  schemas: { Question, Plan: z.strictObject({ questions: z.array(z.string().min(1)).min(1).max(5) }), Finding, Report },
  input: 'Question', output: { schema: 'Report', path: 'report' },
  steps: [
    { node: 'decide', label: 'plan', instructions: 'Break the research question into up to five distinct, answerable subquestions. Each runs independently: include its subject and relevant context so it makes sense without the original question.',
      state: { question: '{question}' }, out: 'Plan', as: 'plan' },
    { node: 'map', label: 'research', itemsPath: 'plan.questions', as: 'findings', maxConcurrency: 3, resultPath: 'finding',
      body: { node: 'workflow', label: 'research-question', workflow: researchQuestion,
        input: { question: '{item}' }, out: 'Finding', as: 'finding' } },
    { node: 'agent', label: 'write-report',
      instructions: 'Answer the original question from these findings. Preserve disagreements, conditions, uncertainty and remaining limitations. Keep unresolved questions explicit; do not present partial findings as conclusive.',
      state: { question: '{question}', findings: '{findings}' }, out: 'Report', as: 'report' },
  ],
});
