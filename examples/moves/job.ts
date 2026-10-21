// The job of the moves demo, as data: one run, three agent nodes, and two hand-overs between them. The workspace on the disk carries the
// brief (written by `prepare`, read by `threads`) and the result (written by `pick`, read by `answer`). The hand-overs are workflow `call`
// nodes, so the run is released to the disk right after each answer is kept and the next host opens it (handoffs at `effect.kept hand_over`
// and `effect.kept hand_back`, demo.json). Nothing here names a model, a key or a machine.
import type { Workflow } from '@parcha/agentrun-dsl';

export const PREPARE = 'You are planning a small GPU experiment. Write the brief with the write tool as `brief.md` in your workspace: what the experiment trains, which settings a thread may choose (a learning rate and a width, say), and that a lower final loss is better. Keep it under twelve lines. Then submit the brief file name.';
export const THREADS = 'You are now on a Modal VM with the run\'s disk mounted. Read `brief.md` with the read tool. Then call fork_threads once, with one sentence for the job, and read what the threads reported. Then call pick with the thread whose metric is lowest and say why in one sentence. Then submit the number of the thread you picked.';
export const ANSWER = 'You are back on the machine the run started on. Read `result.json` with the read tool and answer in two sentences: which thread won, with what settings and metric, and on what GPU.';

export const workflow = {
  v: 2,
  name: 'moves',
  schemas: {
    Input: { type: 'object', additionalProperties: false, required: ['task'], properties: { task: { type: 'string', minLength: 1, description: 'What the experiment is for.' } } },
    Brief: { type: 'object', additionalProperties: false, required: ['file'], properties: { file: { type: 'string', pattern: '^[\\w.-]+\\.md$' } } },
    Hand: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { type: 'string' } } },
    Picked: { type: 'object', additionalProperties: false, required: ['thread'], properties: { thread: { type: 'integer', minimum: 1 } } },
    Answer: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string', minLength: 1 } } },
    Result: { type: 'object', additionalProperties: false, required: ['answer', 'picked'], properties: { answer: { type: 'string' }, picked: { type: 'integer' } } },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'agent', label: 'prepare', state: { task: '{task}' }, out: 'Brief', as: 'brief', tools: ['write'], thinking: 'medium', instructions: PREPARE },
    { node: 'call', label: 'hand_over', via: 'tool', tool: 'hand_over', args: { to: 'modal' }, out: 'Hand', as: 'handed', deadline_s: 30 },
    { node: 'agent', label: 'threads', state: { brief: '{brief.file}' }, out: 'Picked', as: 'picked', tools: ['read', 'fork_threads', 'pick'], thinking: 'medium', instructions: THREADS },
    { node: 'call', label: 'hand_back', via: 'tool', tool: 'hand_back', args: { to: 'local' }, out: 'Hand', as: 'back', deadline_s: 30 },
    { node: 'agent', label: 'answer', state: { picked: '{picked.thread}' }, out: 'Answer', as: 'answer', tools: ['read'], thinking: 'medium', instructions: ANSWER },
    { node: 'code', label: 'finish', code: '(s) => ({ result: { answer: s.answer.answer, picked: s.picked.thread } })' },
  ] },
} as const satisfies Workflow;

export const job = { workflow, input: { task: 'Which settings train a tiny model best in a few seconds?' }, files: {} } as const;
export default job;
