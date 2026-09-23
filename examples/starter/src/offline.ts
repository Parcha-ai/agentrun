import type { WorkflowDeps } from '@parcha/agentrun-dsl';
import { createJevRunner, type JevClient } from '@parcha/agentrun-jev';

export const question = 'Can we require documentation approval without blocking emergency fixes?';
export const sources = [
  { id: 'review-policy', text: 'In this fictional team, every documentation change requires approval from a second person before merging.' },
  { id: 'incident-policy', text: 'During an incident, the on-call engineer may merge a documentation fix immediately. A second person reviews it the next working day.' },
  { id: 'advert', text: 'Our documentation platform makes collaboration effortless.' },
];

export function offlineAdapters(noEvidence = false): WorkflowDeps {
  const probabilities: Record<string, number> = {
    '0.answersQuestion': 0.95,
    '1.answersQuestion': 0.95,
    '2.answersQuestion': 0.05,
  };
  const client: JevClient = {
    async systemOne(request, options) {
      options.signal?.throwIfAborted();
      const answers = Object.fromEntries(Object.keys(request.questions).map(id => {
        if (!(id in probabilities)) throw new Error(`No scripted answer for ${id}`);
        return [id, { type: 'noul', noul: noEvidence ? 0.05 : probabilities[id] }];
      }));
      return { answers };
    },
  };
  return {
    runJudge: createJevRunner({ client, maxAttempts: 1 }),
    async runEffect({ node, input, signal }) {
      signal.throwIfAborted();
      if (node.tool !== 'search' || input.question !== question) {
        throw new Error('The offline fixture only covers the supplied question. Replace it with your search implementation.');
      }
      return { sources: structuredClone(sources) };
    },
  };
}
