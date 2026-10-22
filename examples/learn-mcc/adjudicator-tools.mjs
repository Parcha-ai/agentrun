// The adjudicator's run, the contract the runner wires (ADJUDICATION.md §5): one run per sample merchant, its input the
// merchant's name and website. Two host tools and an answer. `site` records stage 1 (the adjudicator's own code and the
// tiers the risk rubric allows, from the site alone). `codes` gives the candidate codes and refuses until stage 1 is
// recorded. `verdict`, the answer, judges every candidate acceptable or not. Blindness is in the code: no candidate
// reaches the run before its own judgment does, and no candidate says whose it is. ADJUDICATION-RUN.md names the runner.
import { allowedTiers } from './adjudication.mjs';
import { MAX_QUOTE, RISK_TIERS } from './answer.mjs';
import { mccOf } from './score-mcc.mjs';

export const MAX_ADJ_EVIDENCE = 5;

const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });
const EVIDENCE = {
  type: 'array', minItems: 1, maxItems: MAX_ADJ_EVIDENCE,
  items: {
    type: 'object', additionalProperties: false, required: ['url', 'quote'],
    properties: { url: { ...text(600), description: 'The page, as read in this run.' }, quote: { ...text(MAX_QUOTE), description: 'The page\'s own words, verbatim.' } },
  },
};
const CODE = { type: 'string', pattern: '^[0-9]{4}$' };
const STEP_RESULT = { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean' }, refused: { type: 'string' }, next: { type: 'string' } } };

const evidenceProblem = (evidence, what) => (Array.isArray(evidence) && evidence.length && evidence.every((e) => e?.url && e?.quote) ? null : `${what} needs evidence: a url and a verbatim quote each`);

/**
 * One merchant's run. `candidates` is its list from adjudication.mjs's candidate table (`[{ code, title }]`), `groups`
 * the code tables (score-mcc's loadGroups). Returns the two host tools, the answer tool (`answer`: description and
 * parameters, as answerMcc gives them), `problems(verdict)` (empty when the answer can be recorded), and
 * `record(verdict)`, the run's stage 1 and stage 2 as unblind reads them.
 */
export function adjudicatorRun({ candidates, groups }) {
  let stage1 = null;
  let shown = false;
  const site = {
    name: 'site',
    description: 'Stage 1, once, from the merchant\'s site alone and before you see any candidate code: your own MCC for this merchant (a code from mcc_codes) with evidence, and the risk tier the rubric gives it (two adjacent tiers only when the evidence supports both readings) with evidence. When the site cannot be judged (it does not load, it is parked, or it sells nothing now), give only `unjudgeable` with the reason.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        own: { type: 'object', additionalProperties: false, required: ['mcc', 'evidence'], properties: { mcc: { ...CODE, description: 'Your own code, from mcc_codes.' }, evidence: EVIDENCE } },
        risk: { type: 'object', additionalProperties: false, required: ['tiers', 'evidence'], properties: { tiers: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: [...RISK_TIERS] } }, evidence: EVIDENCE } },
        unjudgeable: { ...text(300), description: 'Why the site cannot be judged; give nothing else with it.' },
      },
    },
    resultSchema: STEP_RESULT,
    run: async (args = {}) => {
      if (stage1) return { refused: 'Stage 1 is already recorded for this merchant.' };
      if (args.unjudgeable) {
        if (args.own || args.risk) return { refused: 'unjudgeable goes alone: no own code and no risk with it.' };
        stage1 = { unjudgeable: args.unjudgeable };
        return { recorded: true, next: 'Answer with verdict and no codes.' };
      }
      const own = mccOf(args.own?.mcc);
      if (own === null || groups.codes[own] === undefined) return { refused: 'own.mcc must be a code from mcc_codes.' };
      const problem = evidenceProblem(args.own.evidence, 'own');
      if (problem) return { refused: problem };
      try {
        allowedTiers(args.risk, 'risk');
      } catch (error) {
        return { refused: error.message };
      }
      stage1 = { own: { mcc: own, evidence: args.own.evidence }, risk: { tiers: args.risk.tiers, evidence: args.risk.evidence } };
      return { recorded: true, next: 'Call codes for the candidate codes.' };
    },
  };
  const codes = {
    name: 'codes',
    description: 'Stage 2: the candidate codes for this merchant, each with its title, each once, in no particular order and with no source. Refused until site has recorded stage 1.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    resultSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        candidates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'title'], properties: { code: { type: 'string' }, title: { type: 'string' } } } },
        refused: { type: 'string' },
      },
    },
    run: async () => {
      if (!stage1) return { refused: 'Record stage 1 with site first: your own code and the risk tiers, from the site alone.' };
      shown = true;
      return { candidates: stage1.unjudgeable ? [] : candidates };
    },
  };
  const answer = {
    description: 'Give the verdict, once, after codes: every candidate code, each once, acceptable or not by the MCC rules, with evidence from the merchant\'s pages read in this run. When stage 1 found the site unjudgeable, give no codes.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['codes'],
      properties: {
        codes: {
          type: 'array', maxItems: candidates.length,
          items: {
            type: 'object', additionalProperties: false, required: ['code', 'acceptable', 'evidence'],
            properties: { code: { ...CODE, description: 'A candidate code from codes.' }, acceptable: { type: 'boolean' }, evidence: EVIDENCE },
          },
        },
      },
    },
  };
  const problems = (verdict) => {
    if (!stage1) return ['record stage 1 with site first'];
    if (!shown) return ['call codes first'];
    const given = Array.isArray(verdict?.codes) ? verdict.codes : [];
    if (stage1.unjudgeable) return given.length ? ['the site was judged unjudgeable: give no codes'] : [];
    const out = [];
    const seen = new Set();
    for (const item of given) {
      if (!candidates.some((c) => c.code === item.code)) out.push(`${item.code} is not a candidate`);
      else if (seen.has(item.code)) out.push(`${item.code} is judged twice`);
      seen.add(item.code);
      const problem = evidenceProblem(item.evidence, item.code);
      if (problem) out.push(problem);
    }
    for (const c of candidates) if (!seen.has(c.code)) out.push(`${c.code} is not judged`);
    return out;
  };
  const record = (verdict) => {
    if (problems(verdict).length) throw new Error(`the verdict cannot be recorded: ${problems(verdict).join('; ')}`);
    return { stage1, stage2: { codes: Object.fromEntries((stage1.unjudgeable ? [] : verdict.codes).map((c) => [c.code, { acceptable: c.acceptable, evidence: c.evidence }])) } };
  };
  return { tools: [site, codes], answer, problems, record };
}
