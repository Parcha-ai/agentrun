// Crossings: the named points a process takes as it runs, and the kill that ends it at one. The child counts its crossings as it takes them, writes each
// to `CROSS_LOG` so a process that dies leaves them behind, and ends itself with SIGKILL at the planned one. A crossing is never a clock: where a kill lands
// is a fact of the run. A package adds its own crossings through the same `cross` function (`vision.filing`), so `kills[].point` can name them.
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Fakes, Host, StatusEvent, ToolContext } from './host.ts';
import type { ChildPlan } from './demo-spec.ts';

/** `cut: false` logs a crossing that is never a kill point. A crossing returns true when a tool-box kill is due at it: the caller destroys the box it is taking the crossing in. */
export type Cross = ((point: string, options?: { cut?: boolean; /** Facts about this crossing (`{ tool: 'install' }`): logged with it, and what a kill's `where` is matched against. */ info?: Info }) => boolean) & {
  /** A crossing that parks (`vision.filing`): when a kill with `hold` is planned for this point, the nth filing and those after it are parked, forever, and the process is killed once `hold` are parked or `waitMs` has passed. The caller awaits what this returns. */
  park?(point: string, info?: Info): Promise<never> | undefined;
};
export type Info = Record<string, string | number | boolean>;
export type Crossing = { point: string; n: number; pid: number; info?: Info; /** A tool kill that fired at this crossing. */ landed?: true };

/** A kill's `where` holds when every field it names equals the crossing's info field. */
const matches = (where: Info | undefined, info: Info | undefined) => !where || Object.entries(where).every(([field, value]) => info?.[field] === value);

/** What a process does when its planned kill is due at a crossing. Default: it ends itself with SIGKILL. A process under a supervisor asks it instead (`askToBeKilled`): the supervisor writes the kill line first and kills it through the place. */
export type Kill = (crossing: Crossing) => void;
const selfKill: Kill = () => { process.kill(process.pid, 'SIGKILL'); };

/** Asks the supervisor to kill this process at the crossing, and waits: the request is a file (whole, by rename), the wait blocks this thread, and the supervisor's kill ends it.
 *  If nobody answers in a minute it kills itself, so a lost supervisor leaves no process parked for good. */
export function askToBeKilled(file: string): Kill {
  return (crossing) => {
    const whole = `${file}.${process.pid}`;
    writeFileSync(whole, JSON.stringify(crossing));
    renameSync(whole, file);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    process.kill(process.pid, 'SIGKILL');
  };
}

