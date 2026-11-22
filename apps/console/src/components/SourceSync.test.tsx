import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { SourceSyncPanel } from './SourceSync';
import { createClient } from '@/lib/client';
import { SERVED_AGENT } from '@/test/agent';
import type { Agent } from '@/lib/agentForm';
import type { SourceSyncStatus } from '@/lib/sourceSync';
import '@/test/picker';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; });
const ready: SourceSyncStatus = { enabled: true, moved: false, state: 'ready', blockers: [], files: 8, skills: 1, tools: 2, snapshot: 'source-a' };
const agent: Agent = { ...SERVED_AGENT, agent_id: 'same-agent', revision: 'before', kind: 'agentic', revisions: 1, archived_at: null, definition: { version: 1, name: 'Existing agent', tools: [], skills: [] } };
async function show(status: SourceSyncStatus, onFetch?: (path: string, method: string, body: unknown) => unknown | Promise<unknown>) {
  let current = agent;
  const calls: { path: string; method: string; body: unknown }[] = [];
  const client = createClient({ fetch: (async (url, init) => {
    const path = new URL(String(url), 'https://console.example.test').pathname, method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    const answer = await onFetch?.(path, method, body) ?? status;
    return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement('div')); root = createRoot(host);
  const render = () => root.render(createElement(SourceSyncPanel, { agent: current, v2: client, onAgent: saved => { current = saved; render(); } }));
  await act(async () => render());
  return { host, calls, current: () => current };
}
it('moves the same agent with one click and keeps sync on', async () => {
  const after = { ...agent, revision: 'managed', source_sync: { moved: true as const } };
  const moved: SourceSyncStatus = { ...ready, moved: true, state: 'moved' };
  const x = await show(ready, path => path.endsWith('/move') ? { agent: after, source: moved } : undefined);
  expect(x.host.textContent).toContain('Ready to move');
  const button = [...x.host.querySelectorAll('button')].find(button => button.textContent === 'Move to AgentRun')!;
  await act(async () => button.click());
  expect(x.calls.filter(call => call.method === 'POST')).toEqual([{ path: '/v2/agents/same-agent/source/move', method: 'POST', body: {} }]);
  expect(x.current().agent_id).toBe('same-agent');
  expect(x.current().revision).toBe('managed');
  // The fixture's later poll is made ready to match the new server state in the separate stale-read test.
  expect(x.host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
});
it('shows a named prerequisite and refuses to offer an actionable Move', async () => {
  const x = await show({ ...ready, state: 'needs_attention', blockers: [{ code: 'tool_connection', message: 'Connect the issue tracker account.' }] });
  expect(x.host.textContent).toContain('Connect the issue tracker account.');
  expect([...x.host.querySelectorAll('button')].find(button => button.textContent === 'Move to AgentRun')?.disabled).toBe(true);
  expect(x.calls.every(call => call.method === 'GET')).toBe(true);
});
it('pauses sync without changing managed execution or the visible agent', async () => {
  const moved: SourceSyncStatus = { ...ready, moved: true, state: 'moved' };
  const x = await show(moved, (_path, method, body) => method === 'PATCH' ? { ...moved, enabled: false, state: 'paused', request: body } : undefined);
  await act(async () => x.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(x.calls.find(call => call.method === 'PATCH')?.body).toEqual({ enabled: false });
  expect(x.host.textContent).toContain('Runs on AgentRun');
  expect(x.host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  expect(x.current().agent_id).toBe('same-agent');
});
it('an old status read cannot overwrite a successful move', async () => {
  let resolveOld!: (value: unknown) => void, reads = 0, moved = false;
  const current: SourceSyncStatus = { ...ready, state: 'moved', moved: true };
  const x = await show(ready, (path, method) => {
    if (path.endsWith('/move')) { moved = true; return { agent: { ...agent, revision: 'managed', source_sync: { moved: true } }, source: current }; }
    if (method === 'GET' && ++reads === 2) return new Promise(resolve => { resolveOld = resolve; });
    return moved ? current : ready;
  });
  const learningNotice = 'After Move, AgentRun can learn checked workflows using your learning settings. Background checks use isolated project copies; their file changes do not replace your saved project.';
  expect(x.host.textContent).toContain(learningNotice);
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => [...x.host.querySelectorAll('button')].find(button => button.textContent === 'Move to AgentRun')!.click());
  await act(async () => resolveOld(ready));
  expect(x.host.textContent).toContain('Runs on AgentRun');
  expect(x.host.textContent).not.toContain('Ready to move');
  expect(x.host.textContent).toContain(learningNotice);
});

it('requires an explicit choice before replacing managed files and pins the reviewed versions', async () => {
  const state: SourceSyncStatus = { ...ready, moved: true, state: 'conflict', snapshot: 'new-source', blockers: [{ code: 'managed_changes', message: 'Choose which files to keep.' }] };
  const x = await show(state, path => path.endsWith('/resolve') ? { agent: { ...agent, revision: 'resolved' }, source: { ...state, state: 'moved' } } : undefined);
  await act(async () => [...x.host.querySelectorAll('button')].find(button => button.textContent === 'Use source version')!.click());
  expect(x.calls.every(call => call.method === 'GET')).toBe(true);
  expect(document.body.textContent).toContain('remain in revision history');
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Use source version')!.click());
  expect(x.calls.find(call => call.path.endsWith('/resolve'))?.body).toEqual({ revision: 'before', snapshot: 'new-source' });
  expect(x.current().revision).toBe('resolved');
});
it('upgrades only the existing source connector and preserves its execution scopes', async () => {
  const state: SourceSyncStatus = { enabled: false, moved: false, state: 'needs_connection', blockers: [], connection: { connector_id: 'source-connector', target_id: 'project' } };
  const x = await show(state, path => path.endsWith('/enrollment') ? { enrollment_token: 'fixture-once', expires_at: new Date(Date.now() + 600_000).toISOString(), workspace_id: 'local' } : path === '/v2/connectors' ? { connectors: [{ connector_id: 'source-connector', capabilities: { native_execution: false, history_import: true } }] } : undefined);
  await act(async () => [...x.host.querySelectorAll('button')].find(button => button.textContent === 'Enable sync')!.click());
  expect(x.calls.find(call => call.path.endsWith('/enrollment'))?.body).toEqual({ connector_id: 'source-connector', capabilities: { native_execution: false, history_import: true, config_sync: true } });
  expect(document.body.querySelector<HTMLInputElement>('input')?.value).toBe('fixture-once');
  expect(document.body.textContent).toContain('secure terminal prompt');
});
it('offers an explicit destination account choice for a required source tool', async () => {
  const x = await show({ ...ready, state: 'needs_attention', tool_connections: [{ name: 'tracker', ready: false, candidates: [{ name: 'work-account', auth: 'oauth' }] }] }, path => path.endsWith('/tools') ? ready : undefined);
  await act(async () => x.host.querySelector<HTMLButtonElement>('[aria-label="Connection for tracker"]')!.click());
  await act(async () => document.querySelector<HTMLElement>('[role="option"][data-value="work-account"]')!.click());
  expect(x.calls.find(call => call.path.endsWith('/tools'))?.body).toEqual({ tool: 'tracker', server: 'work-account' });
});

it('pins the unresolved receipts shown when the owner opens project recovery', async () => {
  const problem: SourceSyncStatus = { ...ready, moved: true, state: 'needs_attention', project_issues: [{ run_id: 'first-run', entry_id: 4, status: 'uncertain' }] };
  let latest = problem;
  const x = await show(problem, path => path.endsWith('/project-review') ? { ...ready, moved: true, state: 'moved' } : latest);
  await act(async () => [...x.host.querySelectorAll('button')].find(button => button.textContent === 'Continue with saved project')!.click());
  latest = { ...problem, project_issues: [{ run_id: 'first-run', entry_id: 9, status: 'uncertain' }] };
  await act(async () => window.dispatchEvent(new Event('focus')));
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Use saved project')!.click());
  expect(x.calls.find(call => call.path.endsWith('/project-review'))?.body).toEqual({ receipts: [{ run_id: 'first-run', entry_id: 4 }] });
});
