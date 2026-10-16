// Code mode for the agent: a `code` tool whose script runs in pi-codemode's sandbox with two capabilities, `tools.bash` (a
// command in the run's environment, its workspace) and `vision.see` (pi-vision's look, bound to this call). The script is
// the agent's own: it probes the film, cuts the windows, asks the eyes and returns what it found. Replay-safe: a call a kill
// cut runs its script again, and each look it already paid for comes back from the call's memo.
import type { Context } from '@earendil-works/chord';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import type { Extension, ToolExecutionApi } from '@earendil-works/pi-durable';
import { callContext, piResult, type VisionHandle } from '@parcha/pi-vision/durable';

/** One script's deadline: a whole film, window by window, fits in it. */
const SCRIPT_MS = 45 * 60_000;

/** `tools.bash` in the sandbox: the command's output, or a rejection with it and its exit code. */
const bashFor = (api: ToolExecutionApi, context: Context) => ({
  name: 'bash',
  description: 'Runs a shell command in the run\'s workspace and returns what it printed. A command that exits non-zero rejects with its output.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  execute: async (args: unknown) => {
    const command = String((args as { command?: unknown } | null)?.command ?? '');
    if (!api.env) throw new Error('this run gives its tools no environment to run a command in');
    let printed = '';
    const ran = await api.env.exec(command, { onOutput: (text: string) => { printed += text; } }, context);
    if (!ran.ok) throw new Error(`${printed}${ran.error.message}`);
    if (ran.value.exitCode !== 0) throw new Error(`${printed}exit code ${ran.value.exitCode}`);
    return printed;
  },
});

/** The `code` tool, with `vision` the run's pi-vision extension. */
export function codeMode(vision: VisionHandle): Extension {
  return {
    name: 'video-chapters-code',
    tools: [{
      name: 'code',
      description: 'Runs a JavaScript script (the body of an async function) in a sandbox. `await tools.bash({ command })` runs a shell command in the workspace and returns its output; `await vision.see({ ask, paths, fragments })` has the vision model answer `ask` about images or video clips and returns { text, model, costUsd, receipts, kept }. The script\'s return value comes back as JSON.',
      replay: 'safe',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'The script.' } }, required: ['code'] },
      execute: async (args: { code: string }, api: ToolExecutionApi, context: Context & { abortSignal?: AbortSignal }) => {
        const sandbox = new CodemodeSandbox({ timeoutMs: SCRIPT_MS, tools: [bashFor(api, context)], globals: [vision.see(api.env as never, await callContext(api, context))] });
        try {
          const run = await sandbox.execute(args.code, { ...(context.abortSignal ? { signal: context.abortSignal } : {}) });
          const printed = run.output.flatMap((item) => (item.type === 'text' ? [item.text] : []));
          const text = JSON.stringify(run.ok ? { ok: true, value: run.value, printed } : { ok: false, error: run.error.message, printed });
          return piResult({ content: [{ type: 'text', text }], ...(run.ok ? {} : { isError: true }) });
        } finally { await sandbox.close(); }
      },
    }],
  } as unknown as Extension;
}