/** The child's crossing function for the kills planned for this process (none: it only logs). */
export function crossings(plan: ChildPlan | undefined, log: string | undefined, started = Date.now(), kill: Kill = selfKill, window: EffectWindow = { open: 0 }): Cross {
  let n = 0;
  // A storm takes no crossing before the process has opened the journal and begun its first node: a kill earlier than that leaves a generation the journal never recorded.
  let begun = false;
  // Per kill: how many crossings it names (its point and `where`) were taken, and how many of those could have been kill points.
  const seen = new Map<unknown, number>();
  const eligible = new Map<unknown, number>();
  const done = new Set<number>();
  let parkedCount = 0;
  let killAsked = false;
  const cross = ((point: string, options: { cut?: boolean; info?: Info } = {}) => {
    // A crossing taken while any tool call is between its dispatch and its kept answer is never a run kill point, whichever seam it is at: a kill there would leave that call unknown.
    const cut = options.cut !== false && window.open === 0;
    if (cut) n += 1;
    const count = (map: Map<unknown, number>, kill: unknown, hit: boolean) => { const value = (map.get(kill) ?? 0) + (hit ? 1 : 0); map.set(kill, value); return value; };
    const info = options.info;
    if (log) appendFileSync(log, `${JSON.stringify({ point, n: cut ? n : 0, pid: process.pid, ...(info ? { info } : {}) } satisfies Crossing)}\n`);
    // A run kill's `n` counts the matching crossings that could have been kill points: one suppressed by an open tool call is not the nth time, it is not a time at all. A crossing a tool kill takes still counts, so it is counted before that kill returns.
    const run = plan?.run;
    const timesEligible = cut && run && !('storm' in run) ? count(eligible, run, run.point === point && matches(run.where, info)) : 0;
    // A tool box destroyed at its crossing: once, at the nth matching time (a crossing that is not a kill point can be one: the box is the caller's to end).
    let tool = -1;
    plan?.tools.forEach((entry, index) => {
      if (!('point' in entry) || entry.point !== point || !matches(entry.where, info)) return;
      const times = count(seen, entry, true);
      if (tool < 0 && !done.has(index) && times === entry.n) tool = index;
    });
    // A tool kill that fired is written to the log beside the crossings (n 0: it is no kill point), so the supervisor can tell a tool kill that landed from one that never did.
    if (tool >= 0) { done.add(tool); if (log) appendFileSync(log, `${JSON.stringify({ point, n: 0, pid: process.pid, landed: true, ...(info ? { info } : {}) } satisfies Crossing)}\n`); return true; }
    if (!cut || !run) { if (point === 'event workflow.node.start') begun = true; return false; }
    // A kill with `hold` is taken by `park`, not here: the crossing parks the nth filing and the ones after it.
    if (!('storm' in run) && run.hold !== undefined) return false;
    // A named point is taken as named; a storm waits for the first node to have begun.
    const due = 'storm' in run ? begun && point !== 'event workflow.node.start' && Date.now() - started >= run.gapMs : run.point === point && matches(run.where, info) && timesEligible === run.n;
    if (point === 'event workflow.node.start') begun = true;
    if (due) kill({ point, n, pid: process.pid });
    return false;
  }) as Cross;
  (cross as { park: NonNullable<Cross['park']> }).park = (point, info) => {
    const run = plan?.run;
    if (!run || 'storm' in run || run.hold === undefined || run.point !== point || !matches(run.where, info) || window.open > 0) return undefined;
    // The nth time the point is reached, counting the crossings that could have been kill points (the call that follows this one in `cross` has already counted this one).
    if ((eligible.get(run) ?? 0) < run.n) return undefined;
    parkedCount += 1;
    // The kill waits for every tool call to return its kept answer: a parallel branch may have started one while the filing was parked, and a kill then would leave that call unknown.
    const ask = () => { if (killAsked) return; if (window.open > 0) { setTimeout(ask, 20).unref(); return; } killAsked = true; kill({ point, n, pid: process.pid }); };
    if (parkedCount === 1) setTimeout(ask, run.waitMs ?? 3000).unref();
    if (parkedCount >= run.hold) ask();
    return new Promise<never>(() => {});
  };
  return cross;
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
  // A look the eyes have answered is a memo by the time it is filed: `vision.filing` is the answer kept and the look not yet filed, so a kill there makes the next
  // process file the kept answer and not ask the eyes again.
  host.evidence = { file: async (label, record) => {
    const [filing, filed] = record.tool === 'look' ? ['vision.filing', 'vision.filed'] : [`receipt.filing ${record.tool}`, `receipt.filed ${record.tool}`];
    cross(filing);
    // A planned kill that holds parks this filing (and the ones after it): the answers are kept, none is filed.
    const parked = cross.park?.(filing);
    if (parked) await parked;
    const done = await evidence.file(label, record);
    cross(filed);
    return done;
  } };
  host.status = (event: StatusEvent) => {
    cross(`event ${event.source}.${event.source === 'workflow' ? event.event.type : 'change' in event ? event.change : 'look' in event ? 'look' : 'miss' in event ? 'miss' : 'reconciled'}`);
    return status(event);
  };
  host.deliver = async (result) => { cross('deliver.writing'); await deliver(result); cross('deliver.written'); };
}
