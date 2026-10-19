// The two jobs the loop runs (CLASSIFY-CONTRACT.md): v1 classifies a company into its 2-digit SIC group from its own site;
// v2 is the hard job, the 4-digit SIC code and the primary operating segment with cites, with search, a browser and a
// document reader beside fetch_page. A set says what the agent is given and how it answers; nothing in it decides a class.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerV1, answerV2, jobInput, jobText, sic2GroupsTool, sicCodesTool } from './host.mjs';

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
});
