// Hindsight lessons (research design B, §2.3): a run that answered a field confidently and wrong never escalates, so a
// loop that learns only from escalations never learns from it. On a TRAIN run scored wrong on a field, one reflection
// per wrong field (an agent call on the host's model, with fetch_page and read_document) gets the run's trajectory, its
// answer, the TRUE value and the lessons the run had, and writes at most two hypotheses: why it missed, where the true
// value could have been read, for which companies, by what mechanism, and a test the host can replay. Each is proposed
// like a run's own lesson, on its own run branch, and curate admits, holds or refuses it; the guard refuses one that names
// the company or the true value. Only a learning pass over a TRAIN split asks for one: the oracle is TRAIN's alone.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { CAPS, inboxPath, LAYOUT, proposeFiles, renderInbox } from '@parcha/pi-agent-learn';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseValuesOf, classifyTools, groupsOf, toolResultsOf, usageTotals } from './host.mjs';
import { pageKind } from './eval-lookup.mjs';
import { archivedSecPage } from './tools.mjs';

/** The splits a learning pass may reflect on with the truth: TRAIN (the 1k set's train and train-legacy) and the older
 *  sets' run split. Never DEV or TEST. */
export const HINDSIGHT_SPLITS = Object.freeze(['train', 'train-legacy', 'run']);
export const HINDSIGHT_FIELDS = Object.freeze(['sic4', 'hq', 'segments', 'subsidiaries']);
/** The tool calls one reflection may make before its tools refuse, and what it may spend before it is stopped. */
export const MAX_REFLECTION_CALLS = 6;
export const MAX_REFLECTION_USD = 1;
/** A live pass's limit per reflection (the TL's for ARM D): reflections run beside the stream, so each stays small. */
export const LIVE_REFLECTION_USD = 0.35;

const RULES_HEAD = `You review one finished run of a research job, together with the true value of one field the run got wrong. Find why
the run missed it and where the true value could have been read.`;
const RULES_TOOLS = `You may check a source with fetch_page or read_document, at most ${MAX_REFLECTION_CALLS} calls.`;
const RULES_ANSWER = `Then call answer once, with one or two hypotheses. Each has:
- lesson: the general rule a later run should follow, in one or two sentences. It must hold for other companies:
  never the company's name, ticker or website, and never the true value itself.
- why: why this run missed.
- whereReadable: where the true value could have been read.
- scope: which companies the lesson holds for.
- mechanism: how a later run should carry it: a lesson it reads, a workflow node, or a skill line.
- test: how the host can check the lesson on past runs.`;
/** The reflection's rules; without tools they name none, so it is never told of a tool it lacks. */
export const hindsightRules = ({ tools = true } = {}) => [RULES_HEAD, ...(tools ? [RULES_TOOLS] : []), RULES_ANSWER].join(' ');
export const HINDSIGHT_RULES = hindsightRules();

const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });

/** The reflection's answer: one or two hypotheses. */
export function answerHindsight() {
  return {
    description: 'Give the hypotheses, once: one or two, each with the general lesson, why the run missed, where the true value could have been read, its scope, its mechanism and a test.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['hypotheses'],
      properties: {
        hypotheses: {
          type: 'array', minItems: 1, maxItems: 2,
          items: {
            type: 'object', additionalProperties: false, required: ['lesson', 'why', 'whereReadable', 'scope', 'mechanism', 'test'],
            properties: {
              lesson: text(Math.min(600, CAPS.text)), why: text(600), whereReadable: text(400), scope: text(300),
              mechanism: { type: 'string', enum: ['lesson', 'workflow-node', 'skill'] }, test: text(400),
            },
          },
        },
      },
    },
    recorded: (args) => `${args.hypotheses.length} hypothesis(es)`,
  };
}

/** The fields of a v4 score that are wrong, among `fields`, with the answer and the truth: the code when it is not the
 *  filed one, the headquarters when judged wrong, the segments below F1 0.8 (the scorer's bar), and the subsidiaries
 *  when a list exists and none of it was given. A field with no truth is never wrong. */
export function wrongFields(score, fields = HINDSIGHT_FIELDS, { codes } = {}) {
  if (!score) return [];
  const title = (code) => (codes ? groupsOf(codes).find((c) => c.code === code)?.name : undefined);
  const out = [];
  if (score.sicCorrect4 === false) out.push({ field: 'sic4', answer: score.sic4Answer, truth: score.sic4Truth, truthTitle: title(score.sic4Truth) ?? null });
  if (score.hqCorrect === false) out.push({ field: 'hq', answer: score.hqAnswer, truth: score.hqTruth });
  if (typeof score.segmentsF1 === 'number' && score.segmentsF1 < 0.8) out.push({ field: 'segments', answer: score.segmentsAnswer, truth: score.segmentsTruth });
  if (score.subsidiariesRecall === 0 && score.subsidiariesTruthCount > 0) out.push({ field: 'subsidiaries', answer: score.subsidiariesAnswer, truth: { count: score.subsidiariesTruthCount } });
  return out.filter((w) => fields.includes(w.field));
}

