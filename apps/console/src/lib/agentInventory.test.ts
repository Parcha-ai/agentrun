import { expect, it } from 'vitest';
import { agentInventory } from './agentInventory';
import { SERVED_AGENT } from '@/test/agent';
import type { Agent } from './agentForm';
import type { ObservedSession } from './observations';
const agent: Agent = { ...SERVED_AGENT, agent_id: 'durable-agent', revision: 'moved', kind: 'agentic', revisions: 2, archived_at: null,
  definition: { version: 2, name: 'Project agent', tools: [], skills: [] }, source_sync: { moved: true } };
const session: ObservedSession = { id: 'source-session', connector_id: 'source', source_id: 'machine', external_session_id: 'native-session', harness: 'codex',
  activity: 'working', reported_activity: 'working', connection_state: 'online', selection_active: true, occurred_at: '', received_at: '', created_at: '', updated_at: '', sequence: 1,
  display_name: 'Source task title', models: [], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, cache_read_tokens: 0, cache_write_tokens: 0, cache_hit_rate: 0 },
  observation_only: true, learning: { state: 'off', agent_id: agent.agent_id, connection_id: 'capture' } };
it('shows one moved agent while preserving source title search through its verified association', () => {
  const shown = agentInventory([agent], [session]);
  expect(shown.agents).toEqual([agent]); expect(shown.sessions).toEqual([]); expect(shown.count).toBe(1);
  expect(agentInventory([agent], [session], { query: 'Source task title' }).agents).toEqual([agent]);
  expect(session.usage.total_tokens).toBe(13);
});
it('does not collapse source sessions by matching titles, paths or unverified associations', () => {
  const unbound = { ...session, display_name: agent.definition.name, learning: undefined };
  expect(agentInventory([agent], [unbound]).count).toBe(2);
  expect(agentInventory([agent], [{ ...session, learning: { state: 'unknown' as const } }]).sessions).toHaveLength(1);
});
it('a moved agent remains reachable while source telemetry is unavailable or archived', () => {
  expect(agentInventory([agent], []).agents).toEqual([agent]);
  const archived = { ...agent, archived_at: '2026-11-20T00:00:00Z' };
  expect(agentInventory([archived], [session], { archived: true }).agents).toEqual([archived]);
  expect(agentInventory([archived], [session], { archived: true }).sessions).toEqual([]);
});
it('matches words across the managed agent and multiple verified source sessions', () => {
  const followup = { ...session, id: 'followup', display_name: 'Refund followup' };
  expect(agentInventory([agent], [session, followup], { query: 'PROJECT refund title codex' }))
    .toEqual({ agents: [agent], sessions: [], count: 1 });
});
it('does not use an unrelated source session to match a moved agent', () => {
  const unrelated = { ...session, id: 'unrelated', display_name: 'Refund followup', learning: { ...session.learning!, agent_id: 'other-agent' } };
  expect(agentInventory([agent], [session, unrelated], { query: 'Project refund' }))
    .toEqual({ agents: [], sessions: [], count: 0 });
  expect(agentInventory([agent], [session, unrelated]).count).toBe(2);
});
it('does not make absent source fields searchable as undefined', () => {
  expect(agentInventory([agent], [session], { query: 'undefined' }).count).toBe(0);
});
