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
import { archivedSecPage } from './tools.mjs';

/** The splits a learning pass may reflect on with the truth: TRAIN, and the older sets' run split. Never DEV or TEST. */
export const HINDSIGHT_SPLITS = Object.freeze(['train', 'run']);
export const HINDSIGHT_FIELDS = Object.freeze(['sic4', 'hq', 'segments', 'subsidiaries']);
/** The tool calls one reflection may make before its tools refuse. */
export const MAX_REFLECTION_CALLS = 6;

export const HINDSIGHT_RULES = `You review one finished run of a research job, together with the true value of one field the run got wrong. Find why
the run missed it and where the true value could have been read. You may check a source with fetch_page or
read_document, at most ${MAX_REFLECTION_CALLS} calls. Then call answer once, with one or two hypotheses. Each has:
- lesson: the general rule a later run should follow, in one or two sentences. It must hold for other companies:
  never the company's name, ticker or website, and never the true value itself.
- why: why this run missed.
- whereReadable: where the true value could have been read.
- scope: which companies the lesson holds for.
- mechanism: how a later run should carry it: a lesson it reads, a workflow node, or a skill line.
- test: how the host can check the lesson on past runs.`;

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

const urlOf = (r) => r.value?.url ?? r.args?.url ?? r.args?.path ?? r.args?.query ?? '';
const outcomeOf = (value) => (!value ? 'failed' : value.refused ? 'refused' : value.ok === false ? `error${value.error ? `: ${value.error}` : ''}` : 'ok');

/** What the run did, in order, as the reflection reads it: each tool call (tool, URL or query, outcome, title), then the
 *  answer with its cites. */
export function digestOf(results, answer, { maxCalls = 60, maxAnswer = 4000 } = {}) {
  const calls = results.slice(0, maxCalls).map((r, i) => `${i + 1}. ${r.tool} ${urlOf(r)} → ${outcomeOf(r.value)}${r.value?.title ? ` "${String(r.value.title).slice(0, 80)}"` : ''}`);
  if (results.length > maxCalls) calls.push(`... ${results.length - maxCalls} more calls`);
  return `${calls.join('\n') || '(no tool calls)'}\n\nThe answer:\n${JSON.stringify(answer ?? null).slice(0, maxAnswer)}`;
}

/** The lessons a run was seeded with, as text (its working directory's seeded learnings), at most `max`. */
export function seededLessons(workspace, { max = 20, chars = 400 } = {}) {
  const dir = join(workspace, LAYOUT.seeded);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(0, max).map((f) => readFileSync(join(dir, f), 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, chars));
}

/** The reflection's prompt for one wrong field. */
export function reflectionPrompt({ job, wrong, digest, lessons }) {
  const shown = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  return [
    `The job: classify ${job.name}${job.ticker ? ` (${job.ticker})` : ''}: its SEC SIC code, segments, headquarters, subsidiaries and latest annual report.`,
    `The field the run got wrong: ${wrong.field}.`,
    `The run answered: ${shown(wrong.answer)}`,
    `The true value: ${shown(wrong.truth)}${wrong.truthTitle ? ` (${wrong.truthTitle})` : ''}`,
    `What the run did:\n${digest}`,
    `The lessons the run had:\n${lessons.length ? lessons.map((l) => `- ${l.replace(/\s+/g, ' ')}`).join('\n') : '(none)'}`,
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

/** One reflection: an agent call on `model` (`{ models, agent }`), offered `effects` and the answer, in its own store. */
export async function reflect({ model, effects, storePath, prompt, maxCalls = MAX_REFLECTION_CALLS }) {
  const tools = classifyTools({ effects: budgeted(effects, maxCalls), answer: answerHindsight() });
  const registry = createRegistry();
  registry.install(tools.extension);
  const harness = await Harness.open(await openNodeSqliteStorage(storePath), { models: model.models, registry, onReport: () => {} }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { ...model.agent, extensions: [tools.extension], instructions: HINDSIGHT_RULES } });
    const submission = await root.submit({ type: 'input', content: prompt }, ctx);
    await submission.wait(ctx);
    const { messages } = await root.context(ctx);
    const results = new Map(messages.filter((m) => m.role === 'toolResult').map((m) => [m.toolCallId, m]));
    const answers = messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall' && c.name === 'answer' && !results.get(c.id)?.isError));
    return { hypotheses: answers.at(-1)?.arguments?.hypotheses ?? [], usage: usageTotals(await harness.usage(ctx)) };
  } finally {
    await harness.close(ctx);
  }
}