/** The true values a hindsight lesson may not carry: the code, the city, the segment names (the guard skips short ones). */
export function truthValues(wrong) {
  const out = [];
  for (const { field, truth } of wrong) {
    if (field === 'sic4' && truth) out.push(String(truth));
    if (field === 'hq' && truth?.city) out.push(truth.city);
    if (field === 'segments' && Array.isArray(truth)) for (const s of truth) out.push(...[s.label, s.member].filter(Boolean));
  }
  return out;
}

const urlOf = (r) => r.args?.url ?? r.args?.path ?? r.args?.query ?? r.value?.url ?? '';
const outcomeOf = (value, labelOnly) => (!value ? 'failed' : value.refused ? 'refused' : value.ok === false ? (labelOnly ? 'error' : `error${value.error ? `: ${value.error}` : ''}`) : 'ok');

/** An answer without the words its pages gave it: no cite quotes, no reason for a none. Its values stay. */
const labelAnswer = (answer) => {
  if (!answer || typeof answer !== 'object') return answer ?? null;
  const out = { ...answer };
  if (Array.isArray(out.cites)) out.cites = out.cites.map(({ claim, url, locator }) => ({ claim, url, locator }));
  if (out.subsidiaries && !Array.isArray(out.subsidiaries)) out.subsidiaries = { none: out.subsidiaries.none === true };
  return out;
};

/** What the run did, in order, as the reflection reads it: each tool call (tool, the URL or query it asked for, outcome),
 *  then the answer. LABEL-ONLY by default (01-loop 1.16): the run's own actions and values, and no text a page gave it
 *  (no titles, no tool's error words, no cite quotes, no reason for a none). `labelOnly: false` adds those back. */
export function digestOf(results, answer, { maxCalls = 60, maxAnswer = 4000, labelOnly = true } = {}) {
  const calls = results.slice(0, maxCalls).map((r, i) => `${i + 1}. ${r.tool} ${urlOf(r)} → ${outcomeOf(r.value, labelOnly)}${!labelOnly && r.value?.title ? ` "${String(r.value.title).slice(0, 80)}"` : ''}`);
  if (results.length > maxCalls) calls.push(`... ${results.length - maxCalls} more calls`);
  return `${calls.join('\n') || '(no tool calls)'}\n\nThe answer:\n${JSON.stringify(labelOnly ? labelAnswer(answer) : answer ?? null).slice(0, maxAnswer)}`;
}

/** The SEC's own record pages as the Wayback Machine archived them (01-loop 1.16), by the archived URL's path alone. */
const RECORD_KINDS = new Set(['index', 'headers', 'company', 'submissions']);
export function recordPage(url) {
  try { return archivedSecPage(new URL(url)) && RECORD_KINDS.has(pageKind(url)); } catch { return false; }
}

/** Tools that open only record pages: any other URL is refused before a request. */
export function recordPagesOnly(effects) {
  return effects.map((effect) => ({
    ...effect,
    run: async (args, options) => (recordPage(args?.url) ? effect.run(args, options) : { ok: false, refused: 'this review opens only the SEC\'s own record pages as archived' }),
  }));
}

/** The lessons a run was seeded with, as text (its working directory's seeded learnings), at most `max`. */
export function seededLessons(workspace, { max = 20, chars = 400 } = {}) {
  const dir = join(workspace, LAYOUT.seeded);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(0, max).map((f) => readFileSync(join(dir, f), 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, chars));
}

/** The job's Sources line, verbatim (its continuation lines joined): the first bullet that starts "Sources:" in the rules
 *  (AGENTS.md), else in the run's skills. Job text, not page text, so a reflection given it still does its own work. */
export function sourcesOf({ rules, workspace } = {}) {
  const bullet = (text) => {
    const lines = String(text ?? '').split('\n');
    const at = lines.findIndex((l) => /^- Sources:/.test(l));
    if (at < 0) return null;
    const out = [lines[at]];
    for (const l of lines.slice(at + 1)) { if (!/^ {2,}\S/.test(l)) break; out.push(l.trim()); }
    return out.join(' ');
  };
  const fromRules = bullet(rules);
  if (fromRules) return fromRules;
  const skills = workspace ? join(workspace, '.agents', 'skills') : null;
  if (!skills || !existsSync(skills)) return null;
  for (const name of readdirSync(skills).sort()) {
    const file = join(skills, name, 'SKILL.md');
    const found = existsSync(file) ? bullet(readFileSync(file, 'utf8')) : null;
    if (found) return found;
  }
  return null;
}

