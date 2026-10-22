#!/usr/bin/env node
// Whether a run looked up the SEC's own code (the learning redesign's runs-to-discovery), read structurally from the run's
// recording with the tools' own predicate (tools.mjs archivedSecPage), never from prose.
//   node examples/learn-classify/eval-lookup.mjs <rows.jsonl> [--history <workflow-history.json>]
// A run TOUCHED the lookup when a fetch_page, browse or read_document result that came back ok was for a Wayback copy of an
// SEC page; it USED it when the answer's 4-digit code is a whole token in such a result's text, and its SIC cite names such
// a page (citeUse). A touch is BY A WORKFLOW when a workflow node made the call: a call node (an effect) or an agent node
// (a conversation agentrun.nodes names), not the root agent. Each archived page's kind says which route the agent found:
// index, headers, company (browse-edgar), submissions (data.sec.gov), other. With --history, each saved revision is also
// read statically: a call node to one of those tools whose url template (placeholders as "x") is such a page.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { sameUrl } from './score-v2.mjs';
import { archivedSecPage } from './tools.mjs';

const READERS = new Set(['fetch_page', 'browse', 'read_document']);

const archived = (href) => {
  try { return archivedSecPage(new URL(href)); } catch { return false; }
};

/** The kind of SEC page a Wayback URL holds: index, headers, company, submissions or other. */
export function pageKind(href) {
  const original = new URL(href).pathname.replace(/^\/web\/[^/]+\//, '');
  let inner;
  try { inner = new URL(/^https?:\/\//i.test(original) ? original : `https://${original}`); } catch { return 'other'; }
  if (/-index-headers\.html?$/i.test(inner.pathname)) return 'headers';
  if (/-index\.html?$/i.test(inner.pathname)) return 'index';
  if (/\/cgi-bin\/browse-edgar/i.test(inner.pathname)) return 'company';
  if (inner.hostname.toLowerCase() === 'data.sec.gov' && inner.pathname.startsWith('/submissions')) return 'submissions';
  return 'other';
}

const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const textOf = (content) => (Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : String(content ?? ''));
/** A result's words without its URLs, so a code in an address is not a code read. */
const wordsOf = (value) => JSON.stringify(value, (key, v) => (/url|href|source|snapshot/i.test(key) ? undefined : v)) ?? '';
/** A result's page text as it reads (its `text`, line breaks and all), then its other words: a token at the start of a
 *  line is a whole token here, where the escaped JSON of `wordsOf` would join it to an "n". */
const pageWords = (value) => `${typeof value?.text === 'string' ? value.text : ''}\n${wordsOf(value)}`;

/** The SEC's own record pages, which state a registrant's assigned SIC: the filing index and header, the company page and
 *  the submissions record. A filing's documents ("other") are the filer's text, not the record. */
export const RECORD_KINDS = Object.freeze(['index', 'headers', 'company', 'submissions']);

/** Every result of a reader tool that did not error, from the root agent, the workflows' agent nodes and their effects, each
 *  `{ tool, args, value, byWorkflow }`, and the run's last answer call's arguments. */
function readerResults(lines) {
  const calls = new Map();
  const nodeConvs = new Set();
  let answer;
  for (const line of lines) {
    if (line.kind === 'agentrun.nodes' && Number.isInteger(line.data?.value?.conversation)) nodeConvs.add(line.data.value.conversation);
    if (line.kind !== 'pi.assistant') continue;
    for (const part of line.data?.model?.[0]?.content ?? []) {
      if (part.type !== 'toolCall') continue;
      calls.set(`${line.conv}:${part.id}`, part.arguments ?? {});
      if (part.name === 'answer') answer = part.arguments;
    }
  }
  const results = [];
  const effects = new Map();
  for (const line of lines) {
    const entry = line.data?.model?.[0];
    if (line.kind === 'pi.tool-result' && READERS.has(entry?.toolName) && !entry.isError) {
      results.push({ tool: entry.toolName, args: calls.get(`${line.conv}:${entry.toolCallId}`) ?? {}, value: parse(textOf(entry.content)), byWorkflow: nodeConvs.has(line.conv) });
    }
    const effect = line.data?.value;
    if (line.kind === 'agentrun.effects' && READERS.has(effect?.intent?.tool)) effects.set(line.data.key, effect);
  }
  for (const effect of effects.values()) {
    if (effect.status === 'completed') results.push({ tool: effect.intent.tool, args: effect.args ?? {}, value: effect.result?.value, byWorkflow: true });
  }
  return { results, answer };
}

/**
 * The run's SIC receipt, or null: an ok reader result for an archived SEC record page (`archivedSecPage`, `pageKind` in
 * RECORD_KINDS) whose words, URLs left out, hold the answered 4-digit code as a whole token, and the answer's SIC cite
 * names that same page. `answer` is the run's answer (the host's run of a workflow answers without an answer call). The
 * receipt keeps the page's address, kind and the code, never its text.
 */
export function receiptOf(lines, answer) {
  const sic4 = answer?.sic4;
  const cite = (answer?.cites ?? []).find((c) => c?.claim === 'sic');
  if (typeof sic4 !== 'string' || !/^\d{4}$/.test(sic4) || typeof cite?.url !== 'string') return null;
  const code = new RegExp(`\\b${sic4}\\b`);
  for (const { args, value, byWorkflow } of readerResults(lines).results) {
    if (!value || value.ok === false || value.refused) continue;
    const urls = [value.url, args.url].filter((u) => typeof u === 'string' && archived(u));
    const url = urls.find((u) => RECORD_KINDS.includes(pageKind(u)));
    if (!url || !code.test(pageWords(value)) || !urls.some((u) => sameUrl(u) === sameUrl(cite.url))) continue;
    return { url, kind: pageKind(url), sic4, byWorkflow };
  }
  return null;
}

/**
 * The SIC code an SEC record page states, read from the SEC's own field on it, or null: the filing index's and the
 * company page's "SIC: 1234", the filing header's "STANDARD INDUSTRIAL CLASSIFICATION: ... [1234]", the submissions
 * record's "sic": "1234". These are fields of pages the SEC generates, not prose.
 */
export function recordSicOf(value) {
  const words = pageWords(value);
  const field = /STANDARD INDUSTRIAL CLASSIFICATION:[^[\]]{0,120}\[(\d{4})\]/i.exec(words) ?? /\\?"sic\\?"\s*:\s*\\?"(\d{4})\\?"/.exec(words) ?? /\bSIC\s*:?\s*(\d{4})\b/.exec(words);
  return field ? field[1] : null;
}

/**
 * The run's receipt contradiction, or null: a workflow's node read an archived SEC record page whose SIC field states a
 * code, and the answer is another code. The run had the SEC's code in hand and answered something else.
 */
export function contradictionOf(lines, answer) {
  const sic4 = answer?.sic4;
  if (typeof sic4 !== 'string' || !/^\d{4}$/.test(sic4)) return null;
  for (const { args, value, byWorkflow } of readerResults(lines).results) {
    if (!byWorkflow || !value || value.ok === false || value.refused) continue;
    const url = [value.url, args.url].find((u) => typeof u === 'string' && archived(u) && RECORD_KINDS.includes(pageKind(u)));
    const shown = url ? recordSicOf(value) : null;
    if (shown && shown !== sic4) return { url, kind: pageKind(url), shown, answered: sic4 };
  }
  return null;
}

/** A run's lookup facts from its recording lines and its answer's code. */
export function lookupOfLines(lines, { sic4 } = {}) {
  const { results, answer } = readerResults(lines);
  const touched = results.filter(({ args, value }) => value && value.ok !== false && [value.url, args.url].some((u) => typeof u === 'string' && archived(u)));
  const code = typeof sic4 === 'string' && /^\d{4}$/.test(sic4) ? new RegExp(`\\b${sic4}\\b`) : null;
  const used = code ? touched.some(({ value }) => code.test(wordsOf(value))) : false;
  const cite = (answer?.cites ?? []).find((c) => c?.claim === 'sic');
  return {
    touched: touched.length > 0, used,
    citeUse: cite ? archived(cite.url) : null,
    byWorkflow: touched.some((t) => t.byWorkflow), byRoot: touched.some((t) => !t.byWorkflow),
    kinds: [...new Set(touched.map(({ value, args }) => pageKind([value.url, args.url].find((u) => typeof u === 'string' && archived(u)))))].sort(),
    archivedUrls: [...new Set(touched.map(({ value, args }) => [args.url, value.url].find((u) => typeof u === 'string' && archived(u))))].sort(),
  };
}

/** Whether a saved workflow, read statically, has a call node to a reader whose url template is a Wayback copy of an SEC page. */
export function revisionCarriesLookup(workflow) {
  let found = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.node === 'call' && READERS.has(node.tool) && typeof node.args?.url === 'string' && archived(node.args.url.replace(/\{[^}]*\}/g, 'x'))) found = true;
    for (const value of Object.values(node)) visit(value);
  };
  visit(workflow);
  return found;
}

