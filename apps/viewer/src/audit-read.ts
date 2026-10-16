// What the workflow map reads from a fan-out recording's lines (RECORDING.md 3.1). Every read of a line's `data` for
// this demo is here, and each is tolerant: a shape it does not know is skipped, never misread.
import type { Json, Line } from './format.ts';
import { docOf, entryOf, toolCallsOf, type DocLine } from './durable.ts';

type Obj = { [key: string]: Json };
const auditIsObj = (value: Json | undefined): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const auditStrings = (value: Json | undefined) => (Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : undefined);

/** The branch a path belongs to: the path up to and including the first `/items/<n>` (a map's item), else undefined. */
export function branchOf(path: string | undefined): { id: string; index: number } | undefined {
  const match = path === undefined ? null : /^(.*?\/items\/(\d+))(?:\/|$)/.exec(path);
  return match ? { id: match[1]!, index: Number(match[2]) } : undefined;
}

/** The shape of the fan-out, read from the workflow document the run's task line carries: where the map is, what it maps
 *  over, and the labels of the steps of its body in order. */
export type Plan = { mapPath: string; items: string[]; steps: string[] };
export function planOf(line: Line): Plan | undefined {
  if (line.channel !== 'durable' || line.source !== 'workflow' || line.kind !== 'agentrun.workflow' || !auditIsObj(line.data)) return undefined;
  const input = auditIsObj(line.data.input) ? line.data.input : undefined;
  return input ? planOfWorkflow(input.workflow, input.input) : undefined;
}
/** The same, from a workflow document and the input it ran on (the job blob's `workflow` and `input`). */
export function planOfWorkflow(workflow: Json | undefined, input: Json | undefined): Plan | undefined {
  const root = auditIsObj(workflow) && auditIsObj(workflow.root) ? workflow.root : undefined;
  if (!root) return undefined;
  const found = findMap(root, '/root', 0);
  if (!found) return undefined;
  const given = auditIsObj(input) ? input : {};
  const list = typeof found.node.itemsPath === 'string' ? auditPath(given, found.node.itemsPath) : undefined;
  const items = Array.isArray(list) ? list.map((each) => (auditIsObj(each) && typeof each.name === 'string' ? (typeof each.version === 'string' ? `${each.name}@${each.version}` : each.name) : String(each))) : [];
  const body = auditIsObj(found.node.body) ? found.node.body : undefined;
  const steps = body && Array.isArray(body.steps) ? body.steps.map((step, index) => (auditIsObj(step) && typeof step.label === 'string' ? step.label : `step ${index}`)) : [];
  return { mapPath: found.path, items, steps };
}
/** A dotted state path (`plan.questions`, `groups.0.items`) through nested objects and arrays, as the DSL reads an `itemsPath`. */
function auditPath(root: Json | undefined, path: string): Json | undefined {
  let at: Json | undefined = root;
  for (const key of path.split('.')) {
    if (Array.isArray(at) && /^\d+$/.test(key)) at = at[Number(key)];
    else if (auditIsObj(at)) at = at[key];
    else return undefined;
  }
  return at;
}

function findMap(node: Obj, path: string, depth: number): { node: Obj; path: string } | undefined {
  if (depth > 6) return undefined;
  if (node.node === 'map') return { node, path };
  if (node.node === 'chain' && Array.isArray(node.steps)) {
    for (let index = 0; index < node.steps.length; index += 1) {
      const step = node.steps[index];
      const found = auditIsObj(step) ? findMap(step, `${path}/steps/${index}`, depth + 1) : undefined;
      if (found) return found;
    }
  }
  return undefined;
}

/** Whether the run's task line says the run finished: a terminal task whose outcome completed. */
export function finishedOf(line: Line): boolean {
  if (line.channel !== 'durable' || line.kind !== 'agentrun.workflow' || !auditIsObj(line.data)) return false;
  const state = auditIsObj(line.data.state) ? line.data.state : undefined;
  const outcome = state && auditIsObj(state.outcome) ? state.outcome : undefined;
  return state?.status === 'terminal' && outcome?.status === 'completed';
}

/** The audit call an effect is: the tool it names. The three calls of a branch are `registry`, `advisories`, `install`. */
export type CallKind = 'registry' | 'advisories' | 'install';
export function callKindOf(name: string, tool: string | undefined): CallKind | undefined {
  const text = `${tool ?? ''} ${name}`.toLowerCase();
  if (text.includes('registry')) return 'registry';
  if (text.includes('advisor') || text.includes('osv')) return 'advisories';
  if (text.includes('install') || text.includes('box')) return 'install';
  return undefined;
}

