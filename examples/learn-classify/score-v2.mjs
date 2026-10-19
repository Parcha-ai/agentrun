// The v2 scorer (CLASSIFY-CONTRACT.md v2): the SIC code is matched structurally; whether the answer names the primary
// segment, and whether each cite holds up against what the run actually read, are Jev's to judge. Nothing is fetched
// again: the cites are checked against the text the run's own tools returned.

export const SEGMENT_QUESTION = 'Does `answer` name the same reporting segment as `truth`, the company\'s primary operating segment as the company files it? `members` lists every segment the company reports. Count it as the same when it uses other words for that segment, names the business an abbreviated member stands for, or names a region as filed. For a company that reports one segment (`truth.kind` "single"), an answer that it is one segment or the whole company is the same. `rules` are the scoring rules.';
export const CITE_QUESTION = 'Does `text`, which the run read at `url`, support `claim`: does it say what `quote` says, at or near `locator`?';
/** How far a share of revenue may be from the filed one and still count. */
export const SHARE_TOLERANCE = 0.1;
const MAX_CITE_TEXT = 24_000;

/** A URL as the run's tools and its cites may spell it: no fragment, no trailing slash, no www, the host in lower case. */
export function sameUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return String(url).trim().replace(/\/+$/, '');
  }
}

const folded = (text) => String(text).toLowerCase().replace(/\s+/g, ' ').trim();

/** The truth's segment as a row shows it. */
export const segmentTruthOf = (truth) => (truth ? { kind: truth.kind, name: truth.name ?? null, share: typeof truth.share === 'number' ? truth.share : null } : null);

async function yes(judge, label, question, state) {
  const result = await judge({ label, kind: 'judge', state, questions: { q: { type: 'noul', instructions: question } } });
  const p = result?.answers?.q?.noul;
  if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error(`the scorer's ${label} question came back without a probability`);
  return p >= 0.5;
}

/** Whether the answer names the primary segment, and how far its share is from the filed one. */
export async function scoreSegment({ answer, truth, members = [], rules = [], judge }) {
  if (!truth) return { segmentCorrect: null, shareError: null };
  const given = answer?.primarySegment;
  if (!given) return { segmentCorrect: false, shareError: null };
  const single = truth.kind === 'single';
  if (given.oneSegment === true) return { segmentCorrect: single, shareError: null };
  const truthShare = typeof truth.share === 'number' ? truth.share : single ? 1 : null;
  const shareError = typeof given.share === 'number' && truthShare !== null ? Math.abs(given.share - truthShare) : null;
  // A share is owed when the filing has one and the company reports more than one segment.
  const shareOk = single ? shareError === null || shareError <= SHARE_TOLERANCE : truthShare === null || (shareError !== null && shareError <= SHARE_TOLERANCE);
  const names = [truth.name, truth.member].filter(Boolean).map(folded);
  const named = names.includes(folded(given.name)) || await yes(judge, 'score/segment', SEGMENT_QUESTION, {
    answer: { name: given.name },
    truth: { kind: truth.kind, name: truth.name ?? null, member: truth.member ?? null },
    members: members.map((m) => ({ name: m.name, member: m.member })),
    rules,
  });
  return { segmentCorrect: named && shareOk, shareError };
}

/** The share of the answer's cites that what the run read at their URL supports; a cite of a URL the run never read
 *  supports nothing. */
export async function scoreEvidence({ answer, read, codes = {}, judge }) {
  const cites = answer?.evidence;
  if (!Array.isArray(cites) || !cites.length) return { evidenceSupported: null };
  let supported = 0;
  for (const cite of cites) {
    const texts = read.filter((r) => sameUrl(r.url) === sameUrl(cite.url)).map((r) => r.text);
    if (!texts.length) continue;
    const segment = answer.primarySegment;
    const claim = cite.claim === 'sic'
      ? `The company's main business is SIC ${answer.sic4} (${codes[answer.sic4] ?? 'unknown code'}).`
      : segment?.oneSegment ? 'The company reports one operating segment.'
        : `${segment?.name}${typeof segment?.share === 'number' ? `, at ${Math.round(segment.share * 100)}% of revenue,` : ''} is the company's largest operating segment.`;
    const text = [...new Set(texts)].join('\n\n').slice(0, MAX_CITE_TEXT);
    if (await yes(judge, 'score/cite', CITE_QUESTION, { claim, quote: cite.quote, locator: cite.locator, url: cite.url, text })) supported += 1;
  }
  return { evidenceSupported: supported / cites.length };
}

/**
 * The v2 score of one run. `company` is the truth row, `report` the build report's entry for it (its full member list),
 * `rules` the report's scoring rules, `read` what the run read (`textsRead`), `judge` a runJudge port.
 */
export async function scoreV2({ answer, company, report, rules, read, codes, judge }) {
  const truth = company.segmentTruth ?? null;
  const sic4Answer = answer?.sic4 ?? null;
  const sicCorrect4 = sic4Answer !== null && sic4Answer === company.sic;
  const sicCorrect2 = sic4Answer !== null && sic4Answer.slice(0, 2) === String(company.sic).slice(0, 2);
  const segment = await scoreSegment({ answer, truth, members: report?.segments ?? [], rules, judge });
  const evidence = answer ? await scoreEvidence({ answer, read, codes, judge }) : { evidenceSupported: null };
  return {
    sic4Answer, sic4Truth: company.sic, sicCorrect4, sicCorrect2,
    segmentAnswer: answer?.primarySegment ?? null, segmentTruth: segmentTruthOf(truth), ...segment, ...evidence,
    correct: sicCorrect4 && segment.segmentCorrect !== false,
  };
}