/** Where a row's run store is: <out>/home/runs/<runId> for runs.jsonl, <out>/sealed/<sha12>/home/runs/<runId> for sealed rows. */
export function storeOf(rowsFile, row) {
  const out = dirname(resolve(rowsFile));
  const name = basename(rowsFile);
  const sealed = name.startsWith('sealed-') ? name.slice('sealed-'.length, -'.jsonl'.length) : null;
  const runs = sealed ? join(out, 'sealed', sealed, 'home', 'runs') : join(out, 'home', 'runs');
  const stem = row.recording ?? (sealed ? `sealed-${row.cik}` : `run-${String(row.run).padStart(3, '0')}`);
  const attempts = existsSync(runs) ? readdirSync(runs).filter((d) => d === stem || d.startsWith(`${stem}-a`)).sort((a, b) => (a.length - b.length) || a.localeCompare(b)) : [];
  const dir = attempts.length ? join(runs, attempts[attempts.length - 1]) : null;
  const store = dir && existsSync(join(dir, 'store')) ? readdirSync(join(dir, 'store')).find((f) => f.endsWith('.sqlite')) : null;
  return store ? join(dir, 'store', store) : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { history: { type: 'string' } } });
  const file = positionals[0];
  if (!file) { console.error('usage: eval-lookup.mjs <rows.jsonl> [--history <workflow-history.json>]'); process.exit(2); }
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const runs = rows.map((row) => {
    const store = storeOf(file, row);
    return { run: row.run, cik: row.cik, ...(store ? lookupOfLines(recordingLines(store).lines, { sic4: row.sic4Answer }) : { noStore: true }) };
  });
  const out = { rows: file, runs };
  if (values.history) {
    const history = JSON.parse(readFileSync(values.history, 'utf8'));
    out.revisions = history.revisions.map((r) => ({ digest: r.digest, short: r.short, savedAtRun: r.savedAtRun, promotedAtRun: r.promotedAtRun, servedRuns: r.servedRuns, staticLookup: revisionCarriesLookup(r.workflow) }));
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
