import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPage } from './AgentPage';
import { AgentsList } from './AgentsList';
import { RunDetail } from './RunDetail';
import { Playground } from './Playground';
import { AgentEditPage } from './AgentsPage';
import type { Agent } from '@/lib/agentForm';
import type { Run } from '@/lib/v2';

vi.mock('./CodingAgentAction', () => ({ CodingAgentAction: ({ label, prompt, playgroundHref }: { label: string; prompt: string; playgroundHref?: string }) =>
  <button data-handoff={label} data-prompt={prompt} data-playground={playgroundHref}>{label}</button> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; });
const agent = (runtime: 'claude-agent-sdk' | 'codex-sdk'): Agent => ({ agent_id: 'backend', kind: 'agentic', revision: 'r1', revisions: 1, archived_at: null,
  definition: { version: 1, name: 'Release backend', instructions: 'Report accurately.', sdk: { runtime }, tools: [], skills: [], learning: 'notes' }, runs: { count: 0, live: 0 } });
const settle = async () => { for (let n = 0; n < 5; n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const show = (element: React.ReactElement) => {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host); act(() => root!.render(element)); return host;
};

describe('backend SDK agents', () => {
  it('a direct playground link offers backend handoff without a managed request', () => {
    const host = show(createElement(Playground, { agents: [agent('codex-sdk')], agentId: 'backend', efforts: [], origin: 'https://server.example', onSend: vi.fn() }));
    expect(host.textContent).not.toContain('Send request');
    expect(host.textContent).not.toContain('/agents/backend/runs');
    expect(host.querySelector('[data-handoff="Run agent"]')?.getAttribute('data-prompt')).toContain('existing backend');
  });

  it('a direct edit link offers source editing without a managed definition form', async () => {
    const v2 = { getAgent: async () => ({ agent: agent('codex-sdk'), etag: 'r1' }), listRevisions: async () => ({ revisions: [], next_cursor: null }), computers: async () => ({ kinds: [] }), toolSettings: async () => ({}) };
    const host = show(createElement(AgentEditPage, { agentId: 'backend', v2: v2 as never, caps: { tools: [], harnesses: [] } as never, go: () => {} }));
    await settle();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[data-handoff="Edit agent"]')?.getAttribute('data-prompt')).toContain('existing backend');
  });

  for (const [runtime, label] of [['claude-agent-sdk', 'Claude Agent SDK'], ['codex-sdk', 'Codex SDK']] as const) {
    it(`${label} shows backend facts and delegates editing/running to its source application`, async () => {
      const a = agent(runtime);
      const v2 = { getAgent: async () => ({ agent: a, etag: 'r1' }), statsOver: async () => ({}), listAgentRuns: async () => ({ runs: [], next_cursor: null }) };
      const host = show(createElement(AgentPage, { agentId: a.agent_id, v2: v2 as never, go: () => {}, learning: 'on', harnesses: [{ id: 'pi', available: true, default_model: 'server-model' }] as never }));
      await settle();
      const facts = host.querySelector('dl[aria-label="Current revision"]')!.textContent!;
      expect(facts).toContain(label);
      expect(facts).toContain('Reported per run');
      expect(facts).toContain('Your backend');
      expect(facts).not.toContain('server-model');
      expect(facts).not.toContain('Harnesspi');
      expect(host.querySelector('[role="tab"][id$="learning"]') ?? [...host.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'Learning')).toBeTruthy();
      for (const action of host.querySelectorAll('[data-handoff="Edit agent"], [data-handoff="Run agent"]')) {
        expect(action.getAttribute('data-playground')).toBeNull();
        expect(action.getAttribute('data-prompt')).toContain('existing backend');
        expect(action.getAttribute('data-prompt')).toContain('learning wrapper');
      }
    });

    it(`${label} also identifies the runtime on the agent card without a managed launch`, () => {
      const host = show(createElement(AgentsList, { agents: [agent(runtime)] }));
      expect(host.textContent).toContain(label);
      const action = host.querySelector('[data-handoff="Run Release backend"]')!;
      expect(action.getAttribute('data-playground')).toBeNull();
      expect(action.getAttribute('data-prompt')).toContain('existing backend');
    });
  }

  it('SDK runs offer observation and archive, while control and follow-up remain in the backend', () => {
    const run = { sha: null, run_id: 'sdk-run', agent_id: 'backend', agent_version: 1, revision: 'r1', kind: 'agentic', status: 'working', state: 'working', title: 'Deploy report',
      updated_at: '2026-11-12T12:00:00Z', created_at: '2026-11-12T12:00:00Z', ended_at: null, poll_after_ms: 1000, place: { mode: 'runner' }, result: null, error: null, archived_at: null,
      cost: { usd: null, basis: 'estimate', charge_state: null, cap_usd: 1 }, sdk: { runtime: 'codex-sdk', model: 'actual-model', session_id: 'thread', learning_revision: null, usage: null } } as unknown as Run;
    const host = show(createElement(RunDetail, { run, agentName: 'Release backend', messages: { steer: true, follow_up: true } as never, harnessSteers: true, rows: [], files: [], onMessage: vi.fn(), actions: { onStop: vi.fn(), onCancel: vi.fn(), onArchive: vi.fn(), onRaiseCap: vi.fn() } }));
    const buttons = [...host.querySelectorAll('button')].map(button => button.textContent?.trim());
    expect(buttons).not.toContain('Stop');
    expect(buttons).not.toContain('Cancel run');
    expect(buttons).not.toContain('Raise the cap');
    expect(buttons).toContain('Archive');
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).toContain('your backend');
  });
});