/** The reflection's prompt for one wrong field; `sources`, when given, is the job's Sources line, and `jobLine` the job's
 *  own first line when it is not the SEC job's. A field whose label is the teacher's (`wrong.label`) is shown as that
 *  agent's label, never as the truth. */
export function reflectionPrompt({ job, wrong, digest, lessons, sources, jobLine }) {
  const shown = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const label = wrong.label === 'teacher' ? 'The teacher\'s value (another agent\'s label, not ground truth)' : 'The true value';
  return [
    jobLine ?? `The job: classify ${job.name}${job.ticker ? ` (${job.ticker})` : ''}: its SEC SIC code, segments, headquarters, subsidiaries and latest annual report.`,
    `The field the run ${wrong.label === 'teacher' ? 'and the teacher disagree on' : 'got wrong'}: ${wrong.field}.`,
    `The run answered: ${shown(wrong.answer)}`,
    `${label}: ${shown(wrong.truth)}${wrong.truthTitle ? ` (${wrong.truthTitle})` : ''}`,
    `What the run did:\n${digest}`,
    `The lessons the run had:\n${lessons.length ? lessons.map((l) => `- ${l.replace(/\s+/g, ' ')}`).join('\n') : '(none)'}`,
    ...(sources ? [`The job's sources: ${sources.replace(/^- /, '')}`] : []),
  ].join('\n\n');
}

/** Tools that refuse once `max` calls are spent, so a reflection stays short. */
function budgeted(effects, max) {
  let calls = 0;
  return effects.map((effect) => ({
    ...effect,
    run: async (args, options) => (++calls > max ? { ok: false, refused: `this review's ${max} tool calls are spent` } : effect.run(args, options)),
  }));
}

/** One reflection: an agent call on `model` (`{ models, agent }`), offered `effects` and the answer, in its own store. It is
 *  stopped where it is once its spend passes `limitUsd`; `stopped` then says so, and an answer it had not given is none. */
export async function reflect({ model, effects, storePath, prompt, maxCalls = MAX_REFLECTION_CALLS, limitUsd = MAX_REFLECTION_USD, rules = hindsightRules({ tools: effects.length > 0 }) }) {
  const tools = classifyTools({ effects: budgeted(effects, maxCalls), answer: answerHindsight() });
  const registry = createRegistry();
  registry.install(tools.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(storePath), { models: model.models, registry, onReport: () => {} }, ctx);
  let stopped = null;
  let unsubscribe = () => {};
  try {
    const root = await harness.root(ctx, { agent: { ...model.agent, extensions: [tools.extension], instructions: rules } });
    let checking = false;
    unsubscribe = harness.subscribeCommits(() => {
      if (checking || stopped) return;
      checking = true;
      harness.usage(ctx).then(async (usage) => {
        if (usageTotals(usage).costUsd > limitUsd && !stopped) {
          stopped = `the review passed its limit of $${limitUsd}`;
          await root.abort(ctx).catch(() => {});
        }
      }).catch(() => {}).finally(() => { checking = false; });
    });
    const submission = await root.submit({ type: 'input', content: prompt }, ctx);
    await submission.wait(ctx);
    const { messages } = await root.context(ctx);
    const results = new Map(messages.filter((m) => m.role === 'toolResult').map((m) => [m.toolCallId, m]));
    const answers = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall' && c.name === 'answer' && !results.get(c.id)?.isError));
    return { hypotheses: answers.at(-1)?.arguments?.hypotheses ?? [], usage: usageTotals(await harness.usage(ctx)), stopped };
  } finally {
    unsubscribe();
    await harness.close(ctx);
  }
}

/** What a reflection read, structurally: its successful reads by kind (the SEC's record pages as archived, and every
 *  other page), an archived SEC page among them, and whether one showed the true code. */
export function verifiedBy(storePath, wrong, isRecord = recordPage) {
  const calls = toolResultsOf(storePath).filter((r) => r.tool !== 'answer');
  const read = calls.filter((r) => r.value && r.value.ok !== false && !r.value.refused && !r.value.error);
  const urlRead = (r) => r.value.url ?? r.args?.url;
  const archived = read.filter((r) => { try { return archivedSecPage(new URL(urlRead(r))); } catch { return false; } });
  const record = read.filter((r) => isRecord(urlRead(r))).length;
  const code = wrong.field === 'sic4' ? String(wrong.truth) : null;
  return {
    calls: calls.length,
    reads: { record, other: read.length - record },
    archivedSecRead: archived.length > 0,
    truthOnArchivedPage: code !== null && archived.some((r) => new RegExp(`\\b${code}\\b`).test(`${r.value.text ?? ''}`)),
  };
}