/** What a reflection read, structurally: an archived SEC page it opened, and whether one showed the true code. */
export function verifiedBy(storePath, wrong) {
  const calls = toolResultsOf(storePath).filter((r) => r.tool !== 'answer');
  const read = calls.filter((r) => r.value && r.value.ok !== false && !r.value.refused);
  const archived = read.filter((r) => { try { return archivedSecPage(new URL(r.value.url ?? r.args?.url)); } catch { return false; } });
  const code = wrong.field === 'sic4' ? String(wrong.truth) : null;
  return {
    calls: calls.length,
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
export async function reflectOnRun({ job, run, score, answer, model, effects, fields = HINDSIGHT_FIELDS, codes, storeDir }) {
  if (!HINDSIGHT_SPLITS.includes(job.split)) return { wrong: [], reflections: [] };
  const wrong = wrongFields(score, fields, { codes });
  if (!wrong.length) return { wrong, reflections: [] };
  const digest = digestOf(toolResultsOf(run.storePath), answer);
  const lessons = seededLessons(run.workspace);
  const on = typeof model === 'function' ? model() : model;
  const tools = typeof effects === 'function' ? await effects() : effects;
  const reflections = [];
  try {
    for (const w of wrong) {
      const storePath = join(storeDir, `${run.runId}-${w.field}.sqlite`);
      const { hypotheses, usage } = await reflect({ model: on, effects: tools, storePath, prompt: reflectionPrompt({ job, wrong: w, digest, lessons }) });
      reflections.push({ field: w.field, hypotheses, costUsd: usage.costUsd, ...verifiedBy(storePath, w) });
    }
  } finally {
    for (const tool of tools) await tool.dispose?.();
  }
  return { wrong, reflections };
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A hypothesis's evidence, kept with its proposal and never in the learning: the case's and the truth's values replaced,
 *  each item cut so that all of it fits the guard's cap. */
function evidenceOf(field, h, values) {
  const clean = (t) => values.filter((v) => v.length >= 4).reduce((out, v) => out.replace(new RegExp(escape(v), 'gi'), '[the case]'), t);
  const items = [`field: ${field}`, `why: ${h.why}`, `where: ${h.whereReadable}`, `scope: ${h.scope}`, `mechanism: ${h.mechanism}`, `test: ${h.test}`].map(clean);
  const share = Math.floor((CAPS.evidence - 16) / items.length);
  return items.map((item) => (Buffer.byteLength(item) > share ? `${Buffer.from(item).subarray(0, share - 3).toString('utf8').replace(/�+$/, '')}...` : item));
}

/**
 * Each hypothesis proposed as a lesson on its own branch, `runs/<run id>-h<n>`, with the run's seed and marked untrusted,
 * so the guard refusing one (a lesson that names the company or the true value) leaves the others. The guard's case
 * values are the job's and the wrong fields' true values. Returns each proposal's status.
 */
export async function proposeHindsight({ repo, job, run, seedSha, wrong, reflections }) {
  const values = [...caseValuesOf(job), ...truthValues(wrong)];
  const out = [];
  let n = 0;
  for (const r of reflections) {
    for (const h of r.hypotheses) {
      const runId = `${run.runId}-h${++n}`;
      const candidates = [{ callId: `hindsight-${r.field}`, type: 'lesson', text: h.lesson, evidence: evidenceOf(r.field, h, values) }];
      const proposal = await proposeFiles({
        repo, runId, candidates,
        files: { [inboxPath(runId)]: renderInbox(runId, candidates, { ...(seedSha ? { seed: seedSha } : {}), untrusted: true }) },
        caseValues: values,
      });
      out.push({ runId, field: r.field, status: proposal.status, ...(proposal.status === 'refused' ? { reasons: [...new Set(proposal.refusals.map((x) => x.reason))] } : {}) });
    }
  }
  return out;
}
