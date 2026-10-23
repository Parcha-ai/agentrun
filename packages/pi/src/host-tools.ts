// The one check of a host's tool list, wherever a host registers tools: the coding-agent extension (`hostTools`) and
// the pi-durable workflow tool (`tools`). It loads without pi's coding agent, agent core or TUI.
import { Compile } from 'typebox/compile';

/** The most tools a host may register. */
const MAX_HOST_TOOLS = 100;

/** The tool a workflow node delivers its result with (the runner's and the durable record tool's), so no host tool may
 *  take its name. */
export const SUBMIT_TOOL = 'submit';

type HostToolLike = { name?: unknown; execute?: unknown; parameters?: unknown; resultSchema?: unknown } | null | undefined;

/**
 * Refuses a host's tool list unless it is an array of at most 100 tools, each with a name of 1 to 200 characters that
 * is not blank, not in `reserved` and not repeated, and an object parameter schema (and result schema, when given) the
 * compiler takes. With `executable`, each tool also needs an `execute` function. Throws on the first problem.
 */
export function assertHostTools(tools: unknown, options: { reserved: readonly string[]; executable: boolean }): void {
  if (!Array.isArray(tools) || tools.length > MAX_HOST_TOOLS) throw new Error(`Host must supply at most ${MAX_HOST_TOOLS} explicit tool definitions`);
  const names = new Set<string>();
  for (const tool of tools as HostToolLike[]) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 200
      || options.reserved.includes(tool.name) || names.has(tool.name)) throw new Error('Host tools contain an invalid, reserved or duplicate name');
    if ((options.executable && typeof tool.execute !== 'function') || !tool.parameters || typeof tool.parameters !== 'object') {
      throw new Error(options.executable ? 'Host tools require an executable definition and parameter schema' : 'Host tools require a parameter schema');
    }
    Compile(tool.parameters as never);
    if (tool.resultSchema) Compile(tool.resultSchema as never);
    names.add(tool.name);
  }
}
