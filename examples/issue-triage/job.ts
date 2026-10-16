// The issue-triage job and its scripted fakes. The workflow is `workflow.json`, the reference an agent drafts against; the fakes answer from
// `fixtures.json`: twenty fictional issues in the shape of a real repository's, so the run is the same on every machine at $0 and no text of a
// real person is in it. A live take replaces the fakes with GitHub's read-only API, a model and Jev (see README.md).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '../reference/index.ts';
import type { Fakes } from '../reference/host.ts';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as {
  issues: Array<{ number: number; title: string; body: string; labels: string[]; url: string; prs: Array<{ number: number; title: string; state: string; paths: string[] }>; paths: string[] }>;
  files: Record<string, string>;
  script: Record<string, { label: string; good_first_issue: boolean; actionable: boolean }>;
};
export const workflow = JSON.parse(readFileSync(new URL('./workflow.json', import.meta.url), 'utf8')) as Workflow;

/** The maintainers' type labels (here the Express repository's) mapped onto the four types. A waiting-on-reporter state is not a type and is not here. */
export const LABEL_MAP = { bug: 'bug', enhancement: 'feature', docs: 'docs', question: 'question' };
export const REPO = 'fictional/widget-router';

// No `files`: the fixtures' source files are written into the workspace by the scripted `github_code` (below), so a live run, which the entry stages `job.files` for as well, never has a
// fictional file where a real one is missing.
export const job: Job = {
  workflow,
  input: { repo: REPO, numbers: fixtures.issues.map((issue) => issue.number), label_map: LABEL_MAP },
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
    // The issue as the classifier may see it: no maintainers' labels (`github_labels` hands those over after the judgments).
    github_issue: ({ number }) => {
      const { prs: _prs, paths: _paths, labels: _labels, ...issue } = byNumber.get(Number(number)) ?? (() => { throw new Error(`no issue ${String(number)}`); })();
      return issue;
    },
    github_labels: ({ number }) => ({ labels: byNumber.get(Number(number))?.labels ?? [] }),
    // The scripted run's source files: this issue's, written into the workspace for the agent's read-only tools, as the live tool writes the repository's.
    github_code: ({ number }, context) => {
      // The files the issue names and those of its pull requests: what the scripted researcher reads.
      const issue = byNumber.get(Number(number));
      const paths = [...new Set([...(issue?.paths ?? []), ...(issue?.prs ?? []).flatMap((pr) => pr.paths)])].filter((path) => path in fixtures.files);
      if (!context?.place) throw new Error('github_code needs the run place');
      for (const path of paths) { const at = join(context.place.work, 'repo', path); mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, fixtures.files[path]!); }
      return { paths };
    },
    github_linked_prs: ({ number }) => ({ prs: (byNumber.get(Number(number))?.prs ?? []) }),
  },
  // Scripted: no model, so $0. A label question gets the scripted label at 0.8 and the rest share what is left; the good-first-issue and actionable questions get 0.9 or 0.1 from their own columns.
  judge: async ({ questions, state }) => {
    const row = byTitle.get(String((state as { title?: unknown }).title));
    const scripted = row ? fixtures.script[row.number]! : undefined;
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        const chosen = options.includes(scripted?.label ?? '') ? scripted!.label : options[0]!;
        const rest = options.filter((option) => option !== chosen);
        return [id, { type: 'choice' as const, choice: chosen, probabilities: Object.fromEntries(options.map((option) => [option, option === chosen ? 0.8 : 0.2 / rest.length])), confidence: 0.8 }];
      }
      const yes = id === 'actionable' ? scripted?.actionable : scripted?.good_first_issue;
      return [id, { type: 'noul' as const, noul: yes ? 0.9 : 0.1 }];
    }));
    return { answers, usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 };
  },
  pages: {},
  start: '',
  // Twenty branches, each a few turns.
  responses: 400,
};
