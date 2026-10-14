// The audit with no key: the facts come from a capture of a real project (`capture.ts`), and a scripted lead and a scripted
// judge stand in for the models. The repository pages are fixtures built from the captured GitHub facts, served by the fake
// browser. Everything it records says `scripted`; nothing here is a model's judgment.
import { appendFileSync } from 'node:fs';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { DriverFactory, PageDriver } from '@parcha/pi-browser/durable';
import { FakeBackend, fakeDriver, fixturePage } from '@parcha/pi-browser/testing';
import type { Fixture } from './capture.ts';
import type { BrowserPlane, Fakes } from '../reference/index.ts';
import { makeTools, type InstallProbe } from './tools.ts';

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));

/** The first JSON object in a node's prompt that carries `key`. */
function stateOf(prompt: string, key: string): Record<string, unknown> | undefined {
  for (let start = prompt.indexOf('{'); start >= 0; start = prompt.indexOf('{', start + 1)) {
    for (let end = prompt.lastIndexOf('}'); end > start; end = prompt.lastIndexOf('}', end - 1)) {
      try { const parsed = JSON.parse(prompt.slice(start, end + 1)) as Record<string, unknown>; if (key in parsed) return parsed; } catch { /* not this slice */ }
    }
  }
  return undefined;
}

type Cited = { path: string; sha256: string; url: string };
type Fact = { claim: string; source: string; receipt: string };

/** What the page of a repository says, built from the captured GitHub facts. */
export function repoPages(fixture: Fixture) {
  const pages: Record<string, ReturnType<typeof fixturePage>> = {};
  for (const [url, repo] of Object.entries(fixture.repos)) {
    if (!repo) continue;
    pages[url] = fixturePage(url, `${url.replace('https://github.com/', '')}\n${repo.archived ? 'This repository was archived by the owner. It is now read-only.' : 'Public repository.'}\nLast push: ${repo.pushed_at}`, url.replace('https://github.com/', ''));
    pages[`${url}/releases`] = fixturePage(`${url}/releases`, repo.last_release ? `Releases\n${repo.last_release_tag}  Latest\nPublished ${repo.last_release}` : 'Releases\nThere aren\'t any releases here', 'Releases');
  }
  return pages;
}

