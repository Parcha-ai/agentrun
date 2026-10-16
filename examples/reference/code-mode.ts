// Code mode for a run, opt-in (`DemoOptions.codeMode`, or `codeMode` in demo.json): one `code` tool whose script runs in pi-codemode's sandbox (QuickJS on WebAssembly). The script's only capabilities are the functions it is
// handed, and the nested calls never enter the model's context: only the script's output and return value do.
//   tools.bash({ command })   a shell command through the call's own environment (`api.env.exec`), in the run's `work/`: the claim's confined environment, the same one the agent's own bash tool uses.
//   vision.see(...)           the vision handle's global for this call, built from the composed handles, so a demo hands the agent `vision.see` without any wiring of its own.
// The sandbox has no network, no `fetch`, no `process`, no `require`, no timers and no file access of its own: whatever reaches the outside goes through `tools.bash` and the environment's confinement. A command `tools.bash`
// runs can do what the environment lets a shell do, so turn code mode on only where the agent's own bash is allowed. The tool is `replay: 'unsafe'` (its default): a call a crash interrupted is not rerun, because the commands
// it ran may have had effects.
import { CodemodeSandbox, type CodemodeTool } from '@earendil-works/pi-codemode';
import { defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable';
import { callContext, piResult, type VisionHandle } from '@parcha/pi-vision/durable';
import { Type } from 'typebox';

export type CodeModeOptions = { /** The script's overall deadline, tools included (default 5 minutes). */ timeoutMs?: number; /** The most a shell command's output the script gets back, in characters (default 64 KiB). */ outputChars?: number };

/** The most of a command's output a script is handed: its head, and a note of how much was dropped. */
const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}\n[${text.length - limit} more characters not shown]`);

export function codeModeExtension(vision: VisionHandle, options: CodeModeOptions = {}): Extension {
  const outputChars = options.outputChars ?? 64 * 1024;
  return defineExtension({
    name: 'reference-code-mode',
    tools: [defineTool({
      name: 'code',
      description: 'Run a script in a sandbox. `code` is the body of an async function: `return` and top-level `await` work. Inside it, `await tools.bash({ command })` runs a shell command in the run\'s work directory and resolves `{ exitCode, output }`; `await vision.see(...)` reads images and documents with the eyes (see its declaration); `text(value)` adds to the output. Nothing else is reachable: no network, no files except through bash.',
      parameters: Type.Object({ code: Type.String({ description: 'The script.' }) }),
      execute: async ({ code }, api, context) => {
        const bash: CodemodeTool = {
          name: 'bash',
          description: 'Run a shell command in the run\'s work directory. Resolves { exitCode, output } (stdout and stderr together, clipped).',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          execute: async (args) => {
            const command = (args as { command?: unknown }).command;
            if (typeof command !== 'string' || !command) throw new Error('bash needs a command (a non-empty string)');
            if (!api.env) throw new Error('this run has no environment to run a command in');
            let output = '';
            const ran = await api.env.exec(command, { onOutput: (chunk: string) => { output += chunk; } }, context);
            if (!ran.ok) throw new Error(`the command could not run: ${ran.error.message}`);
            return { exitCode: ran.value.exitCode, output: clip(output, outputChars) };
          },
        };
        const sandbox = new CodemodeSandbox({ tools: [bash], globals: [vision.see(api.env, await callContext(api, context))], ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
        try {
          const run = await sandbox.execute(code, { signal: context.abortSignal });
          const content = [
            ...run.output.map((item) => (item.type === 'text' ? { type: 'text' as const, text: item.text } : { type: 'image' as const, data: item.data, mimeType: item.mimeType })),
            { type: 'text' as const, text: JSON.stringify(run.ok ? { ok: true, value: run.value ?? null } : { ok: false, error: { kind: run.error.kind, message: run.error.message } }) },
          ];
          return piResult({ content, ...(run.ok ? {} : { isError: true }) });
        } finally { await sandbox.close(); }
      },
    })],
  });
}
