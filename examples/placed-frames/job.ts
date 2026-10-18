// The job, as data: a zoom into the Mandelbrot set, frame by frame. Each frame is one tool call, `frame`, which the host places (Jev reads the frame and each sandbox's purpose)
// and draws in that sandbox; the last call, `release`, ends the sandboxes. No model is named: the workflow needs none. The tools are in `tools.ts`.
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '@parcha/agentrun-reference';

const FRAMES = `(s) => Array.from({ length: s.frames }, (_, f) => ({ f, of: s.frames }))`;
const FINISH = `(s) => ({ result: { frames: s.drawn.length, placed: s.drawn.reduce((by, d) => ({ ...by, [d.environment]: [...(by[d.environment] ?? []), d.f + 1] }), {}), boxes: s.released.boxes } })`;

const Box = { type: 'object', required: ['box', 'environment', 'provider'], properties: { box: { type: 'string' }, environment: { type: 'string' }, provider: { type: 'string' } } };

export const workflow = {
  v: 2,
  name: 'placed-frames',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['frames'],
      properties: { frames: { type: 'integer', minimum: 2, maximum: 24, description: 'How many frames the zoom has; each frame is one tool call.' } },
    },
    Frame: {
      type: 'object', required: ['f', 'environment', 'provider', 'box', 'placed', 'sha256'],
      properties: {
        f: { type: 'integer' }, environment: { type: 'string' }, provider: { type: 'string' },
        box: { type: 'string', pattern: '^box-\\d+$', description: 'The box by its label, never the provider\'s id.' },
        placed: { type: 'object', required: ['by', 'line'], properties: { by: { type: 'string' }, need: { type: ['number', 'null'] }, line: { type: 'string', description: 'Where the frame was placed and on what score, composed from the placement record\'s fields.' } } },
        sha256: { type: 'string', description: 'The SHA-256 of the frame\'s pixels (palette indices, one byte each), which the run\'s disk holds under frames/.' },
        iterations: { type: 'integer' },
      },
    },
    Released: { type: 'object', required: ['boxes'], properties: { boxes: { type: 'array', items: Box }, receipts: { type: 'array' } } },
    Result: {
      type: 'object', additionalProperties: false, required: ['frames', 'placed', 'boxes'],
      properties: { frames: { type: 'integer' }, placed: { type: 'object', additionalProperties: { type: 'array', items: { type: 'integer' } } }, boxes: { type: 'array', items: Box } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'code', label: 'plan', as: 'list', code: FRAMES },
    {
      node: 'map', label: 'frames', itemsPath: 'list', as: 'drawn', resultPath: 'frame', maxConcurrency: 2,
      body: { node: 'call', label: 'frame', via: 'tool', tool: 'frame', args: { f: '{item.f}', frames: '{item.of}' }, out: 'Frame', as: 'frame', deadline_s: 300 },
    },
    { node: 'call', label: 'release', via: 'tool', tool: 'release', args: { frames: '{frames}' }, out: 'Released', as: 'released', deadline_s: 180 },
    { node: 'code', label: 'finish', code: FINISH },
  ] },
} as const satisfies Workflow;

/** Twelve frames: the gallery take. Another count is an `--input`: `--input '{"frames":6}'`. */
export const input = { frames: 12 };

export const job: Job = { workflow, input, files: {} };
export default job;
