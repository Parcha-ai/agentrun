// The job: one agent that answers two questions about a long film by writing its own code (the `code` tool: bash,
// `vision.transcribe`, `vision.judge` and `vision.see`), following pi-vision's transcribe and find skills. Heard: it writes
// the film's transcript once, finds every time the phrase is said, and picks the one the question means by what is said
// around it. Seen: it finds the second the thing is first seen, coarse to fine, and the box Jev draws on that frame. A tool
// then resolves every receipt to what the run filed and builds the cited result. It is data: no host code, no model named.
// What is asked comes from needles.json; the default input is NASA's film (what --live reads), and a run on fakes reads the
// committed clip.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '../reference/index.ts';
import clip from './clip/clip.json' with { type: 'json' };
import needles from './needles.json' with { type: 'json' };

/** A skill as the package ships it, its front matter left out. */
const skill = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.resolve('@parcha/pi-vision'))), '..', 'skills', name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
export const TRANSCRIBE = skill('transcribe');
export const FIND = skill('find');

const TASK = `Answer two questions about the film in \`film\` (a file in your workspace) by writing code with the \`code\` tool, following the two skills below. Their programs are written to be run as they are: change only the names they ask you to set.

1. Heard: at which second is \`phrase\` said, for \`heard_question\`? Write the film's transcript with the transcribe skill: its steps 1, 2 and 4 are shell commands, so run them with \`tools.bash\` (set VIDEO to the film and CHUNK to 600 in the same command, and H to the folder step 1 printed); step 3 is code. Then run the find skill's "Heard" program for the phrase. It returns every time the phrase is said, each with the rows before and after it. Keep all of them in your answer, read what is said around each, and pick the one \`heard_question\` means.
2. Seen: at which second is \`thing\` first seen, and where in the frame? Run the find skill's five steps with video \`film\`, best \`best\` (a better copy of the same film, for the box), thing \`thing\`, box \`box\`, words \`words\` and a budget of \`budget_usd\` dollars. Follow its stop rules.

Return { heard: { hits, picked, why, receipts }, seen: { found, at, cite, noul, confidence, spent_usd } }: hits exactly as the Heard program returned them; picked, the index in hits of the one the question means; why, one sentence on what around it tells you so; receipts, every receipt \`vision.transcribe\` returned. seen from step 5's answer: found, at (its \`t\`, or null), cite, noul and confidence (or null), and spent_usd. Then submit exactly that. Say nothing the transcript, the frames or the eyes do not.

The transcribe skill:
${TRANSCRIBE}

The find skill:
${FIND}`;

const Hit = {
  type: 'object', additionalProperties: false, required: ['at', 'cite', 'said', 'before', 'after'],
  properties: { at: { type: 'number', minimum: 0 }, cite: { type: 'string' }, said: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } },
} as const;

export const workflow = {
  v: 2,
  name: 'hear-and-find',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['film', 'best', 'phrase', 'heard_question', 'thing', 'box', 'words', 'seen_question', 'budget_usd'],
      properties: {
        film: { type: 'string', pattern: '^[\\w.-]+$', description: 'The film, a file in the workspace: listened to, scanned and watched.' },
        best: { type: 'string', pattern: '^[\\w.-]+$', description: 'The best copy of the same film, on the same timeline: the frame that gets the box is cut from it.' },
        phrase: { type: 'string', minLength: 1 }, heard_question: { type: 'string', minLength: 1 },
        thing: { type: 'string', minLength: 1 }, box: { type: 'string', minLength: 1 }, words: { type: 'string', minLength: 1 }, seen_question: { type: 'string', minLength: 1 },
        budget_usd: { type: 'number', exclusiveMinimum: 0, description: 'The find steps\' budget; the transcript is not counted.' },
      },
    },
    Found: {
      type: 'object', additionalProperties: false, required: ['heard', 'seen'],
      properties: {
        heard: {
          type: 'object', additionalProperties: false, required: ['hits', 'picked', 'why', 'receipts'],
          properties: { hits: { type: 'array', items: Hit }, picked: { type: 'integer', minimum: -1, description: 'The index in hits of the one the question means, -1 when none is.' }, why: { type: 'string' }, receipts: { type: 'array', items: { type: 'string' } } },
        },
        seen: {
          type: 'object', additionalProperties: false, required: ['found', 'at', 'cite', 'noul', 'confidence', 'spent_usd'],
          properties: { found: { type: 'boolean' }, at: { type: ['number', 'null'] }, cite: { type: ['string', 'null'] }, noul: { type: ['number', 'null'] }, confidence: { type: ['number', 'null'] }, spent_usd: { type: ['number', 'null'] } },
        },
      },
    },
    Cited: {
      type: 'object', required: ['format', 'title', 'rows'],
      properties: { format: { type: 'string', const: 'agentrun.cited/1' }, title: { type: 'string' }, rows: { type: 'array' }, hear_and_find: { type: 'object' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Cited', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'agent', label: 'hear and find', out: 'Found', as: 'found', tools: ['code'], thinking: 'low', state: { film: '{film}', best: '{best}', phrase: '{phrase}', heard_question: '{heard_question}', thing: '{thing}', box: '{box}', words: '{words}', seen_question: '{seen_question}', budget_usd: '{budget_usd}' }, instructions: TASK },
    // A tool resolves every receipt to what the run filed, takes the frame with its box, and builds the cited result.
    { node: 'call', label: 'answer', via: 'tool', tool: 'answer', args: { film: '{film}', best: '{best}', phrase: '{phrase}', heard_question: '{heard_question}', thing: '{thing}', seen_question: '{seen_question}', found: '{found}' }, out: 'Cited', as: 'result', deadline_s: 120 },
  ] },
} as const satisfies Workflow;

/** What needles.json asks, as the job's input fields. */
const asked = {
  phrase: needles.heard.phrase, heard_question: needles.heard.question,
  thing: needles.seen.thing, box: needles.seen.box, words: needles.seen.words, seen_question: needles.seen.question, budget_usd: 0.1,
};

/** What a run on fakes reads: the committed clip, as both the film and its best copy. */
export const clipInput = { film: clip.file, best: clip.file, ...asked };

/** The default input, NASA's film and its original: what --live reads. */
export const job = { workflow, input: { film: needles.film, best: needles.best, ...asked }, files: { [clip.file]: new Uint8Array(readFileSync(join(import.meta.dirname, 'clip', clip.file))) } } satisfies Job;
export default job;
