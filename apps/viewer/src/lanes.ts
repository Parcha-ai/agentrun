// The timeline's lanes, from the whole recording: what they draw does not change with the scrub point, only the
// playhead does. The process lane comes from the supervisor's host lines (RECORDING.md section 4 rule 3).
import { processOf, restoresOf, type Line } from './format.ts';
import { docOf, effectIdOf, effectOf, entryOf, generationOf, toolCallsOf } from './durable.ts';

export type Band = { process: number; from: number; to: number; kill?: { t: number; label: string; crossing?: string } };
export type Span = { id: string; label: string; from: number; to?: number; status: 'done' | 'open' | 'failed'; path?: string; gen?: number };
export type Lanes = { end: number; processes: Band[]; opens: { t: number; generation: number }[]; restores: { t: number; to: number }[]; calls: Span[]; turns: Span[] };

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

export function lanesOf(lines: Line[]): Lanes {
  const end = lines.length ? lines.at(-1)!.t : 0;
  const processes: Band[] = [];
  const opens: Lanes['opens'] = [];
  const calls = new Map<string, Span>();
  const turns: Span[] = [];
  const turnStarts = new Map<string, { t: number; gen: number | undefined }>();
  let lastOpens = 0;
  const restoreAt = restoresOf(lines);
  const restores: Lanes['restores'] = [];
  lines.forEach((line, index) => {
    if (restoreAt.has(index)) restores.push({ t: line.t, to: restoreAt.get(index)! });
    if (line.source === 'host' && line.kind === 'process.started') {
      const open = processes.at(-1);
      if (open && open.to === end && !open.kill) open.to = line.t;
      processes.push({ process: processOf(line) ?? processes.length + 1, from: line.t, to: end });
    }
    if (line.source === 'host' && line.kind === 'kill') {
      const killed = processOf(line);
      const band = [...processes].reverse().find((each) => each.process === killed) ?? processes.at(-1);
      // The crossing the kill landed on: `{ point, n }`, or null for a kill at no named crossing.
      const data = line.data as { label?: unknown; crossing?: { point?: unknown } | null };
      const point = text(data?.crossing?.point);
      if (band) { band.to = line.t; band.kill = { t: line.t, label: text(data?.label) ?? 'killed', ...(point ? { crossing: point } : {}) }; }
      // A turn this process started and never answered is one the kill cut.
      for (const [conv, start] of turnStarts) if (start.gen === killed) {
        turns.push({ id: `turn ${conv} cut ${line.t}`, label: 'turn cut by the kill', from: start.t, to: line.t, status: 'failed', ...(start.gen ? { gen: start.gen } : {}) });
        turnStarts.delete(conv);
      }
    }
    if (line.source === 'pi' && line.kind === 'turn_start') {
      turnStarts.set(`${line.conv ?? '?'}`, { t: line.t, gen: line.gen });
    }
    const doc = docOf(line);
    if (doc) {
      const generation = generationOf(doc);
      if (generation !== undefined && generation > lastOpens) { opens.push({ t: line.t, generation }); lastOpens = generation; }
      const effect = effectOf(doc);
      if (effect && doc.key !== undefined) {
        const id = `effect ${effectIdOf(doc.key)}`;
        const span = calls.get(id);
        if (!span) calls.set(id, { id, label: effect.intent?.tool ?? effect.name, from: line.t, status: 'open', ...(line.path ? { path: line.path } : {}), ...(line.gen ? { gen: line.gen } : {}) });
        if (effect.status === 'completed') { const done = calls.get(id)!; done.to = line.t; done.status = 'done'; }
      }
    }
    const entry = entryOf(line);
    if (entry) for (const message of entry.model) {
      if (message.role === 'assistant') {
        const conv = `${line.conv ?? '?'}`;
        const committed = turns.filter((turn) => turn.id.startsWith(`turn ${conv} `) && turn.status === 'done').length;
        turns.push({ id: `turn ${conv} ${committed}`, label: `turn ${committed}`,
          from: turnStarts.get(conv)?.t ?? line.t, to: line.t, status: 'done', ...(line.path ? { path: line.path } : {}) });
        turnStarts.delete(conv);
        for (const call of toolCallsOf(message)) calls.set(`tool ${call.id}`, { id: `tool ${call.id}`, label: call.name, from: line.t, status: 'open', ...(line.path ? { path: line.path } : {}) });
      }
      if (message.role === 'toolResult' && message.toolCallId) {
        const span = calls.get(`tool ${message.toolCallId}`);
        if (span) { span.to = line.t; span.status = message.isError ? 'failed' : 'done'; }
      }
    }
  });
  // A turn started and never answered: what a kill cut.
  for (const [conv, start] of turnStarts) turns.push({ id: `turn ${conv} open`, label: 'turn in flight', from: start.t, status: 'open' });
  return { end, processes, opens, restores, calls: [...calls.values()], turns };
}
