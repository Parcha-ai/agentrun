/** One token view over recorded runs and native observations. Requestless aggregates only establish a
 * lower bound on overlapping usage; select coherent views instead of assuming one completely covers another. */
import { createHash } from 'node:crypto';
import type { Store } from './store/store.js';
import type { AnalyticsFilter } from './store-reads/analytics.js';
import { runReadState } from './store-reads/runs.js';
import { isShadowRun } from './learn/audit.js';
import { DEFAULT_HARNESS } from './harness.js';
import { sdkInbox } from './sdk/runs.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { journalEntries } from './runner/journal-reader.js';
import { REQUEST_COST, runMetricsOf, type EntryLike } from './timeline/index.js';

const DAY = 86_400_000, RETENTION = 90 * DAY;
const fields = ['input', 'output', 'cache_read', 'cache_write'] as const;
type Counts = Record<typeof fields[number], number | null> & { tokens: number | null };
type Fact = Counts & { day: string; harness: string; runId?: string };
type Observed = { id: string; key: string; received: number; harness: string; facts: Fact[]; partial: Set<string> };
type Recorded = { id: string; fact: Fact; key?: string; imported: boolean; opaqueImport: boolean; sdk: boolean; window?: string };
export type UnifiedUsage = Counts & {
  known_runs: number; unknown_runs: number; observed_sessions: number; unknown_sessions: number;
  partial_days: number; retention_limited: boolean;
  by_day: { day: string; tokens: number | null }[];
  by_harness: { harness: string; tokens: number | null }[];
};
const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const plus = (values: number[]): number | null => { const sum = values.reduce((a, b) => a + b, 0); return Number.isSafeInteger(sum) ? sum : null; };
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const runtime = (value: unknown): string | undefined => typeof value === 'string'
  ? ['codex', 'codex-cli', 'codex-sdk'].includes(value) ? 'codex'
    : ['claude', 'claude-code', 'claude-code-cli', 'claude-agent-sdk'].includes(value) ? 'claude-code' : undefined : undefined;
const nativeKey = (harness: string | undefined, session: unknown) => harness && typeof session === 'string' && session
  ? `${harness}:${createHash('sha256').update(session).digest('hex')}` : undefined;
const empty = (): Counts => ({ tokens: null, input: null, output: null, cache_read: null, cache_write: null });
function runCounts(metrics: Record<string, any>): Counts {
  const result = { input: count(metrics.input), output: count(metrics.output), cache_read: count(metrics.cacheRead), cache_write: count(metrics.cacheWrite) };
  return { ...result, tokens: fields.every(key => result[key] !== null) ? plus(fields.map(key => result[key]!)) : null };
}
function sourceCounts(usage: Record<string, any>): Counts {
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  const read = count(usage.cache_read_tokens), write = count(usage.cache_write_tokens);
  return { tokens: input !== null && output !== null ? plus([input, output]) : null, output,
    input: input !== null && read !== null && write !== null && read + write <= input ? input - read - write : null,
    cache_read: read, cache_write: write };
}

