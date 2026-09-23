import { defineWorkflow } from '@parcha/agentrun-dsl';
import { z } from 'zod';

const Source = z.strictObject({ id: z.string(), text: z.string() });

export const evidenceWorkflow = defineWorkflow({
  name: 'research-evidence',
  schemas: {
    Question: z.strictObject({ question: z.string().min(1) }),
    SearchResults: z.strictObject({ sources: z.array(Source) }),
    Evidence: z.array(Source).min(1),
    EvidenceDecision: {
      type: 'object', additionalProperties: false, required: ['answersQuestion'],
      properties: {
        answersQuestion: {
          type: 'boolean',
          description: 'Does this passage provide concrete evidence that answers the question, including exceptions or evidence against the proposed change?',
          criteria: {
            true: 'A specific policy, fact, limitation or exception bearing on the question. Keep contrary evidence and conditional answers.',
            false: 'Topic mentions, unsupported promotional claims, or a different subject without evidence bearing on the question.',
          },
        },
      },
    },
  },
  input: 'Question',
  output: { schema: 'Evidence', path: 'evidence.items' },
  steps: [
    { node: 'call', label: 'search', via: 'tool', tool: 'search',
      args: { question: '{question}' }, out: 'SearchResults', as: 'search', deadline_s: 10 },
    { node: 'sift', label: 'screen-evidence', itemsPath: 'search.sources',
      state: { question: '{question}' }, out: 'EvidenceDecision', as: 'evidence',
      keep: { path: 'answersQuestion', gte: 0.8 } },
    { node: 'escalate', label: 'missing-evidence',
      when: { predicate: 'empty', path: 'evidence.items' }, kind: 'needs_research',
      stage: 'evidence', summary: 'No selected evidence answers: {question}' },
  ],
});
