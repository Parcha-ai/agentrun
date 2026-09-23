import type { Workflow, WorkflowDeps } from '@parcha/agentrun-dsl';
import type { PiToolDefinition } from './types.js';
import { demoData } from './demo-data.js';

export const demoWorkflow = demoData.workflow as Workflow;
export const demoInput = { question: demoData.question };
export const demoSources = demoData.sources;
export const demoQuestions = demoData.subquestions;

export function demoSearchTool(): PiToolDefinition {
  return {
    name: 'search', label: 'Search example sources',
    description: 'Read the bundled fictional wiki-migration sources. This does not search the internet.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'], additionalProperties: false },
    async execute(_id, _args, signal) {
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: JSON.stringify({ sources: demoSources }) }], details: { sources: structuredClone(demoSources) } };
    },
  };
}

export function scriptedDemoDeps(noEvidence = false): WorkflowDeps {
  return {
    runEffect: async ({ node, signal }) => {
      signal?.throwIfAborted();
      if (node.tool !== 'search') throw new Error('Unknown demo tool');
      return { sources: structuredClone(demoSources) };
    },
    runJudge: async ({ questions, state, signal }) => {
      signal?.throwIfAborted();
      const data = state as { subquestion: string; items: { item: { id: string } }[] };
      const selected = demoData.evidenceIds[demoQuestions.indexOf(data.subquestion)];
      return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, {
        type: 'noul' as const, noul: !noEvidence && data.items[Number(id.split('.')[0])]?.item.id === selected ? 0.95 : 0.05,
      }])) };
    },
    runNode: async ({ label, user, signal }) => {
      signal?.throwIfAborted();
      const input = JSON.parse(user);
      switch (label.split('/').at(-1)) {
        case 'plan': return { questions: demoQuestions };
        case 'write-finding': return { question: input.question, answer: input.sources.map((s: { text: string }) => s.text).join(' '), sources: input.sources };
        case 'write-report': return { answer: 'Pilot the repository workflow first. Reviews gain an explicit approval step, but editing and search still have gaps.', findings: input.findings };
        default: throw new Error('Unknown scripted demo step');
      }
    },
  };
}