/**
 * The reflections for one finished run: one per wrong field among `fields`, each in its own store in `storeDir` (the
 * pass's, never the run's directory or the agent's home: the store holds the truth). None when the run's split is not
 * TRAIN's or no field is wrong. `model` (`{ models, agent }`) and `effects` (the tools it may check a source with,
 * fetch_page and read_document) are asked for only then, each as a value or a function that makes it; the tools are
 * disposed of after.
 */
export async function reflectOnRun({ job, run, score, answer, model, effects, fields = HINDSIGHT_FIELDS, codes, storeDir, labelOnly = true, rules, limitUsd = MAX_REFLECTION_USD, wrongOf = wrongFields, jobLine, isRecord = recordPage }) {
  if (!HINDSIGHT_SPLITS.includes(job.split)) return { wrong: [], reflections: [] };
  const wrong = wrongOf(score, fields, { codes });
  if (!wrong.length) return { wrong, reflections: [] };
  const digest = digestOf(toolResultsOf(run.storePath), answer, { labelOnly });
  const lessons = seededLessons(run.workspace);
  const sources = sourcesOf({ rules, workspace: run.workspace });
  const on = typeof model === 'function' ? model() : model;
  const tools = typeof effects === 'function' ? await effects() : effects;
  const reflections = [];
  try {
    for (const w of wrong) {
      const storePath = join(storeDir, `${run.runId}-${w.field}.sqlite`);
      const { hypotheses, usage, stopped } = await reflect({ model: on, effects: tools, storePath, prompt: reflectionPrompt({ job, wrong: w, digest, lessons, sources, jobLine }), limitUsd });
      reflections.push({ field: w.field, ...(w.label ? { label: w.label } : {}), hypotheses, costUsd: usage.costUsd, labelOnly, ...(stopped ? { stopped } : {}), ...verifiedBy(storePath, w, isRecord) });
    }
  } finally {
    for (const tool of tools) await tool.dispose?.();
  }
  return { wrong, reflections };
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a reflection's lessons are its own work (01-loop 1.16): no page read but the SEC's record pages, and no page
 *  text in its input. Otherwise they are untrusted, and curate asks whether they came from content. */
export const ownWork = (r) => r.labelOnly === true && (r.reads?.other ?? 1) === 0;

/** A hypothesis's evidence, kept with its proposal and never in the learning: its provenance first, then its reasons with
 *  the case's and the truth's values replaced, each reason cut so that all of it fits the guard's cap. */
function evidenceOf(r, h, values) {
  const clean = (t) => values.filter((v) => v.length >= 4).reduce((out, v) => out.replace(new RegExp(escape(v), 'gi'), '[the case]'), t);
  const reads = r.reads ?? { record: 0, other: 0 };
  const fixed = [`provenance: hindsight (field ${r.field})`, `reflection reads: ${reads.record + reads.other} (record ${reads.record}, other ${reads.other})`, `input: ${r.labelOnly ? 'label-only digest' : 'digest with page text'}`];
  const reasons = [`why: ${h.why}`, `where: ${h.whereReadable}`, `scope: ${h.scope}`, `mechanism: ${h.mechanism}`, `test: ${h.test}`].map(clean);
  const share = Math.floor((CAPS.evidence - fixed.reduce((n, f) => n + Buffer.byteLength(f), 0) - 16) / reasons.length);
  return [...fixed, ...reasons.map((item) => (Buffer.byteLength(item) > share ? `${Buffer.from(item).subarray(0, share - 3).toString('utf8').replace(/\uFFFD+$/, '')}...` : item))];
}

/**
 * Each hypothesis proposed as a lesson on its own branch, `runs/<run id>-h<n>`, with the run's seed, so the guard refusing
 * one (a lesson that names the company or the true value) leaves the others. It is untrusted unless its reflection's work
 * was its own (`ownWork`). The guard's case values are the job's and the wrong fields' true values. Returns each
 * proposal's status and provenance.
 */
export async function proposeHindsight({ repo, job, run, seedSha, wrong, reflections, truthValuesOf = truthValues }) {
  const values = [...caseValuesOf(job), ...truthValuesOf(wrong)];
  const out = [];
  let n = 0;
  for (const r of reflections) {
    for (const h of r.hypotheses) {
      const runId = `${run.runId}-h${++n}`;
      const untrusted = !ownWork(r);
      const candidates = [{ callId: `hindsight-${r.field}`, type: 'lesson', text: h.lesson, evidence: evidenceOf(r, h, values) }];
      const proposal = await proposeFiles({
        repo, runId, candidates,
        files: { [inboxPath(runId)]: renderInbox(runId, candidates, { ...(seedSha ? { seed: seedSha } : {}), untrusted }) },
        caseValues: values,
      });
      out.push({ runId, field: r.field, status: proposal.status, untrusted, ...(proposal.status === 'refused' ? { reasons: [...new Set(proposal.refusals.map((x) => x.reason))] } : {}) });
    }
  }
  return out;
}
