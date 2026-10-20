// What a command the agent runs sees of this process's environment. The host keeps the provider keys for its own model calls;
// the agent's bash tool and code mode's `tools.bash` run with these names only, so a command (or a prompt that writes one) cannot read a key.
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { defineExtension, type Extension } from '@earendil-works/pi-durable';
import { ArchilCodingTools } from '@parcha/pi-durable-disk';

/** The names a command keeps: enough to find programs, write temporary files and read text. */
export const COMMAND_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;

/** This process's values of `COMMAND_ENV`, each only when it is set. Read where the command runs (a box's child has its own `PATH`). */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of COMMAND_ENV) if (typeof env[name] === 'string') kept[name] = env[name]!;
  return kept;
}

/** The disk package's coding tools (`read`, `write`, `edit`, `bash`), with `bash` run without this process's environment. */
export const codingTools: Extension = defineExtension({
  name: ArchilCodingTools.name,
  tools: (ArchilCodingTools.tools ?? []).map((tool) => (tool.name === 'bash' ? createBashTool({
    prepare: (execution) => { execution.inheritEnv = false; execution.env = { ...commandEnv(), ...execution.env }; },
  }) : tool)),
});
