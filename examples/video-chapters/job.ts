// The job: one agent that watches a film and cuts it into chapters. It writes its own code (the `code` tool: bash and
// `vision.see`), following pi-vision's look skill: it probes the film, cuts windows of about a minute with their sound, asks
// the eyes about each, decides where the chapters are, takes a keyframe for each, and hands back the chapters with the
// receipts of the looks each rests on. A tool then resolves every receipt to its look and builds the cited result. It is data:
// no host code, no model named. The default input is NASA's film (what --live reads); a run on fakes reads the committed clip.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '../reference/index.ts';
import clip from './clip/clip.json' with { type: 'json' };
import sources from './sources.json' with { type: 'json' };

/** pi-vision's look skill, as the package ships it: how to look at a long video by writing code. */
const LOOK = readFileSync(join(dirname(fileURLToPath(import.meta.resolve('@parcha/pi-vision'))), '..', 'skills', 'look', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');

/** What the eyes are asked of each window. The topic line is what the agent groups windows by. */
export const ASK = 'This is a window of a film, with its sound. In two or three sentences: what does it show, and what is said or heard (narration, voices, sounds)? Then one last line: "TOPIC: " and a few words naming what this window is about.';

const TASK = `Cut the film in \`film\` (a file in your workspace) into chapters, by writing code with the \`code\` tool. Do it in one script if you can:
1. Probe the film with ffprobe. Read from \`from_s\` to \`to_s\` seconds (to_s 0 means to the end).
2. Cut it into windows of \`window_s\` seconds, sound kept, into an empty folder: \`rm -rf .look/windows && mkdir -p .look/windows\`, then for each start S \`ffmpeg -v error -y -ss S -t W -i FILM -map_metadata -1 -c copy -fflags +bitexact .look/windows/S.EXT\` (EXT the film's own extension; bitexact, so a window cut again is the same bytes and its kept look is found). Ask \`vision.see\` about each window on its own: ask exactly ${JSON.stringify(ASK)}, with the window as the one path and \`FILM#t=S,E\` as its one fragment. A look that throws (its message starts with its code) is skipped; go on with the rest.
3. Group consecutive windows whose answers are about the same thing into one chapter (the TOPIC lines help). Write each chapter's title (a few words) and a one-line note of what happens in it, from the answers only.
4. For each chapter take one keyframe at its most telling moment: \`rm -rf .look/keys && mkdir -p .look/keys\` once, then \`ffmpeg -v error -y -ss T -i FILM -frames:v 1 -q:v 3 .look/keys/T.jpg\` (an ffmpeg scene filter may pick T).
5. Return { summary, chapters }: summary, three or four sentences about the whole film; each chapter { title, start_s, end_s, note, at_s, keyframe: ".look/keys/T.jpg", receipts }, where receipts are the receipts \`vision.see\` returned for the windows the chapter rests on.
Then submit exactly what the script returned. Write nothing the answers do not say.

The look skill:
${LOOK}`;

const Chapter = {
  type: 'object', additionalProperties: false, required: ['title', 'start_s', 'end_s', 'note', 'at_s', 'keyframe', 'receipts'],
  properties: {
    title: { type: 'string', minLength: 1 }, start_s: { type: 'number', minimum: 0 }, end_s: { type: 'number', minimum: 0 }, note: { type: 'string', minLength: 1 },
    at_s: { type: 'number', minimum: 0, description: 'The second the keyframe was taken at.' },
    keyframe: { type: 'string', pattern: '^\\.look/keys/[\\w.-]+\\.jpg$', description: 'The keyframe\'s path in the workspace.' },
    receipts: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'The receipts of the looks the chapter rests on, as vision.see returned them.' },
  },
} as const;

export const workflow = {
  v: 2,
  name: 'video-chapters',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['film', 'from_s', 'to_s', 'window_s'],
      properties: {
        film: { type: 'string', pattern: '^[\\w.-]+$', description: 'The film, a file in the workspace.' },
        from_s: { type: 'number', minimum: 0, description: 'The second to start reading at.' },
        to_s: { type: 'number', minimum: 0, description: 'The second to stop at; 0 reads to the end.' },
        window_s: { type: 'number', exclusiveMinimum: 0, description: 'Seconds of film in one look.' },
      },
    },
    Chapters: {
      type: 'object', additionalProperties: false, required: ['summary', 'chapters'],
      properties: { summary: { type: 'string', minLength: 1 }, chapters: { type: 'array', minItems: 1, items: Chapter } },
    },
    Cited: {
      type: 'object', required: ['format', 'title', 'rows'],
      properties: { format: { type: 'string', const: 'agentrun.cited/1' }, title: { type: 'string' }, rows: { type: 'array' }, video_chapters: { type: 'object' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Cited', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'agent', label: 'chapters', out: 'Chapters', as: 'chapters', tools: ['code'], thinking: 'low', state: { film: '{film}', from_s: '{from_s}', to_s: '{to_s}', window_s: '{window_s}' }, instructions: TASK },
    // A tool resolves every receipt to the look that backs it and builds the cited result.
    { node: 'call', label: 'cite', via: 'tool', tool: 'cite', args: { film: '{film}', summary: '{chapters.summary}', chapters: '{chapters.chapters}' }, out: 'Cited', as: 'result', deadline_s: 60 },
  ] },
} as const satisfies Workflow;

const film = sources.items[0]!;

/** What a run on fakes reads: the committed clip, in windows of eight seconds. */
export const clipInput = { film: clip.file, from_s: 0, to_s: 0, window_s: 8 };

/** The default input, NASA's film whole: what --live reads. */
export const job = { workflow, input: { film: `${film.id}.mp4`, from_s: 0, to_s: 0, window_s: 60 }, files: { [clip.file]: new Uint8Array(readFileSync(join(import.meta.dirname, 'clip', clip.file))) } } satisfies Job;
export default job;