export async function unifiedUsage(store: Store, filter: AnalyticsFilter = {}, now = Date.now()): Promise<UnifiedUsage> {
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  const archived = new Map<string, boolean>();
  const isArchived = async (agent: string) => {
    if (!archived.has(agent)) archived.set(agent, (await store.agents.get(agent))?.archivedAt != null);
    return archived.get(agent)!;
  };
  const runs: Recorded[] = [];
  const selectedNative = new Set<string>();
  const revisions = new Map<string, Awaited<ReturnType<Store['agents']['revision']>>>();
  for (const run of await store.runs.list(filter.agent ? { agentId: filter.agent } : {})) {
    if (run.archivedAt !== null || isShadowRun(run.id) || await isArchived(run.agentId)) continue;
    if (!revisions.has(run.revisionId)) revisions.set(run.revisionId, await store.agents.revision(run.revisionId));
    const revision = revisions.get(run.revisionId), body = object(revision?.body), metrics = object(run.metrics);
    const cli = object(body.cli_learning), sdk = object(body.sdk), native = object(body.native);
    let harness = metrics.cli_runtime ?? metrics.sdk_runtime ?? metrics.native_runtime ?? cli.runtime ?? sdk.runtime ?? native.runtime ?? run.importedFrom?.source ?? body.harness ?? DEFAULT_HARNESS;
    let session = metrics.cli_session_id ?? metrics.sdk_session_id ?? metrics.native_session_id ?? run.importedFrom?.session;
    let window: Record<string, any> = {};
    if (metrics.cli_runtime || Object.keys(cli).length) {
      const launch = object((await store.runs.launch(run.id).catch(() => undefined))?.body);
      window = object(launch.cli_learning);
      if (!session) { session = window.session_id; harness = window.runtime ?? harness; }
    }
    const key = nativeKey(runtime(harness), session);
    if (key) selectedNative.add(key);
    if (run.startedAt < from || run.startedAt >= to) continue;
    runs.push({ id: run.id, key, imported: run.importedFrom !== null,
      opaqueImport: Boolean(metrics.remote_history_sha256 || String(session).startsWith('redacted-')),
      ...(key && key === nativeKey(runtime(window.runtime), window.session_id) && typeof window.turn_id === 'string' && window.turn_id
        ? { window: window.turn_id } : {}),
      sdk: Boolean(metrics.cli_runtime || metrics.sdk_runtime || Object.keys(cli).length || Object.keys(sdk).length),
      fact: { ...(runReadState(run, revision?.kind === 'workflow' ? 'workflow' : 'agentic') === 'running' ? empty() : runCounts(metrics)),
      day: date(run.startedAt), harness: String(harness), runId: run.id } });
  }

  const connections = new Map<string, string | undefined>();
  const observed: Observed[] = [];
  let sourceSelected = false;
  for (const row of await store.settings.all({ prefix: 'observation.connector.' })) {
    const connector = object(row.value);
    for (const raw of Object.values(object(connector.sessions))) {
      const session = object(raw), association = object(session.learning_association);
      if (typeof session.id !== 'string' || !runtime(session.harness)) continue;
      const harness = runtime(session.harness)!;
      // This hash was verified at ingestion. It remains historical provenance if learning is later revoked.
      const attested = typeof association.native_session_hash === 'string' && /^[a-f0-9]{64}$/.test(association.native_session_hash)
        && typeof association.connection_id === 'string' && typeof association.generation === 'string';
      const key = attested ? `${harness}:${association.native_session_hash}` : `observation:${connector.id}:${session.id}`;
      let agent: string | undefined;
      if (attested) {
        if (!connections.has(association.connection_id)) connections.set(association.connection_id,
          object(await store.settings.get(`cli-learning-connection:${association.connection_id}`)).agent_id);
        agent = connections.get(association.connection_id);
      }
      if (filter.agent && filter.agent !== session.id && filter.agent !== agent && !selectedNative.has(key)) continue;
      sourceSelected = true;
      const received = Date.parse(session.received_at), facts: Fact[] = [], partial = new Set<string>();
      let overlaps = false;
      for (const [day, models] of Object.entries(object(session.usage_by_day))) {
        if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue;
        const start = Date.parse(day), end = start + DAY;
        if (end < now - RETENTION) continue;
        const values = Object.values(object(models)).map(value => sourceCounts(object(value)));
        if (end <= from || start >= to) continue;
        overlaps = true;
        if (start < from || end > to) { partial.add(day); continue; }
        for (const value of values) {
          facts.push({ ...value, day, harness });
        }
      }
      if (!overlaps && !(received >= from && received < to) && filter.agent !== session.id) continue;
      observed.push({ id: session.id, key, received, harness, facts, partial });
    }
  }
  // Copies of a verified session may cover disjoint days. Choose the most reported copy for each UTC day,
  // then the freshest receipt and stable id. Same-day requestless aggregates cannot be safely added together.
  const copies = new Map<string, Observed[]>();
  for (const session of observed) {
    const group = copies.get(session.key) ?? []; group.push(session); copies.set(session.key, group);
  }
  const authorities = new Map<string, Observed>();
  const uncertainSources = new Set<string>();
  for (const [key, group] of copies) {
    const days = new Map<string, { session: Observed; facts: Fact[]; score: number }>();
    const partial = new Set<string>();
    for (const session of group) {
      for (const day of session.partial) partial.add(day);
      const own = new Map<string, Fact[]>();
      for (const fact of session.facts) { const items = own.get(fact.day) ?? []; items.push(fact); own.set(fact.day, items); }
      for (const [day, facts] of own) {
        const score = facts.reduce((sum, fact) => sum + (fact.tokens ?? 0), 0), old = days.get(day);
        if (old) uncertainSources.add(key);
        if (!old || score > old.score || (score === old.score && (session.received > old.session.received
          || (session.received === old.session.received && session.id < old.session.id)))) days.set(day, { session, facts, score });
      }
    }
    authorities.set(key, { ...group[0]!, facts: [...days.values()].flatMap(day => day.facts), partial });
  }
  const facts: Fact[] = [], partial = new Set<string>();
  const knownRuns = new Set<string>(), unknownRuns = new Set<string>();
  const nativeFacts = new Map<string, Fact[]>(), importedAlternatives = new Map<string, Fact[]>();
  const otherNative = new Set([
    ...runs.filter(run => !run.imported && run.key && run.fact.tokens !== null).map(run => runtime(run.fact.harness)!),
    ...[...authorities.values()].filter(source => source.facts.some(fact => fact.tokens !== null)).map(source => source.harness),
  ]);
  const groups = new Map<string, Recorded[]>();
  for (const run of runs) {
    const harness = runtime(run.fact.harness);
    if (run.imported && run.key && harness && otherNative.has(harness) && run.fact.tokens !== null) {
      // Old local imports retain exact child counters, but not child identities. Verify the complete
      // journal before separating the root; a missing journal or namespaced/redacted root proves no split.
      let root: Counts | undefined;
      if (!run.opaqueImport) try {
        const entries = await journalEntries(store.readJournal(run.id), BACKGROUND_CONTEXT) as unknown as EntryLike[];
        const complete = runCounts(runMetricsOf(entries));
        const own = runCounts(runMetricsOf(entries.filter(entry => entry.kind !== REQUEST_COST || object(entry.data).request !== 'subagent')));
        if (complete.tokens !== null && own.tokens !== null && fields.every(field => complete[field] === run.fact[field] && own[field]! <= complete[field]!)) root = own;
      } catch { /* Retain the saved aggregate as an alternative, never guess missing provenance. */ }
      if (!root || root.tokens !== run.fact.tokens) {
        const alternatives = importedAlternatives.get(harness) ?? []; alternatives.push(run.fact); importedAlternatives.set(harness, alternatives);
        unknownRuns.add(run.id);
      }
      if (!root) continue;
      run.fact = { ...run.fact, ...root };
    }
    if (run.key) {
      const group = groups.get(run.key) ?? []; group.push(run); groups.set(run.key, group);
    } else {
      facts.push(run.fact);
      if (run.fact.tokens === null) unknownRuns.add(run.id);
    }
  }
  let observed_sessions = 0;
  for (const [key, session] of authorities) {
    if (!groups.has(key)) groups.set(key, []);
    for (const day of session.partial) partial.add(day);
    if (session.facts.some(fact => fact.tokens !== null)) observed_sessions++; else uncertainSources.add(key);
  }
  for (const [key, group] of groups) {
    const session = authorities.get(key), sourceFacts = session?.facts ?? [];
    type Unit = { fact: Fact; runs: string[] };
    const windows = new Map<string, Unit>(), alternatives: Fact[] = [];
    for (const run of group) {
      if (run.fact.tokens === null) { facts.push(run.fact); unknownRuns.add(run.id); continue; }
      let fact = run.fact, window: string | undefined;
      if (run.sdk) {
        const usage = (await sdkInbox(store, run.id).catch(() => undefined))?.completion?.usage;
        const task = runCounts({ input: usage?.input_tokens, output: usage?.output_tokens,
          cacheRead: usage?.cache_read_tokens, cacheWrite: usage?.cache_write_tokens });
        if (task.tokens !== null && fields.every(field => fact[field]! >= task[field]!)) {
          // The immutable task receipt separates reflection, which ran in a different native session.
          // It stays additive regardless of which overlapping view supplies the task's lower bound.
          const remainder = Object.fromEntries(fields.map(field => [field, fact[field]! - task[field]!])) as Omit<Counts, 'tokens'>;
          const tokens = plus(fields.map(field => remainder[field]!));
          if (tokens !== null && tokens > 0) facts.push({ ...fact, ...remainder, tokens });
          fact = { ...fact, ...task }; window = run.window;
        }
      }
      if (!window) { alternatives.push(fact); continue; }
      // Only a pinned CLI turn plus its immutable receipt identifies disjoint native prompt usage.
      // SDK/import row timestamps are bookkeeping, not proof of native request boundaries.
      const old = windows.get(window);
      if (!old) windows.set(window, { fact, runs: [run.id] });
      else {
        old.runs.push(run.id);
        if (fact.tokens! > old.fact.tokens! || (fact.tokens === old.fact.tokens && run.id < old.fact.runId!)) old.fact = fact;
        for (const id of old.runs) unknownRuns.add(id);
      }
    }
    facts.push(...sourceFacts.filter(fact => fact.tokens === null));
    const observed = sourceFacts.filter(fact => fact.tokens !== null), captured = [...windows.values()].map(window => window.fact);
    const score = (items: Fact[]) => plus(items.map(fact => fact.tokens!));
    if (observed.length && captured.length) for (const window of windows.values()) for (const id of window.runs) unknownRuns.add(id);
    // Offline hooks can register a prompt after native execution. Server start/end timestamps cannot
    // establish disjointness from observer UTC days. Distinct pinned turns may sum, as may distinct
    // observer days, but those complete views remain alternatives without native request-level coverage.
    // Preserve the selected view's entire breakdown; per-field maxima can invent a nonexistent total.
    let selected = !observed.length || (captured.length && (score(captured) ?? Infinity) > (score(observed) ?? Infinity)) ? captured : observed;
    if (alternatives.length && (selected.length || alternatives.length > 1)) for (const run of group) unknownRuns.add(run.id);
    alternatives.sort((a, b) => a.runId!.localeCompare(b.runId!));
    for (const fact of alternatives) if (!selected.length || fact.tokens! > (score(selected) ?? Infinity)) selected = [fact];
    const harness = session?.harness ?? runtime(group[0]!.fact.harness)!;
    const cohort = nativeFacts.get(harness) ?? []; cohort.push(...selected); nativeFacts.set(harness, cohort);
  }
  for (const [harness, alternatives] of importedAlternatives) {
    // An unidentified imported child could be any other session of this runtime. Its full aggregate is
    // an alternative to that runtime's coherent root/native view, never an additive descendant remainder.
    // Distinct managed work and separately booked reflection stay outside this comparison.
    let selected = nativeFacts.get(harness) ?? [];
    alternatives.sort((a, b) => a.runId!.localeCompare(b.runId!));
    for (const fact of alternatives) if (!selected.length || fact.tokens! > (plus(selected.map(item => item.tokens!)) ?? Infinity)) selected = [fact];
    nativeFacts.set(harness, selected);
    for (const run of runs) if (run.key && runtime(run.fact.harness) === harness) unknownRuns.add(run.id);
  }
  facts.push(...[...nativeFacts.values()].flat());
  for (const fact of facts) if (fact.runId && fact.tokens !== null) knownRuns.add(fact.runId);
  const known = facts.filter(fact => fact.tokens !== null);
  const unknown_sessions = uncertainSources.size;
  const any = facts.length > 0 || unknown_sessions > 0 || unknownRuns.size > 0;
  const totals: Counts = { tokens: known.length ? plus(known.map(fact => fact.tokens!)) : any ? null : 0,
    ...Object.fromEntries(fields.map(key => [key, known.some(fact => fact[key] === null) ? null
      : known.length ? plus(known.map(fact => fact[key]!)) : any ? null : 0])) } as Counts;
  const grouped = (key: 'day' | 'harness') => {
    const groups = new Map<string, Fact[]>();
    for (const fact of facts) { const group = groups.get(fact[key]) ?? []; group.push(fact); groups.set(fact[key], group); }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => {
      const known = group.filter(fact => fact.tokens !== null);
      return { name, tokens: known.length ? plus(known.map(fact => fact.tokens!)) : null };
    });
  };
  return { ...totals, known_runs: knownRuns.size, unknown_runs: unknownRuns.size, observed_sessions, unknown_sessions, partial_days: partial.size,
    retention_limited: sourceSelected && from < now - RETENTION,
    by_day: grouped('day').map(({ name, tokens }) => ({ day: name, tokens })),
    by_harness: grouped('harness').map(({ name, tokens }) => ({ harness: name, tokens })) };
}
