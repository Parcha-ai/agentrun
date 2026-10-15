// Crossings: the named points a process takes as it runs, and the kill that ends it at one. The child counts its crossings as it takes them, writes each
// to `CROSS_LOG` so a process that dies leaves them behind, and ends itself with SIGKILL at the planned one. A crossing is never a clock: where a kill lands
// is a fact of the run. A package adds its own crossings through the same `cross` function (`vision.filing`), so `kills[].point` can name them.
import { appendFileSync } from 'node:fs';
import type { Fakes, Host, StatusEvent, ToolContext } from './host.ts';
import type { ChildPlan } from './demo-spec.ts';

/** `cut: false` logs a crossing that is never a kill point. A crossing returns true when a tool-box kill is due at it: the caller destroys the box it is taking the crossing in. */
export type Cross = (point: string, options?: { cut?: boolean; /** Facts about this crossing (`{ tool: 'install' }`): logged with it, and what a kill's `where` is matched against. */ info?: Info }) => boolean;
export type Info = Record<string, string | number | boolean>;
export type Crossing = { point: string; n: number; pid: number; info?: Info };

/** A kill's `where` holds when every field it names equals the crossing's info field. */
const matches = (where: Info | undefined, info: Info | undefined) => !where || Object.entries(where).every(([field, value]) => info?.[field] === value);

/** The child's crossing function for the kills planned for this process (none: it only logs). */
export function crossings(plan: ChildPlan | undefined, log: string | undefined, started = Date.now(), window: EffectWindow = { open: 0 }): Cross {
  let n = 0;
  // A storm takes no crossing before the process has opened the journal and begun its first node: a kill earlier than that leaves a generation the journal never recorded.
  let begun = false;
  // Per kill: how many crossings it names (its point and `where`) were taken, and how many of those could have been kill points.
  const seen = new Map<unknown, number>();
  const eligible = new Map<unknown, number>();
  const done = new Set<number>();
  return (point, options = {}) => {
    // A crossing taken while any tool call is between its dispatch and its kept answer is never a run kill point, whichever seam it is at: a kill there would leave that call unknown.
    const cut = options.cut !== false && window.open === 0;
    if (cut) n += 1;
    const count = (map: Map<unknown, number>, kill: unknown, hit: boolean) => { const value = (map.get(kill) ?? 0) + (hit ? 1 : 0); map.set(kill, value); return value; };
    const info = options.info;
    if (log) appendFileSync(log, `${JSON.stringify({ point, n: cut ? n : 0, pid: process.pid, ...(info ? { info } : {}) } satisfies Crossing)}\n`);
    // A tool box destroyed at its crossing: once, at the nth matching time (a crossing that is not a kill point can be one: the box is the caller's to end).
    let tool = -1;
    plan?.tools.forEach((entry, index) => {
      if (!('point' in entry) || entry.point !== point || !matches(entry.where, info)) return;
      const times = count(seen, entry, true);
      if (tool < 0 && !done.has(index) && times === entry.n) tool = index;
    });
    if (tool >= 0) { done.add(tool); return true; }
    const run = plan?.run;
    if (!cut || !run) { if (point === 'event workflow.node.start') begun = true; return false; }
    // A named point is taken as named; a storm waits for the first node to have begun.
    // A run kill's `n` counts the matching crossings that could have been kill points: one suppressed by an open tool call is not the nth time, it is not a time at all.
    const timesEligible = 'storm' in run ? 0 : count(eligible, run, run.point === point && matches(run.where, info));
    const due = 'storm' in run ? begun && point !== 'event workflow.node.start' && Date.now() - started >= run.gapMs : run.point === point && matches(run.where, info) && timesEligible === run.n;
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
