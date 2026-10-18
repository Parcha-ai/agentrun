// The job: a pi agent draws a zoom into the Mandelbrot set, frame by frame. The agent has two tools, `frame` and `release` (tools.ts); the host places each `frame` call (Jev reads the
// frame and each sandbox's purpose) and runs it in the sandbox it picks. The agent never sees where a call may go: it asks for the frames and reads which sandbox each one ran in.
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '@parcha/agentrun-reference';

export const INSTRUCTIONS = `Draw a zoom into the Mandelbrot set of \`frames\` frames.

Call \`frame\` once for each frame, with f from 0 to frames - 1 and frames as given. The frames do not depend on each other: ask for several in one turn. Each answer names the sandbox the frame ran in (its \`environment\` and its box), what the host judged about it (\`placed.line\`) and the frame's SHA-256.

When every frame is drawn, call \`release\` once; it ends the sandboxes and names them. Then submit { answer }: one or two sentences saying how many frames you drew and how they were spread over the sandboxes, in the words of the answers. Say only what the answers say.`;

export const workflow = {
  v: 2,
  name: 'placed-frames',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['frames'],
      properties: { frames: { type: 'integer', minimum: 2, maximum: 24, description: 'How many frames the zoom has; each frame is one tool call.' } },
    },
    Answer: {
      type: 'object', additionalProperties: false, required: ['answer'],
      properties: { answer: { type: 'string', minLength: 1, description: 'How many frames were drawn and how they were spread over the sandboxes.' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Answer', path: 'answer' },
  root: { node: 'chain', steps: [
    { node: 'agent', label: 'zoom', out: 'Answer', as: 'answer', tools: ['frame', 'release'], thinking: 'medium', state: { frames: '{frames}' }, instructions: INSTRUCTIONS },
  ] },
} as const satisfies Workflow;

/** Twelve frames: the gallery take. Another count is an `--input`: `--input '{"frames":6}'`. */
export const input = { frames: 12 };

export const job: Job = { workflow, input, files: {} };
export default job;
