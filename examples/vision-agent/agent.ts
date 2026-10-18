// The one vision agent every vision example runs: the user's question in plain words and the files it is about, one
// agent node with the `code` tool (bash, `vision.see`, `vision.judge`, `vision.transcribe`), its instructions the task
// and pi-vision's skills as the package ships them. It plans its own steps and ends with the report skill's HTML report.
// An example is a folder: question.md, inputs.json (each file by URL, size and SHA-256, or committed beside it) and a
// README; nothing in it is code. This module turns a folder into the job's input and its committed files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '@parcha/agentrun-reference';

const SKILLS = join(dirname(fileURLToPath(import.meta.resolve('@parcha/pi-vision'))), '..', 'skills');
/** pi-vision's skills as the package ships them, each without its front matter, in name order. */
export const skills = (): { name: string; text: string }[] => readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, 'SKILL.md'))).map((entry) => entry.name).sort()
  .map((name) => ({ name, text: readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '') }));

/** The report's shape, for a package whose skills do not yet include `report`. */
const REPORT = `Write the report as \`report/report.html\`, one page with its pictures and clips beside it in \`report/\`: inline CSS, no script and no address outside the folder. The answer first, then one finding per point (its words, its picture or clip, its cites), then what you did not check. A cite is \`<a class="cite" href="../FILE#FRAGMENT" data-look="KEY">LABEL</a>\`: the file's own fragment, LABEL that number, KEY the look's key from its receipt (\`facts.key\`).`;

export const INSTRUCTIONS = (skillList = skills()) => `Answer the user's question about the files in your workspace. The question is \`question\`; the files are \`files\`.

You never see a picture or hear a sound yourself: you write code with the \`code\` tool. Its sandbox gives you \`tools.bash\` (a shell in your workspace, with ffmpeg, ffprobe, pdftoppm and pdftotext), \`vision.see\` (eyes that look at images, and at a video window with its sound when they take video), \`vision.judge\` (Jev: typed answers and boxes about images, cheap enough to ask of every frame or page) and \`vision.transcribe\` (what a recording says, word by word with its second). The skills below show how to use them for long videos, speech, finding a thing, checking a document, and the report: follow the ones the question needs, and combine them when it needs more than one.

Those three functions are the only way to know what a file shows or says. A PDF's text layer, a file's name, its metadata or what you remember tells you where to look, never what is there: the answer rests on looks. If you also have shell or file tools, they work in the same workspace; use them for files and programs, not to stand in for a look. This task has no browser.

First write your plan in a few lines: which files, what you will read, watch, hear or judge in each, and what that costs roughly. Find your way quickly (a file's length, a PDF's pages, a sheet of frames), then look. Work step by step, and keep every receipt a function returns: a receipt is a path from the folder above your workspace, so \`cat ../<receipt>\` reads it (where a skill writes \`cat <receipt>\`, write \`cat ../<receipt>\` here), and its JSON \`facts.key\` is the look's key a cite names.

Say only what you read, saw or heard. Cite every claim with the file's own fragment, labelled with its number: \`#t=\` seconds for a recording, \`#page=N\` for a PDF (N the page index, from 1), \`#xywh=percent:x,y,w,h\` for a region.

End with the report${skillList.some((skill) => skill.name === 'report') ? ' the report skill describes' : ' (\`report/report.html\`)'}, then submit { answer, report }: answer is two or three sentences that point to the report, report the page's path in your workspace (under \`report/\`).${skillList.some((skill) => skill.name === 'report') ? '' : `\n\n${REPORT}`}
${skillList.map((skill) => `\nThe ${skill.name} skill:\n${skill.text}`).join('')}`;

export const workflow = {
  v: 2,
  name: 'vision-agent',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['question', 'files'],
      properties: {
        question: { type: 'string', minLength: 1, description: 'The question, in plain words.' },
        files: { type: 'array', items: { type: 'string', pattern: '^[\\w.-]+$' }, description: 'The files in the workspace the question is about.' },
        example: { type: 'string', description: 'The example folder the question and files came from, if any.' },
      },
    },
    Answer: {
      type: 'object', additionalProperties: false, required: ['answer', 'report'],
      properties: { answer: { type: 'string', minLength: 1 }, report: { type: 'string', pattern: '^report/[\\w./-]+\\.html$' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Answer', path: 'answer' },
  root: { node: 'chain', steps: [
    { node: 'agent', label: 'vision-agent', out: 'Answer', as: 'answer', tools: ['code'], thinking: 'medium', state: { question: '{question}', files: '{files}' }, instructions: INSTRUCTIONS() },
  ] },
} as const satisfies Workflow;

/** A file an example reads: fetched by URL (checked by size and SHA-256), or committed beside the example (`path`). */
export type InputItem = { id: string; title?: string; url?: string; path?: string; bytes: number; sha256: string; license?: string; source?: string };
export type Example = { name: string; dir: string; question: string; items: InputItem[] };

const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** An example folder by its path or its name under examples/. */
export function exampleAt(where: string): Example {
  const dir = existsSync(where) ? resolve(where) : join(EXAMPLES, basename(where));
  const question = readFileSync(join(dir, 'question.md'), 'utf8').trim();
  const { items } = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8')) as { items: InputItem[] };
  return { name: basename(dir), dir, question, items };
}
/** The workspace name of an input: a fetched one as the source fetcher names it (its id and the URL's extension), a
 *  committed one as its file. */
export const fileName = (item: InputItem) => (item.url ? `${item.id}${extname(new URL(item.url).pathname)}` : basename(item.path!));
/** The job's input for an example: its question and its files. */
export const inputOf = (example: Example) => ({ question: example.question, files: example.items.map(fileName), example: example.name });

/** The files a run is given beside the job: an example's committed inputs, and on fakes those in DEMO_FILES_DIR. */
function filesOf(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const input = (() => { try { return JSON.parse(process.env.INPUT ?? '') as { example?: string }; } catch { return undefined; } })();
  const named = input?.example ?? process.argv.slice(2).find((arg, i, all) => !arg.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
  if (named && existsSync(join(EXAMPLES, basename(named), 'inputs.json'))) {
    const example = exampleAt(named);
    for (const item of example.items) if (item.path) out[fileName(item)] = new Uint8Array(readFileSync(join(example.dir, item.path)));
  }
  const extra = process.env.DEMO_FILES_DIR;
  if (extra && existsSync(extra)) for (const name of readdirSync(extra)) out[name] = new Uint8Array(readFileSync(join(extra, name)));
  return out;
}

/** The job: the one agent; its default input asks nothing until an example or --input gives the question. */
export const job = { workflow, input: { question: 'What is in these files?', files: [] }, files: filesOf() } satisfies Job;
