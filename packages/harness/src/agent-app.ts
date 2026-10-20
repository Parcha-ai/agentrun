// The run app for one agent with no workflow, for `pi-durable-disk run --app`: no node runner and no workflow task, only the tools its definition names. Its extensions come from the builder a workflow's run
// uses (`agentExtensions`), so the two offer each tool the same way. A name it cannot offer is refused when it is called, with what the name needs; none is skipped.
import { createRegistry, type Extension } from '@earendil-works/pi-durable';
import type { LocalSite } from '@parcha/pi-browser';
import type { AppOptions } from '@parcha/pi-durable-disk';
import type { VisionAdapterOptions } from '@parcha/pi-vision/durable';
import { agentExtensions, nodeAgent, recorderHook, type AgentExtensions } from './assemble.ts';
import type { CodeModeOptions } from './code-mode.ts';
import type { Host, RunPlace } from './host.ts';

/** One agent: its instructions, the tools it names (see `agentTools`), and its thinking level (`off` and absent both take the node runner's default: thinking is never off). */
export type AgentSpec = { instructions: string; tools: readonly string[]; thinking?: string };
/** `browser: false`: the run has no browser, so a browser tool is refused. `sites`: what `use_website` offers. `codeMode`: the `code` tool's limits. `vision`: options over the run's own (its eyes, its limits). */
export type AgentAppOptions = { browser?: boolean; sites?: Record<string, LocalSite>; codeMode?: CodeModeOptions; vision?: Partial<VisionAdapterOptions> };
/** A name an agent may give in `tools`: the plane whose extension registers it, and what that plane needs from the host (`browser`: a browser provider; null: nothing). `unmet`, when this host or these options
 *  cannot offer it: why, in the words `agentApp` refuses it with. */
export type AgentTool = { name: string; plane: 'coding' | 'host' | 'vision' | 'code' | 'browser'; needs: 'browser' | null; unmet?: string };

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
/** The label the agent's conversation files its evidence under. */
const LABEL = 'run';

/** Every extension an agent may be offered, built once: code mode and the browser too, so each of their names is known whether or not the agent names it. */
function build(place: RunPlace, host: Host, options: AgentAppOptions): Promise<AgentExtensions> {
  if (options.browser === false && options.sites) throw new Error('a run with no browser offers no sites: use_website runs a browser');
  return agentExtensions(place, host, { ...(options.sites ? { sites: options.sites } : {}), codeMode: options.codeMode ?? true, ...(options.vision ? { vision: () => options.vision! } : {}) });
}

function vocabularyOf(built: AgentExtensions, host: Host, options: AgentAppOptions): AgentTool[] {
  const noBrowser = options.browser === false ? 'this run has no browser (its options say browser: false)' : host.lacks?.browser !== undefined ? `this host has no browser: ${host.lacks.browser}` : undefined;
  const of = (extension: Extension | undefined, plane: AgentTool['plane'], needs: AgentTool['needs'], unmet?: string): AgentTool[] => (extension?.tools ?? []).map((tool) => ({ name: tool.name, plane, needs, ...(unmet ? { unmet } : {}) }));
  return [
    ...of(built.coding, 'coding', null),
    ...built.host.flatMap((extension) => of(extension, 'host', null)),
    ...of(built.vision.extension, 'vision', null),
    ...of(built.code, 'code', null),
    ...of(built.browser?.extension, 'browser', 'browser', noBrowser),
  ];
}

/** Every tool an agent run on this host may name, by its registered name, with its plane and what it needs; one this host or these options cannot offer says why in `unmet`. */
export async function agentTools(place: RunPlace, host: Host, options: AgentAppOptions = {}): Promise<AgentTool[]> {
  return vocabularyOf(await build(place, host, options), host, options);
}

/** `AppOptions` for one agent's run under `pi-durable-disk run --app`: the lead at the agent's thinking level, its instructions, and exactly the tools it names, each installed and offered and no other. */
export async function agentApp(place: RunPlace, host: Host, agent: AgentSpec, options: AgentAppOptions = {}): Promise<AppOptions> {
  if (agent.thinking !== undefined && !THINKING.includes(agent.thinking)) throw new Error(`the definition's thinking is ${agent.thinking}: it is one of ${THINKING.slice(1).join(', ')}`);
  const built = await build(place, host, options);
  const vocabulary = vocabularyOf(built, host, options);
  const named = [...new Set(agent.tools)];
  for (const name of named) {
    const tool = vocabulary.find((entry) => entry.name === name);
    if (!tool) throw new Error(`the definition names the tool ${name}, which this host does not offer (it offers ${vocabulary.filter((entry) => !entry.unmet).map((entry) => entry.name).join(', ')})`);
    if (tool.unmet) throw new Error(`the definition names the tool ${name}, and ${tool.unmet}`);
  }
  const wanted = new Set(named);
  // An extension keeps only the named tools; one whose tools are all unnamed is not installed. One that registers no tool (vision: images for `read`, `code` and the browser's results) always is.
  const keep = (extension: Extension | undefined): Extension[] => {
    const tools = (extension?.tools ?? []).filter((tool) => wanted.has(tool.name));
    return !extension || (extension.tools?.length && !tools.length) ? [] : [{ ...extension, tools }];
  };
  const browser = built.browser?.extension.tools?.some((tool) => wanted.has(tool.name)) ? built.browser : undefined;
  const extensions = [...keep(built.coding), ...built.host.flatMap(keep), ...keep(built.vision.extension), ...keep(built.code), ...keep(browser?.extension)];
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const installed = extensions.flatMap((extension) => extension.tools ?? []);
  const tools = named.map((name) => installed.find((tool) => tool.name === name)!);
  const record = recorderHook(host);
  return {
    registry, models: host.models.catalog,
    root: {
      agent: { ...nodeAgent(host.models.lead, agent.thinking === undefined ? {} : { thinking: agent.thinking }), instructions: agent.instructions, tools },
      // The browser's configuration is in the commit that creates the conversation, before its first call.
      ...(browser ? { init: (tx, conversationId) => built.init(tx, conversationId, LABEL) } : {}),
    },
    // The browser's sessions are reconciled before a resumed turn can reach them, after the recorder attaches so it records the reconcile.
    ...(record || browser ? { beforeResume: async (input) => { built.open(input.harness); await record?.(input); if (browser) await built.reconcile(input.harness, input.context); } } : {}),
    // Before the instance lets the run go (a drain or a park), every browser session is released, so nothing paid stays open; then the wake is written as the disk package writes it.
    ...(browser ? { wake: async (run, at) => { await built.cleanup(run.harness); await run.setStatus('sleeping', { reason: at === null ? 'idle' : 'waiting' }, { wakeAt: at === null ? null : new Date(at).toISOString() }); } } : {}),
  };
}
