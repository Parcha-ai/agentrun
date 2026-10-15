// Crossings: the named points a process takes as it runs, and the kill that ends it at one. The child counts its crossings as it takes them, writes each
// to `CROSS_LOG` so a process that dies leaves them behind, and ends itself with SIGKILL at the planned one. A crossing is never a clock: where a kill lands
// is a fact of the run. A package adds its own crossings through the same `cross` function (`vision.filing`), so `kills[].point` can name them.
import { appendFileSync } from 'node:fs';
import type { Fakes, Host, StatusEvent } from './host.ts';
import type { Plan } from './demo-spec.ts';

/** `cut: false` logs a crossing that is never a kill point. */
export type Cross = (point: string, options?: { cut?: boolean }) => void;
export type Crossing = { point: string; n: number; pid: number };

/** The child's crossing function for the kill planned for this process (none: it only logs). */
export function crossings(plan: Plan | undefined, log: string | undefined, started = Date.now()): Cross {
  let n = 0;
  return (point, options = {}) => {
    const cut = options.cut !== false;
    if (cut) n += 1;
    if (log) appendFileSync(log, `${JSON.stringify({ point, n: cut ? n : 0, pid: process.pid } satisfies Crossing)}\n`);
    if (!cut || !plan) return;
    if ('storm' in plan ? Date.now() - started >= plan.gapMs : plan.point === point) process.kill(process.pid, 'SIGKILL');
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
    tools: Object.fromEntries(Object.entries(fakes.tools).map(([name, tool]) => [name, async (args: Record<string, unknown>) => {
      // Between a tool's dispatch and the host keeping its answer nothing records what the tool did: a kill there leaves the effect unknown, for an operator.
      cross(`tool.dispatch ${name}`, { cut: false });
      const result = await tool(args);
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

/** The host with a crossing at each of its seams: the span after the host keeps a tool's answer and before the driver commits it (`effect.kept`, cut only
 *  when no other call is between its dispatch and its kept answer: a kill there would leave that one unknown), an evidence filing, each row of events, the delivery. */
export function tapHost(host: Host, cross: Cross): void {
  const { runEffect } = host.tools;
  let inFlight = 0;
  host.tools = { ...host.tools, runEffect: async (request) => {
    inFlight += 1;
    let value: unknown;
    try { value = await runEffect(request); } finally { inFlight -= 1; }
    cross(`effect.kept ${request.node.tool}`, { cut: inFlight === 0 });
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
