// Crossings: the named points a process takes as it runs, and the kill that ends it at one. The child counts its crossings as it takes them, writes each
// to `CROSS_LOG` so a process that dies leaves them behind, and ends itself with SIGKILL at the planned one. A crossing is never a clock: where a kill lands
// is a fact of the run. A package adds its own crossings through the same `cross` function (`vision.filing`), so `kills[].point` can name them.
import { appendFileSync } from 'node:fs';
import type { Fakes, Host, StatusEvent, ToolContext } from './host.ts';
import type { ChildPlan } from './demo-spec.ts';

/** `cut: false` logs a crossing that is never a kill point. A crossing returns true when a tool-box kill is due at it: the caller destroys the box it is taking the crossing in. */
export type Cross = (point: string, options?: { cut?: boolean }) => boolean;
export type Crossing = { point: string; n: number; pid: number };

/** The child's crossing function for the kills planned for this process (none: it only logs). */
export function crossings(plan: ChildPlan | undefined, log: string | undefined, started = Date.now()): Cross {
  let n = 0;
  // A storm takes no crossing before the process has opened the journal and begun its first node: a kill earlier than that leaves a generation the journal never recorded.
  let begun = false;
  const seen = new Map<string, number>();
  const done = new Set<number>();
  return (point, options = {}) => {
    const cut = options.cut !== false;
    if (cut) n += 1;
    const times = (seen.get(point) ?? 0) + 1;
    seen.set(point, times);
    if (log) appendFileSync(log, `${JSON.stringify({ point, n: cut ? n : 0, pid: process.pid } satisfies Crossing)}\n`);
    // A tool box destroyed at its crossing: once, at the nth time (a crossing that is not a kill point can be one: the box is the caller's to end).
    const tool = plan?.tools.findIndex((entry, index) => !done.has(index) && 'point' in entry && entry.point === point && times === entry.n) ?? -1;
    if (tool >= 0) { done.add(tool); return true; }
    const run = plan?.run;
    if (!cut || !run) { if (point === 'event workflow.node.start') begun = true; return false; }
    // A named point is taken as named; a storm waits for the first node to have begun.
    const due = 'storm' in run ? begun && point !== 'event workflow.node.start' && Date.now() - started >= run.gapMs : run.point === point && times === run.n;
    if (point === 'event workflow.node.start') begun = true;
    if (due) process.kill(process.pid, 'SIGKILL');
    return false;
  };
}

/** The fakes with a crossing before and after each scripted answer: the model's request, a tool's dispatch and return, the judge's question. */
export function tapFakes(fakes: Fakes, cross: Cross): Fakes {
  return {
    ...fakes,
    model: (messages) => {
      const turn = messages.filter((message) => message.role === 'toolResult').length;
      cross(`model.request turn ${turn}`);
      const answer = fakes.model(messages);
      cross(`model.answered turn ${turn}`);
      return answer;
    },
    tools: Object.fromEntries(Object.entries(fakes.tools).map(([name, tool]) => [name, async (args: Record<string, unknown>, context?: ToolContext) => {
      // Between a tool's dispatch and the host keeping its answer nothing records what the tool did: a kill there leaves the effect unknown, for an operator.
      cross(`tool.dispatch ${name}`, { cut: false });
      const result = await tool(args, context);
      cross(`tool.returned ${name}`, { cut: false });
      return result;
    }])),
    judge: async (request) => {
      cross(`judge.asked ${request.label}`);
      const answer = await fakes.judge(request);
      cross(`judge.answered ${request.label}`);
      return answer;
    },
  };
}

/** How many tool calls are between their dispatch and their kept answer: a crossing taken inside one is never a run kill point (a kill there leaves the effect unknown). */
export type EffectWindow = { open: number };

/** The host with a crossing at each of its seams: the span after the host keeps a tool's answer and before the driver commits it (`effect.kept`, cut only
 *  when no other call is between its dispatch and its kept answer: a kill there would leave that one unknown), an evidence filing, each row of events, the delivery. */
export function tapHost(host: Host, cross: Cross, window: EffectWindow = { open: 0 }): void {
  const { runEffect } = host.tools;
  host.tools = { ...host.tools, runEffect: async (request) => {
    window.open += 1;
    let value: unknown;
    try { value = await runEffect(request); } finally { window.open -= 1; }
    cross(`effect.kept ${request.node.tool}`, { cut: window.open === 0 });
    return value;
  } };
  const { evidence, status, deliver } = host;
  host.evidence = { file: async (label, record) => { cross(`receipt.filing ${record.tool}`); const filed = await evidence.file(label, record); cross(`receipt.filed ${record.tool}`); return filed; } };
  host.status = (event: StatusEvent) => {
    cross(`event ${event.source}.${event.source === 'workflow' ? event.event.type : 'change' in event ? event.change : 'look' in event ? 'look' : 'miss' in event ? 'miss' : 'reconciled'}`);
    return status(event);
  };
  host.deliver = async (result) => { cross('deliver.writing'); await deliver(result); cross('deliver.written'); };
}