/** What a completed effect's receipt tells the map. */
export type CallFacts = {
  name?: string; deprecated?: string; repository?: string; advisories?: string[]; summaries?: Record<string, string>;
  hosts?: string[]; outside?: string[]; ran?: boolean; note?: string; scripts?: string[]; receipt?: string;
  /** The connections the box's strace saw, with when, and the end of the install's log. */
  outbound?: { host?: string; ip: string; port?: number; at?: number }[]; logTail?: string;
};
export function callFactsOf(value: Json | undefined): CallFacts {
  const out: CallFacts = {};
  const root = auditIsObj(value) ? value : {};
  const body = auditIsObj(root.value) ? root.value : root;
  if (typeof body.name === 'string') out.name = typeof body.version === 'string' ? `${body.name}@${body.version}` : body.name;
  if (typeof body.deprecated === 'string' && body.deprecated !== '') out.deprecated = body.deprecated;
  else if (body.deprecated === true) out.deprecated = 'deprecated';
  if (typeof body.repository === 'string') out.repository = body.repository;
  const ids = auditStrings(body.advisories) ?? auditStrings(body.ids);
  if (ids) out.advisories = ids;
  if (auditIsObj(body.summaries)) out.summaries = Object.fromEntries(Object.entries(body.summaries).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const outside = auditStrings(body.outside) ?? auditStrings(body.outside_hosts);
  if (outside) out.outside = outside;
  const hosts = auditStrings(body.hosts);
  if (hosts) out.hosts = hosts;
  if (typeof body.ran === 'boolean') out.ran = body.ran;
  if (typeof body.note === 'string') out.note = body.note;
  const scripts = auditStrings(body.scripts) ?? (auditIsObj(body.scripts) ? Object.keys(body.scripts) : undefined);
  if (scripts) out.scripts = scripts;
  if (typeof body.receipt === 'string') out.receipt = body.receipt;
  if (Array.isArray(body.outbound)) {
    out.outbound = body.outbound.flatMap((each) => (auditIsObj(each) && typeof each.ip === 'string'
      ? [{ ip: each.ip, ...(typeof each.host === 'string' ? { host: each.host } : {}), ...(typeof each.port === 'number' ? { port: each.port } : {}), ...(typeof each.at === 'number' ? { at: each.at } : {}) }] : []));
  }
  if (typeof body.log_tail === 'string') out.logTail = body.log_tail;
  return out;
}

/** A judge's answer: the choice among `clear`, `notice`, `act` and its confidence. */
export type Verdict = { answer: string; confidence: number | null };
export function verdictsOf(doc: DocLine): { row: string; verdict: Verdict; path?: string }[] {
  if (doc.doc !== 'agentrun.decisions' || !auditIsObj(doc.value) || !Array.isArray(doc.value.receipts)) return [];
  const out: { row: string; verdict: Verdict; path?: string }[] = [];
  for (const row of doc.value.receipts) {
    if (!auditIsObj(row) || row.error !== undefined) continue;
    const choice = auditFirstChoice(row.answers ?? row);
    if (!choice) continue;
    const path = [row.execution_path, row.executionPath, row.path].find((each): each is string => typeof each === 'string' && each.startsWith('/'));
    out.push({ row: `${typeof row.run_key === 'string' ? row.run_key : ''} ${typeof row.decision_id === 'string' ? row.decision_id : out.length}`, verdict: { answer: choice.choice, confidence: choice.confidence }, ...(path ? { path } : {}) });
  }
  return out;
}
function auditFirstChoice(value: Json | undefined, depth = 0): { choice: string; confidence: number | null } | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) { for (const item of value) { const found = auditFirstChoice(item, depth + 1); if (found) return found; } return undefined; }
  if (!auditIsObj(value)) return undefined;
  if (typeof value.choice === 'string') return { choice: value.choice, confidence: typeof value.confidence === 'number' ? value.confidence : null };
  for (const child of Object.values(value)) { const found = auditFirstChoice(child, depth + 1); if (found) return found; }
  return undefined;
}

