// The issue-triage job and its scripted fakes. The workflow is `workflow.json`, the reference an agent drafts against; the fakes answer from
// `fixtures.json`: twenty fictional issues in the shape of a real repository's, so the run is the same on every machine at $0 and no text of a
// real person is in it. A live take replaces the fakes with GitHub's read-only API, a model and Jev (see README.md).
import { readFileSync } from 'node:fs';
import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '../reference/index.ts';
import type { Fakes } from '../reference/host.ts';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as {
  issues: Array<{ number: number; title: string; body: string; labels: string[]; url: string; prs: Array<{ number: number; title: string; state: string; paths: string[] }>; paths: string[] }>;
  files: Record<string, string>;
  script: Record<string, { label: string; good_first_issue: boolean }>;
};
export const workflow = JSON.parse(readFileSync(new URL('./workflow.json', import.meta.url), 'utf8')) as Workflow;

/** The maintainers' label names (here the Express repository's) mapped onto the five. */
export const LABEL_MAP = { bug: 'bug', enhancement: 'feature', docs: 'docs', question: 'question', 'awaiting more info': 'needs-info' };
export const REPO = 'fictional/widget-router';
const encoder = new TextEncoder();

export const job: Job = {
  workflow,
  input: { repo: REPO, numbers: fixtures.issues.map((issue) => issue.number), label_map: LABEL_MAP },
  files: Object.fromEntries(Object.entries(fixtures.files).map(([path, text]) => [`repo/${path}`, encoder.encode(text)])),
};

const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));
const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const byNumber = new Map(fixtures.issues.map((issue) => [issue.number, issue]));
const byTitle = new Map(fixtures.issues.map((issue) => [issue.title, issue]));

/** The research agent as a model would act: read each path the issue or its pull requests name (a read that errs is asked again, three attempts), then submit
 *  what it read with a short quotation from each source. */
export function researcher(messages: readonly Message[]) {
  const prompt = textOf(messages.find((message) => message.role === 'user')!);
  const number = Number(/"number"\s*:\s*(\d+)/.exec(prompt)?.[1]);
  const issue = byNumber.get(number);
  if (!issue) return fauxAssistantMessage('That issue is not in this repository.');
  const paths = [...new Set([...issue.paths, ...issue.prs.flatMap((pr) => pr.paths)])].filter((path) => path in fixtures.files);
  const results = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
  const read: Array<{ path: string; text: string } | undefined> = [];
  let tries = 0;
  for (const result of results) {
    tries += 1;
    if (result.isError && tries < 3) continue;
    read.push(result.isError ? undefined : { path: paths[read.length]!, text: textOf(result) });
    tries = 0;
  }
  if (read.length < paths.length) return call('read', { path: `repo/${paths[read.length]}` });
  const quote = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return call('submit', {
    summary: `${issue.title}. ${quote(issue.body).slice(0, 160)}`,
    reproduces: /attached|reproduction|failing|test/i.test(issue.body) ? 'yes' : /\bI\b.*\b(hang|work|500)/i.test(issue.body) || issue.body.length < 80 ? 'not stated' : 'no',
    code_paths: read.flatMap((file) => (file ? [file.path] : [])),
    evidence: [
      { source: 'issue', quote: quote(issue.body) },
      ...issue.prs.map((pr) => ({ source: `pr ${pr.number}`, quote: quote(`${pr.title} (${pr.state})`) })),
      ...read.flatMap((file) => (file ? [{ source: file.path, quote: quote(file.text) }] : [])),
    ],
  });
}

export const fakes: Fakes = {
  model: researcher,
  tools: {
    github_issue: ({ number }) => {
      const { prs: _prs, paths: _paths, ...issue } = byNumber.get(Number(number)) ?? (() => { throw new Error(`no issue ${String(number)}`); })();
      return issue;
    },
    github_linked_prs: ({ number }) => ({ prs: (byNumber.get(Number(number))?.prs ?? []) }),
  },
  // Scripted: no model, so $0. A label question gets the scripted label at 0.8 and the rest share what is left; a good-first-issue question gets 0.9 or 0.1.
  judge: async ({ questions, state }) => {
    const row = byTitle.get(String((state as { title?: unknown }).title));
    const scripted = row ? fixtures.script[row.number]! : undefined;
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        const chosen = options.includes(scripted?.label ?? '') ? scripted!.label : options[0]!;
        const rest = options.filter((option) => option !== chosen);
        return [id, { type: 'choice' as const, choice: chosen, probabilities: Object.fromEntries(options.map((option) => [option, option === chosen ? 0.8 : +(0.2 / rest.length).toFixed(2)])), confidence: 0.8 }];
      }
      return [id, { type: 'noul' as const, noul: scripted?.good_first_issue ? 0.9 : 0.1 }];
    }));
    return { answers, usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 };
  },
  pages: {},
  start: '',
  // Twenty branches, each a few turns.
  responses: 400,
};
