// The one browser agent every browsing example runs: the user's task in one line of plain words, one agent node with the
// browser's tools, its instructions general to any browsing task. It reads a page before and after it acts, and hands the
// browser to the person (`browser_request_handoff`, when the host can reach one) for a step that is theirs. An example is
// a folder with question.md and a README; nothing in it is code. This module turns a folder into the job's input.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '@parcha/agentrun-reference';

export const INSTRUCTIONS = `Do the user's task in the browser and answer from what the pages show. The task is \`question\`.

Read a page before you act on it, and read it again after you change anything, so you report the state the page is in, not the state you expect.

If the user wants to do a step themselves, or a step needs a person (a choice that is theirs, a sign-in, a CAPTCHA), hand them the browser with browser_request_handoff: say in instruction what to do, and in completion_condition what the page shows once it is done. The call returns when they finish. Then read the page and check the condition before you go on. Never do their step for them.

Say only what you read on a page. End with your answer: what you did, and what each page showed, in a few sentences.`;

export const workflow = {
  v: 2,
  name: 'browser-agent',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1, description: 'The task, in plain words.' },
        example: { type: 'string', description: 'The example folder the task came from, if any.' },
      },
    },
    Answer: {
      type: 'object', additionalProperties: false, required: ['answer'],
      properties: { answer: { type: 'string', minLength: 1 } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Answer', path: 'answer' },
  root: { node: 'chain', steps: [
    { node: 'agent', label: 'browser-agent', out: 'Answer', as: 'answer', thinking: 'medium', state: { question: '{question}' }, instructions: INSTRUCTIONS },
  ] },
} as const satisfies Workflow;

export type Example = { name: string; dir: string; question: string };

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** An example folder under examples/, by its path or its name; the run carries its name, so a folder elsewhere is refused. */
export function exampleAt(where: string): Example {
  const dir = join(EXAMPLES, basename(resolve(where)));
  if (existsSync(where) && resolve(where) !== dir) throw new Error(`${where}: an example is a folder under examples/; for another task, give --input with the question`);
  const question = readFileSync(join(dir, 'question.md'), 'utf8').trim();
  if (question.includes('\n')) throw new Error(`${join(dir, 'question.md')}: the task is one line`);
  return { name: basename(dir), dir, question };
}
/** The job's input for an example: its one-line task. */
export const inputOf = (example: Example) => ({ question: example.question, example: example.name });

/** The job: the one agent; its default input asks nothing until an example or --input gives the task. */
export const job = { workflow, input: { question: 'Open the start page and say what it shows.' } } satisfies Job;
