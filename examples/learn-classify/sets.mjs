// The jobs the loop runs (CLASSIFY-CONTRACT.md): v1 classifies a company into its 2-digit SIC group from its own site;
// v2 is the hard job, the 4-digit SIC code and the primary operating segment with cites, with search, a browser and a
// document reader beside fetch_page; v4, the dollar job, adds every segment, the headquarters, the subsidiaries and the
// latest annual report read page by page. A set says what the agent is given and how it answers; nothing in it decides a class.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerFacts, FACTS_RULES } from './facts-job.mjs';
import { answerV1, answerV2, answerV4, jobInput, jobText, sic2GroupsTool, sicCodesTool } from './host.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const readJsonIf = (file) => { try { return readJson(file); } catch { return undefined; } };

/** v2's input: only the name, the ticker and the website, and the website only when the truth set gives one. */
export const jobInputV2 = (job) => ({ name: job.name, ...(job.ticker ? { ticker: job.ticker } : {}), ...(job.website ? { website: job.website } : {}) });

export const jobTextV2 = (job) => [
  'Classify this company the way the SEC files it.',
  `Company: ${job.name}`,
  `Ticker: ${job.ticker ?? 'not given'}`,
  `Website: ${job.website ?? 'not given'}`,
  `A workflow for the whole job takes this input: ${JSON.stringify(jobInputV2(job))}`,
].join('\n');

/** The facts pass's job: the company, and the six facts its rules name (facts-job.mjs). */
export const jobTextFacts = (job) => [
  'Read this company\'s latest annual report and record the six facts the rules name.',
  `Company: ${job.name}`,
  `Ticker: ${job.ticker ?? 'not given'}`,
  `Website: ${job.website ?? 'not given'}`,
].join('\n');

/** The facts agent: it reads and records, chooses nothing, and so has no skill and no code tool. */
const FACTS_AGENT = {
  id: 'sec-facts', version: 1, name: 'SEC annual report reader',
  description: 'Reads a listed company\'s latest annual report and records six facts from it, each with where it was read.',
  instructions: 'You read a company\'s latest annual report from the web and record the six facts AGENTS.md names, each with the page it comes from and a quote. Follow AGENTS.md.',
  skills: [], tools: ['search_web', 'browse', 'fetch_page', 'read_document', 'answer'], max_cost_usd: 1,
};

const loadV4 = (data) => ({
  companies: readJson(join(data, 'companies-v4.json')),
  labels: readJson(join(data, 'sic2.json')),
  codes: readJson(join(data, 'sic-codes.json')),
  /** The SEC's own vocabulary (build-sic-filers.mjs): the codes and groups it files companies under, and its largest
   *  filers under each. A data directory without it offers every code, as v2 does. */
  vocabulary: readJsonIf(join(data, 'sic-filers.json')),
  report: readJsonIf(join(data, 'build-report-v4.json')),
});

export const SETS = Object.freeze({
  v1: Object.freeze({
    name: 'v1',
    agentDir: join(import.meta.dirname, 'agent'),
    /** The truth set and its label set, from a data directory. */
    load: (data) => ({
      companies: readJson(join(data, 'companies.json')),
      labels: readJson(join(data, 'sic2.json')),
      report: readJsonIf(join(data, 'build-report.json')),
    }),
    input: jobInput,
    text: jobText,
    labelTools: (d) => [sic2GroupsTool(d.labels)],
    answer: (d) => answerV1(d.labels),
    /** The field of a workflow's output, and of the answer, that byWorkflow compares. */
    answerKey: 'sic2',
  }),
  v2: Object.freeze({
    name: 'v2',
    agentDir: join(import.meta.dirname, 'agent-v2'),
    load: (data) => ({
      companies: readJson(join(data, 'companies-v2.json')),
      labels: readJson(join(data, 'sic2.json')),
      codes: readJson(join(data, 'sic-codes.json')),
      report: readJsonIf(join(data, 'build-report-v2.json')),
    }),
    input: jobInputV2,
    text: jobTextV2,
    labelTools: (d) => [sic2GroupsTool(d.labels), sicCodesTool(d.codes)],
    answer: (d) => answerV2(d.codes),
    answerKey: 'sic4',
  }),
  v4: Object.freeze({
    name: 'v4',
    agentDir: join(import.meta.dirname, 'agent-v4'),
    load: loadV4,
    input: jobInputV2,
    text: jobTextV2,
    labelTools: (d) => [sic2GroupsTool(d.labels, d.vocabulary), sicCodesTool(d.codes, d.vocabulary)],
    answer: (d) => answerV4(d.codes),
    answerKey: 'sic4',
  }),
  /** The facts pass (eval-facts.mjs): the v4 companies and tools, no code tool, and an answer with no place for a code. */
  facts: Object.freeze({
    name: 'facts',
    agentFiles: () => ({ 'agent.json': `${JSON.stringify(FACTS_AGENT, null, 2)}\n`, 'AGENTS.md': FACTS_RULES }),
    load: loadV4,
    input: jobInputV2,
    text: jobTextFacts,
    labelTools: () => [],
    answer: () => answerFacts(),
    answerKey: null,
  }),
});

/** The jobs with search, a browser and the document reader beside fetch_page: v2, v4 (each scored after its run) and the
 *  facts pass. */
export const isHard = (set) => set === SETS.v2 || set === SETS.v4 || set === SETS.facts;