export function scriptedFakes(fixture: Fixture, root: string, probe?: InstallProbe): Fakes {
  const pages = repoPages(fixture);
  const tools = makeTools({ root, source: { replay: fixture }, ...(probe ? { probe } : {}) });

  /** The repository agent: open the repository page, read it, open its releases page, read it, report. */
  const repositoryAgent = (messages: readonly Message[], prompt: string): AssistantMessage => {
    const state = stateOf(prompt, 'repository') ?? {};
    const repository = String(state.repository ?? '');
    const results = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
    if (!repository || !pages[repository]) return call('submit', { pages: [], archived: 'unknown', badges: [] });
    const reads = results.filter((result) => result.toolName === 'browser_read');
    const cited = (result: ToolResultMessage): Cited => {
      const text = textOf(result);
      return { path: /evidence: (\S+)/.exec(text)?.[1] ?? '', sha256: (result.details as { sha256?: string } | undefined)?.sha256 ?? '', url: /url: (\S+)/.exec(text)?.[1] ?? '' };
    };
    if (results.length === 0) return call('run', { code: `await page.goto(${JSON.stringify(repository)})` });
    if (results.length === 1) return call('browser_read', { what: 'text' });
    if (results.length === 2) return call('run', { code: `await page.goto(${JSON.stringify(`${repository}/releases`)})` });
    if (results.length === 3) return call('browser_read', { what: 'text' });
    const [repoRead, releasesRead] = reads;
    const archived = repoRead && /archived by the owner/.test(textOf(repoRead));
    const release = releasesRead ? /Published (\S+)/.exec(textOf(releasesRead))?.[1] : undefined;
    return call('submit', {
      pages: reads.map(cited), archived: repoRead ? (archived ? 'yes' : 'no') : 'unknown', ...(release ? { last_release: release } : {}), badges: [],
    });
  };

  /** The finding: every fact the input's receipts show, each with the receipt it came from. */
  const findingExtract = (prompt: string): AssistantMessage => {
    const state = stateOf(prompt, 'registry') ?? {};
    const registry = (state.registry ?? {}) as { receipt: string; deprecated?: string; scripts?: Record<string, string> };
    const advisories = (state.advisories ?? {}) as { receipt: string; ids?: string[]; summaries?: Record<string, string> };
    const install = (state.install ?? {}) as { receipt: string; ran?: boolean; note?: string; scripts?: string[]; outside?: string[] };
    const repository = (state.repository ?? {}) as { archived?: string; last_release?: string; pages?: Cited[]; badges?: Array<{ label: string; value: string; receipt: string }> };
    const facts: Fact[] = [];
    if (registry.deprecated) facts.push({ claim: `The registry marks this version deprecated: ${registry.deprecated}`, source: 'registry', receipt: registry.receipt });
    for (const [phase, command] of Object.entries(registry.scripts ?? {})) facts.push({ claim: `It declares an install-time ${phase} script: ${command}`, source: 'registry', receipt: registry.receipt });
    for (const id of advisories.ids ?? []) facts.push({ claim: `Advisory ${id} affects this version: ${advisories.summaries?.[id] ?? ''}`.trim(), source: 'advisories', receipt: advisories.receipt });
    if (install.ran === false) facts.push({ claim: `The install was not run in a box: ${install.note ?? ''}`.trim(), source: 'install', receipt: install.receipt });
    for (const host of install.outside ?? []) facts.push({ claim: `The install reached ${host}, which is not the package registry.`, source: 'install', receipt: install.receipt });
    const page = repository.pages?.[0];
    if (repository.archived === 'yes' && page) facts.push({ claim: 'The repository page says the repository is archived and read-only.', source: 'repository', receipt: page.path });
    if (repository.archived === 'unknown') facts.push({ claim: 'The repository was not read, so whether it is archived is not known.', source: 'repository', receipt: registry.receipt });
    if (repository.last_release && repository.pages?.[1]) facts.push({ claim: `The newest release on the releases page was published ${repository.last_release}.`, source: 'repository', receipt: repository.pages[1].path });
    for (const badge of repository.badges ?? []) facts.push({ claim: `A README badge reads ${badge.label}: ${badge.value}.`, source: 'badge', receipt: badge.receipt });
    return call('submit', { name: String(state.name ?? ''), version: String(state.version ?? ''), facts });
  };

  return {
    model(messages) {
      const prompt = textOf(messages.find((message) => message.role === 'user')!);
      if (process.env.AUDIT_DEBUG) appendFileSync(process.env.AUDIT_DEBUG, `${JSON.stringify({ n: messages.length, prompt: prompt.slice(0, 1500), last: messages.at(-1) && JSON.stringify(messages.at(-1)).slice(0, 700) })}\n`);
      // The node's instructions are its system prompt; its first user message is the state it was given.
      try { return stateOf(prompt, 'registry') ? findingExtract(prompt) : repositoryAgent(messages, prompt); } catch (error) { if (process.env.AUDIT_DEBUG) appendFileSync(process.env.AUDIT_DEBUG, `${JSON.stringify({ error: String((error as Error).stack).slice(0, 600) })}\n`); throw error; }
    },
    tools,
    // A scripted judge: the flag follows the cited facts by a fixed rule, so a replay is the same every time.
    judge: async ({ state, questions }) => {
      const facts = ((state as { facts?: Fact[] } | undefined)?.facts ?? []);
      const flag = facts.some((fact) => fact.source === 'advisories' || /not the package registry/.test(fact.claim)) ? 'act'
        : facts.some((fact) => /marks this version deprecated|says the repository is archived/.test(fact.claim)) ? 'notice' : 'clear';
      return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'choice' as const, choice: flag, confidence: 0.9, probabilities: { clear: flag === 'clear' ? 0.9 : 0.05, notice: flag === 'notice' ? 0.9 : 0.05, act: flag === 'act' ? 0.9 : 0.05 } }])), model: 'scripted', usage: null, cost_usd: null, latency_ms: 0, request_sha256: '' };
    },
    // Six branches at a time, four to six requests each, and a re-asked turn after a kill: room for a few hundred.
    responses: 1000,
    pages,
    start: 'about:blank',
  } as Fakes;
}

/** The fake browser, serving the captured repositories' pages. The fake has no navigation of its own: a `page.goto` the agent
 *  runs is turned into the fake's goto action, so each branch reads its own dependency's page. */
export function scriptedBrowser(fixture: Fixture): { backend: FakeBackend; plane: BrowserPlane } {
  const pages = repoPages(fixture);
  const backend = new FakeBackend({ start: 'about:blank', pages });
  const base = fakeDriver(backend) as DriverFactory<PageDriver>;
  const driver: DriverFactory<PageDriver> = async (...args) => {
    const page = await base(...args);
    return new Proxy(page, {
      get(target, name) {
        const member = Reflect.get(target, name, target);
        if (name === 'run') {
          return (input: { code?: string; actions?: unknown[] }) => {
            const go = /page\.goto\(\s*(['"`])(.+?)\1\s*\)/.exec(input.code ?? '');
            return (member as PageDriver['run']).call(target, go ? { actions: [{ op: 'goto', url: go[2] }] } : input);
          };
        }
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
  };
  return { backend, plane: { provider: () => backend.provider, driver, createDeadlineMs: 3_000 } };
}