/** A cited fact the extract node submitted: `{ claim, source, receipt }`. */
export type Fact = { claim: string; source?: string; receipt?: string };
export function factsOf(line: Line): Fact[] {
  const entry = entryOf(line);
  if (!entry) return [];
  const facts: Fact[] = [];
  for (const message of entry.model) {
    if (message.role !== 'assistant') continue;
    for (const call of toolCallsOf(message)) {
      if (call.name !== 'submit' || !auditIsObj(call.arguments)) continue;
      const list = auditIsObj(call.arguments.record) ? call.arguments.record.facts : call.arguments.facts;
      if (!Array.isArray(list)) continue;
      for (const fact of list) {
        if (!auditIsObj(fact) || typeof fact.claim !== 'string') continue;
        facts.push({ claim: fact.claim, ...(typeof fact.source === 'string' ? { source: fact.source } : {}), ...(typeof fact.receipt === 'string' ? { receipt: fact.receipt } : {}) });
      }
    }
  }
  return facts;
}

/** The conversation an LLM node runs in (`agentrun.nodes`, filed at the node's path), so a conversation's lines find their branch. */
export function conversationOf(doc: DocLine): number | undefined {
  return doc.doc === 'agentrun.nodes' && auditIsObj(doc.value) && typeof doc.value.conversation === 'number' ? doc.value.conversation : undefined;
}

/** The cited facts a delivered record holds (`agentrun.record` of the finding node). */
export function recordFactsOf(doc: DocLine): Fact[] {
  if (doc.doc !== 'agentrun.record' || !auditIsObj(doc.value) || !auditIsObj(doc.value.record) || !Array.isArray(doc.value.record.facts)) return [];
  return doc.value.record.facts.flatMap((fact) => (auditIsObj(fact) && typeof fact.claim === 'string'
    ? [{ claim: fact.claim, ...(typeof fact.source === 'string' ? { source: fact.source } : {}), ...(typeof fact.receipt === 'string' ? { receipt: fact.receipt } : {}) }] : []));
}

/** What the repository agent delivered (`agentrun.record`): the pages it read, whether the repository is archived, and the
 *  badges it found. */
export type Repository = { pages: { path: string; url: string }[]; archived?: string; badges: string[] };
export function repositoryOf(doc: DocLine): Repository | undefined {
  if (doc.doc !== 'agentrun.record' || !auditIsObj(doc.value) || !auditIsObj(doc.value.record)) return undefined;
  const record = doc.value.record;
  if (!Array.isArray(record.pages) && record.archived === undefined) return undefined;
  const pages = (Array.isArray(record.pages) ? record.pages : []).flatMap((page) => (auditIsObj(page) && typeof page.path === 'string' && page.path !== '' ? [{ path: page.path, url: typeof page.url === 'string' ? page.url : '' }] : []));
  const badges = (Array.isArray(record.badges) ? record.badges : []).map((badge) => (typeof badge === 'string' ? badge : auditIsObj(badge) ? [badge.value, badge.text, badge.read, badge.label].find((each) => typeof each === 'string') ?? JSON.stringify(badge) : String(badge))) as string[];
  return { pages, ...(typeof record.archived === 'string' ? { archived: record.archived } : {}), badges };
}

/** What vision read of an image: each look a `vision.looks` document holds (one document per conversation), with its receipt, the
 *  eyes' words (`record.body`) and the image it looked at (the SHA-256 of the file it read, which is the blob's name). */
export type Look = { receipt: string; text: string; blob?: string; ask?: string };
export function looksOf(line: Line): Look[] {
  if (line.source !== 'vision' || line.channel !== 'durable') return [];
  const doc = docOf(line);
  const list = doc && doc.doc === 'vision.looks' && auditIsObj(doc.value) && Array.isArray(doc.value.looks) ? doc.value.looks : [];
  return list.flatMap((look) => {
    if (!auditIsObj(look) || typeof look.receipt !== 'string') return [];
    const record = auditIsObj(look.record) ? look.record : {};
    const facts = auditIsObj(record.facts) ? record.facts : {};
    const args = auditIsObj(record.args) ? record.args : {};
    const body = typeof record.body === 'string' ? record.body : typeof look.body === 'string' ? look.body : '';
    return [{ receipt: look.receipt, text: body,
      ...(typeof facts.sha256 === 'string' ? { blob: facts.sha256 } : {}), ...(typeof args.ask === 'string' ? { ask: args.ask } : {}) }];
  });
}

/** An evidence record a browser page or a look kept (a live line): the evidence file's path and the blob holding it. */
export function evidenceOf(line: Line): { path: string; blob: string } | undefined {
  if ((line.source !== 'browser' && line.source !== 'vision') || line.kind !== 'EvidenceRecord' || !auditIsObj(line.data)) return undefined;
  const path = typeof line.data.path === 'string' ? line.data.path : undefined;
  const blob = line.blobs?.[0];
  return path && blob ? { path, blob } : undefined;
}
