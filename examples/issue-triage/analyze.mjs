// node examples/issue-triage/analyze.mjs <recording dir> <run dir>: what a (killed) take's stores show, at no cost: Jev requests sent against distinct answers, tool calls made, and for each
// agent conversation the model turns asked and committed in each process. Pass the run's directory with `--dir` (the recording alone has no request counter or tool ledger).
import fs from 'node:fs';
const [rec, run] = process.argv.slice(2);
const L = fs.readFileSync(`${rec}/events.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const spent = fs.readFileSync(`${run}/judge-spent.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const requests = spent.reduce((a, r) => a + r.requests, 0), tokens = spent.reduce((a, r) => a + r.tokens, 0);
const hashes = new Set(); for (const l of L.filter((l) => l.kind === 'agentrun.decisions')) for (const r of l.data.value.receipts || []) hashes.add(r.request_sha256);
const answered = {}; for (const l of L.filter((l) => l.kind === 'judge.answered')) answered[l.gen] = (answered[l.gen] || 0) + 1;
const led = fs.readFileSync(`${run}/ledger.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); const handled = {}; for (const r of led) if (r.kind === 'tool') handled[r.name] = (handled[r.name] || 0) + 1;
// The ledger has one row for each call the host handled (a send that was retried counts once); the effects' own records say how each send ended, so a repeated send shows there.
const last = new Map(); for (const l of L.filter((l) => l.kind === 'agentrun.effects')) last.set(l.data.key, l.data.value);
const sends = {}; for (const v of last.values()) for (const c of v.calls || []) { const k = `${c.tool}: ${c.outcome}`; sends[k] = (sends[k] || 0) + 1; }
console.log('JEV: requests sent', requests, 'tokens', tokens, '| distinct request hashes in receipts', hashes.size, '| judge.answered by generation', JSON.stringify(answered));
console.log('TOOLS handled by the host (one per call, a retried send counts once):', JSON.stringify(handled), '| sends by outcome, from the effects records:', JSON.stringify(sends));
const C = {}; const c = (k) => C[k] || (C[k] = { asked: { 1: 0, 2: 0 }, committed: { 1: 0, 2: 0 }, seen: new Set(), k });
for (const l of L) { if (l.conv === undefined) continue; const o = c(l.conv);
  if (l.kind === 'message_start' && l.data.message && l.data.message.role === 'assistant') o.asked[l.gen]++;
  if (l.kind === 'pi.assistant') for (const m of l.data.model || []) { const key = JSON.stringify([m.timestamp, m.usage && m.usage.totalTokens, m.usage && m.usage.output]); if (!o.seen.has(key)) { o.seen.add(key); o.committed[l.gen]++; } } }
const G = {}; for (const l of L.filter((l) => l.kind === 'pi.generation')) { const d = l.data; const g = G[d.id] || (G[d.id] = { conv: d.conversationId, seq: [] }); g.seq.push([l.gen, d.state && d.state.status, d.state && d.state.checkpoint && d.state.checkpoint.phase, d.state && d.state.checkpoint && d.state.checkpoint.attempt]); }
const rows = Object.values(C).filter((o) => o.asked[1] + o.asked[2] + o.committed[1] + o.committed[2] > 0); const s = (f) => rows.reduce((a, o) => a + f(o), 0);
console.log('MODEL: generations', Object.keys(G).length, '| asked gen1', s((o) => o.asked[1]), 'gen2', s((o) => o.asked[2]), '| distinct committed', s((o) => o.seen.size), '| generations with attempt>1:', Object.values(G).filter((g) => Math.max(...g.seq.map((x) => x[3] || 1)) > 1).length);
for (const o of rows.filter((o) => o.asked[2] > 0 || o.committed[2] > 0)) console.log('  conv', o.k, '| gen1 asked', o.asked[1], 'committed', o.committed[1], 'in flight', o.asked[1] - o.committed[1], '| gen2 asked', o.asked[2], 'newly committed', o.committed[2]);
const both = Object.values(G).filter((g) => new Set(g.seq.map((x) => x[0])).size > 1); console.log('  generations seen in both processes:', both.length, both.map((g) => `conv ${g.conv}: ${g.seq.map((x) => x.join(':')).join(' > ')}`).join(' || ').slice(0, 600));
const kill = L.find((l) => l.kind === 'kill'); console.log('KILL line:', JSON.stringify(kill && { gen: kill.gen, label: kill.label, crossing: kill.crossing, kind: kill.kind }));
console.log('process.started lines:', L.filter((l) => l.kind === 'process.started').length, '| result line:', JSON.stringify(L.filter((l) => l.kind === 'result').map((l) => l.data && (l.data.status || l.data.outcome)).slice(-1)));
