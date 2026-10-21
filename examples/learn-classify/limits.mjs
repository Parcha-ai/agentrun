// The rate limits a run met, by the hour they happened in, read from its closed store: every model call that ended in an
// error (each retry is one), by the HTTP status the provider's error message leads with, and the 429s that fetch_page,
// browse and read_document were answered with, plus each pushback a tool got past on its own (its result's `retried`:
// the snapshot cache's back-off, read_document's browser rescue), web.archive.org apart from the other sites. The frozen
// passes ramp on these.
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { existsSync } from 'node:fs';

const SITE_TOOLS = new Set(['fetch_page', 'browse', 'read_document']);
const WAYBACK = 'web.archive.org';
const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join(''));
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const hostOf = (url) => { try { return new URL(String(url)).hostname; } catch { return ''; } };
/** The status a provider SDK's error message starts with ("429 {...}"); a connection or stream failure has none. */
const statusOf = (message) => {
  const lead = /^(\d{3})\b/.exec(String(message ?? ''));
  return lead ? Number(lead[1]) : 'other';
};

const keyOf = (hour, source, status) => JSON.stringify([hour, source, status]);
const listOf = (counts) => [...counts].map(([key, n]) => {
  const [hour, source, status] = JSON.parse(key);
  return { hour, source, status, n };
}).sort((a, b) => a.hour.localeCompare(b.hour) || a.source.localeCompare(b.source) || String(a.status).localeCompare(String(b.status)));

/** `{ hour: 'YYYY-MM-DDTHH', source: 'model' | 'site' | 'wayback', status, n }` per hour, source and status, in that order.
 *  A line with no time of its own (a workflow's tool call) takes the last time before it, else `at`. */
export function limitsOfLines(lines, { at } = {}) {
  const counts = new Map();
  const add = (ms, source, status) => {
    if (!Number.isFinite(ms)) return;
    const key = keyOf(new Date(ms).toISOString().slice(0, 13), source, status);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const site = (ms, value, args) => {
    const source = hostOf(value?.url ?? args?.url) === WAYBACK ? 'wayback' : 'site';
    if (value?.status === 429) add(ms, source, 429);
    for (const retry of Array.isArray(value?.retried) ? value.retried : []) if (Number.isInteger(retry?.status)) add(ms, source, retry.status);
  };
  let last = at;
  const calls = new Map();
  // A workflow's tool call has a line per revision: it counts once, as its last revision left it.
  const effects = new Map();
  for (const line of lines) {
    const entry = line.data?.model?.[0];
    if (Number.isFinite(entry?.timestamp)) last = entry.timestamp;
    if (line.kind === 'pi.assistant') {
      for (const part of entry?.content ?? []) if (part.type === 'toolCall') calls.set(`${line.conv}:${part.id}`, part.arguments);
      if (entry?.stopReason === 'error') add(entry.timestamp ?? last, 'model', statusOf(entry.errorMessage));
    } else if (line.kind === 'pi.tool-result' && SITE_TOOLS.has(entry?.toolName) && !entry.isError) {
      site(entry.timestamp ?? last, json(textOf(entry.content)), calls.get(`${line.conv}:${entry.toolCallId}`));
    } else if (line.kind === 'agentrun.effects' && SITE_TOOLS.has(line.data?.value?.intent?.tool)) {
      effects.set(line.data.key, { at: last, effect: line.data.value });
    }
  }
  for (const { at: ms, effect } of effects.values()) if (effect.status === 'completed') site(ms, effect.result?.value, effect.args);
  return listOf(counts);
}

/** The limits of a job's runs (its attempts' stores, those that exist), summed. */
export function limitsOf(storePaths, { at } = {}) {
  const counts = new Map();
  for (const path of storePaths) {
    if (!existsSync(path)) continue;
    for (const { hour, source, status, n } of limitsOfLines(recordingLines(path).lines, { at })) {
      const key = keyOf(hour, source, status);
      counts.set(key, (counts.get(key) ?? 0) + n);
    }
  }
  return listOf(counts);
}
