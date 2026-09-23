/** Fictional passages and scripted answers. These exercise the engine, not model quality. */
import type { WorkflowDeps } from '@parcha/agentrun-dsl';

export const question = 'Should our small team move its documentation from a wiki into the code repository?';
export const subquestions = [
  'What review process would our team use for documentation changes in the code repository?',
  'Can our team’s non-developers edit documentation in the code repository?',
  'How does documentation search in the code repository compare with our wiki?',
];
export const sourceSets = [
  [
    { id: 'review-guide', text: 'In this fictional team, documentation changes in the repository require a pull request and an assigned reviewer.' },
    { id: 'advert', text: 'Repository documentation will transform your whole business.' },
  ],
  [
    { id: 'editor-trial', text: 'In the fictional trial, browser editing worked, but two non-developers needed help resolving merge conflicts.' },
    { id: 'design-news', text: 'The wiki product has changed its logo.' },
  ],
  [
    { id: 'search-trial', text: 'The fictional repository search found filenames and exact words, but missed the synonyms people used in the wiki.' },
    { id: 'search-advert', text: 'Find anything instantly with our new search experience.' },
  ],
];

export function researchFixtures(options: { noEvidence?: boolean } = {}): { deps: WorkflowDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: WorkflowDeps = {
    runEffect: async ({ input, node }) => {
      calls.push(`tool:${node.label}`);
      const index = subquestions.indexOf(String(input.question));
      if (index < 0) throw new Error('Fixture has no answer to this subquestion. Supply a real search adapter.');
      return { sources: structuredClone(sourceSets[index]) };
    },
    runJudge: async ({ questions, label }) => {
      calls.push(`jev:${label}`);
      return { answers: Object.fromEntries(Object.keys(questions).map(id => [id,
        { type: 'noul' as const, noul: !options.noEvidence && id.startsWith('0.') ? 0.95 : 0.05 },
      ])) };
    },
    runNode: async ({ label, user }) => {
      calls.push(`model:${label}`);
      const input = JSON.parse(user);
      const step = label.split('/').at(-1);
      if (step === 'plan') return { questions: subquestions };
      if (step === 'write-finding') return {
        question: input.question, answer: input.sources.map((source: { text: string }) => source.text).join(' '), sources: input.sources,
      };
      if (step === 'write-report') return {
        answer: 'Pilot the repository workflow first. Reviews gain an explicit approval step, but editing and search still have gaps.', findings: input.findings,
      };
      throw new Error(`No scripted model response for ${label}`);
    },
  };
  return { deps, calls };
}
