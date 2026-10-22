// The learn-mcc answer (SPEC.md): a merchant's card-acceptance profile from what it sells. The schema keeps to the
// keywords every model route takes on the wire (types, enum, const, ranges, lengths, required, additionalProperties);
// what it cannot say across fields is answerProblems', which the answer tool runs before it records anything.

export const RISK_TIERS = Object.freeze(['low', 'medium', 'high']);

/** What the merchant's own pages can show about how it sells; SPEC.md defines each. */
export const FLAGS = Object.freeze([
  'adult', 'gambling', 'crypto', 'money_services', 'financial_services', 'regulated_goods', 'nutraceuticals', 'subscription',
  'free_trial', 'travel', 'future_delivery', 'high_ticket', 'digital_goods', 'marketplace', 'site_unverified', 'no_policies',
]);

/** What the website given showed when the run read it. */
export const SITE_STATUSES = Object.freeze(['live', 'unreachable', 'parked', 'other_business']);

/** What an evidence item supports: the code, the tier, or one flag by its name. */
export const CLAIMS = Object.freeze(['mcc', 'risk', ...FLAGS]);

export const MAX_EVIDENCE = 10;
export const MAX_QUOTE = 300;

const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });

/** The job's input: the merchant's name and website, and the vertical it was listed under, context only. */
export const JOB_INPUT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['name', 'website'],
  properties: { name: text(200), website: text(600), vertical: text(200) },
});

/** The answer tool, given the MCC table (code to title, as mcc_codes gives it). */
export function answerMcc(codes) {
  return {
    description: 'Give the final answer, once: the merchant\'s 4-digit MCC from what it sells (a code from mcc_codes) and that code\'s title, its risk tier by the rubric with the rubric\'s reasons, the flags its own pages show, what its website showed, your confidence that the code is right, and 1 to 10 evidence items quoted verbatim from pages read in this run.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['mcc', 'mccDescription', 'riskTier', 'riskRationale', 'flags', 'siteStatus', 'evidence', 'confidence'],
      properties: {
        mcc: { type: 'string', enum: Object.keys(codes).sort(), description: 'A code from mcc_codes.' },
        mccDescription: { ...text(200), description: 'The code\'s title as mcc_codes names it.' },
        riskTier: { type: 'string', enum: [...RISK_TIERS] },
        riskRationale: { ...text(600), description: 'The rubric\'s rows that set the tier, in the merchant\'s terms.' },
        flags: { type: 'array', maxItems: FLAGS.length, items: { type: 'string', enum: [...FLAGS] }, description: 'Each flag a page read in this run shows; none it does not.' },
        siteStatus: { type: 'string', enum: [...SITE_STATUSES] },
        evidence: {
          type: 'array', minItems: 1, maxItems: MAX_EVIDENCE,
          items: {
            type: 'object', additionalProperties: false, required: ['claim', 'url', 'quote'],
            properties: {
              claim: { type: 'string', enum: [...CLAIMS], description: 'What it supports: mcc, risk, or a flag by its name.' },
              url: { ...text(600), description: 'The page, as read in this run.' },
              quote: { ...text(MAX_QUOTE), description: 'The page\'s own words, verbatim.' },
            },
          },
        },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'The probability that mcc is the code a card network would assign.' },
      },
    },
    recorded: (args) => args.mcc,
  };
}

/** Why an answer the schema admits is still not one: the title is not its code's, a flag has no evidence, evidence
 *  names a flag the answer does not give, a flag is given twice, or the code or the tier has no evidence. Empty: none. */
export function answerProblems(answer, codes) {
  const problems = [];
  if (codes[answer.mcc] !== undefined && answer.mccDescription !== codes[answer.mcc]) problems.push(`mccDescription is not ${answer.mcc}'s title in mcc_codes`);
  const claims = new Set(answer.evidence.map((e) => e.claim));
  for (const claim of ['mcc', 'risk']) if (!claims.has(claim)) problems.push(`no evidence item supports ${claim}`);
  if (new Set(answer.flags).size !== answer.flags.length) problems.push('a flag is given more than once');
  for (const flag of answer.flags) if (!claims.has(flag)) problems.push(`no evidence item supports the flag ${flag}`);
  for (const claim of claims) if (FLAGS.includes(claim) && !answer.flags.includes(claim)) problems.push(`evidence supports ${claim}, which is not among the flags`);
  return problems;
}
