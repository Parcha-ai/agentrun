// The v4 scorer (CLASSIFY-CONTRACT.md v4, "the dollar job"): structural where it can be, Jev where meaning is judged.
// Nothing is fetched again: cites are checked against the text the run's own tools returned.
import { CITE_QUESTION, sameUrl } from './score-v2.mjs';

export const SEGMENT_PICK = 'Which of the company\'s reported segments (`truth`) is the same segment as `answer`, named in other words, by the business an abbreviated member stands for, or by a region as filed? Choose none when it is none of them.';
export const HQ_QUESTION = 'Do `answer` and `truth` name the same headquarters city and country, counting another name or spelling of the same city or country (`truth.country` is an ISO code)?';
export const SUBSIDIARY_QUESTION = 'Is `subsidiary` one of the companies in `listed` (the company\'s own list of its subsidiaries), the same entity perhaps named a little differently?';
/** How many subsidiaries an answer may give: recall is over at most this many of the listed ones. */
export const MAX_SUBSIDIARIES = 15;
const MAX_LISTED_TEXT = 24_000;

/** The sum of a filed segment list's shares: as filed it can pass 1 (intersegment revenue) or fall short of it. */
export const shareSum = (segments) => (Array.isArray(segments) && segments.some((s) => typeof s.share === 'number') ? segments.reduce((sum, s) => sum + (typeof s.share === 'number' ? s.share : 0), 0) : null);

const folded = (text) => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** An XBRL segment member as words: "WaterSystemsMember" is "water systems". */
const memberWords = (member) => folded(String(member ?? '').replace(/(Segment)?Member$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));

// ISO 3166 codes for the countries SEC filers name, by the names and short forms an answer may use.
const COUNTRIES = {
  US: ['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america'],
  CA: ['canada'], GB: ['united kingdom', 'uk', 'u k', 'england', 'great britain', 'britain', 'scotland', 'wales', 'northern ireland'],
  IE: ['ireland', 'republic of ireland'], IL: ['israel'], CN: ['china', 'prc', 'people s republic of china', 'mainland china'],
  HK: ['hong kong', 'hong kong sar', 'hong kong s a r'], MO: ['macau', 'macao'], TW: ['taiwan', 'republic of china'], SG: ['singapore'], JP: ['japan'],
  KR: ['south korea', 'korea', 'republic of korea'], IN: ['india'], DE: ['germany'], FR: ['france'], NL: ['netherlands', 'the netherlands', 'holland'],
  CH: ['switzerland'], LU: ['luxembourg'], BE: ['belgium'], ES: ['spain'], IT: ['italy'], SE: ['sweden'], DK: ['denmark'], NO: ['norway'],
  FI: ['finland'], AU: ['australia'], NZ: ['new zealand'], BR: ['brazil'], MX: ['mexico'], AR: ['argentina'], CL: ['chile'], CO: ['colombia'],
  PE: ['peru'], BM: ['bermuda'], KY: ['cayman islands', 'the cayman islands', 'cayman'], VG: ['british virgin islands', 'bvi', 'virgin islands british'],
  BS: ['bahamas', 'the bahamas'], PA: ['panama'], ZA: ['south africa'], GR: ['greece'], CY: ['cyprus'], MT: ['malta'], MC: ['monaco'],
  AE: ['united arab emirates', 'uae', 'u a e'], SA: ['saudi arabia'], TR: ['turkey', 'turkiye'], RU: ['russia', 'russian federation'], PL: ['poland'],
  CZ: ['czech republic', 'czechia'], HU: ['hungary'], AT: ['austria'], PT: ['portugal'], PH: ['philippines'], TH: ['thailand'], MY: ['malaysia'],
  ID: ['indonesia'], VN: ['vietnam', 'viet nam'], UY: ['uruguay'], IS: ['iceland'], JE: ['jersey'], GG: ['guernsey'], IM: ['isle of man'],
  MH: ['marshall islands'], LR: ['liberia'], KZ: ['kazakhstan'], UA: ['ukraine'], EG: ['egypt'], NG: ['nigeria'], KE: ['kenya'],
};
const BY_NAME = new Map(Object.entries(COUNTRIES).flatMap(([code, names]) => [[code.toLowerCase(), code], ...names.map((n) => [n, code])]));

/** A country as an ISO code when the table knows it, else its folded name. */
export const countryCode = (country) => BY_NAME.get(folded(country)) ?? folded(country);

const legalForm = /\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|plc|p l c|gmbh|ag|sa|s a|sas|sarl|s a r l|srl|s r l|spa|s p a|bv|b v|nv|n v|pty|kk|k k|oy|ab|as|a s|lp|l p|llp|l l p|pte|sdn bhd|bhd|de cv|s de r l|sa de cv|ulc|lc)\b/g;
/** A company name with its legal form left out, for a structural match. */
export const entityName = (name) => folded(name).replace(legalForm, ' ').replace(/\s+/g, ' ').trim();

async function noul(judge, label, question, state) {
  const result = await judge({ label, kind: 'judge', state, questions: { q: { type: 'noul', instructions: question } } });
  const p = result?.answers?.q?.noul;
  if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error(`the scorer's ${label} question came back without a probability`);
  return p;
}

/**
 * segmentsF1: a one-to-one match of the answer's segments to the filed ones. A name or member that is the same words
 * matches at once; the rest are Jev's, one choice per answer segment over the filed segments not yet taken, the surest
 * first. shareErrorMean is the mean distance of the matched shares, in points, from the filed shares normalized to sum 1
 * (an answer from a segment table divides by the segments' own total). A filer that reports one segment
 * (`{ oneSegment: true }`) has one segment by no name: oneSegment matches it, and so does any one answer segment. No
 * segment truth: both null.
 */
export async function scoreSegments({ answer, truth, judge }) {
  const given = answer?.segments;
  if (truth?.oneSegment === true) {
    if (!given) return { segmentsF1: 0, shareErrorMean: null };
    // Precision 1/n and recall 1 for n answer segments: F1 2/(n+1).
    return { segmentsF1: Array.isArray(given) ? 2 / (given.length + 1) : given.oneSegment === true ? 1 : 0, shareErrorMean: null };
  }
  const filed = Array.isArray(truth) ? truth : [];
  if (!filed.length) return { segmentsF1: null, shareErrorMean: null };
  if (!given) return { segmentsF1: 0, shareErrorMean: null };
  if (!Array.isArray(given)) return { segmentsF1: given.oneSegment === true && filed.length === 1 ? 1 : 0, shareErrorMean: null };
  const taken = new Set();
  const pairs = [];
  const open = [];
  for (const [i, segment] of given.entries()) {
    const name = folded(segment.name);
    const j = filed.findIndex((t, k) => !taken.has(k) && (folded(t.label) === name || memberWords(t.member) === name));
    if (j >= 0) { taken.add(j); pairs.push([i, j]); } else open.push(i);
  }
  const free = filed.map((t, k) => k).filter((k) => !taken.has(k));
  if (open.length && free.length) {
    const criteria = Object.fromEntries([...free.map((k) => [`t${k}`, `${filed[k].label ?? memberWords(filed[k].member)}${filed[k].member ? ` (${filed[k].member})` : ''}`]), ['none_of_these', 'none of these segments']]);
    const questions = Object.fromEntries(open.map((i) => [`a${i}`, { type: 'choice', instructions: SEGMENT_PICK, criteria }]));
    const result = await judge({
      label: 'score/segments', kind: 'judge',
      state: { answer: open.map((i) => ({ id: `a${i}`, name: given[i].name })), truth: free.map((k) => ({ id: `t${k}`, label: filed[k].label ?? null, member: filed[k].member ?? null })) },
      questions,
    });
    const offers = open.flatMap((i) => {
      const a = result?.answers?.[`a${i}`];
      if (!a || a.type !== 'choice') throw new Error('the scorer\'s segment question came back without a choice');
      return a.choice === 'none_of_these' ? [] : [{ i, k: Number(a.choice.slice(1)), p: a.probabilities?.[a.choice] ?? a.confidence ?? 0 }];
    }).sort((x, y) => y.p - x.p);
    const used = new Set();
    for (const offer of offers) {
      if (used.has(offer.i) || taken.has(offer.k)) continue;
      used.add(offer.i); taken.add(offer.k); pairs.push([offer.i, offer.k]);
    }
  }
  const precision = pairs.length / given.length;
  const recall = pairs.length / filed.length;
  const segmentsF1 = pairs.length ? (2 * precision * recall) / (precision + recall) : 0;
  const sum = shareSum(filed);
  const errors = pairs.filter(([i, k]) => typeof given[i].share === 'number' && typeof filed[k].share === 'number' && sum > 0).map(([i, k]) => Math.abs(given[i].share - filed[k].share / sum) * 100);
  return { segmentsF1, shareErrorMean: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null };
}

/** A city as filed (sub.txt's cityba): the city alone, without a province or country after a comma or a district in brackets. */
const filedCity = (city) => folded(String(city ?? '').split(',')[0].replace(/\(.*?\)/g, ' '));

/** hqCorrect: the city and the country after folding (the country as its ISO code, the filed city without what follows a
 *  comma or sits in brackets), else Jev on an alias. No truth (no city or no country): null. */
export async function scoreHq({ answer, truth, judge }) {
  if (!truth?.city || !truth?.country) return { hqCorrect: null };
  const hq = answer?.hq;
  if (!hq?.city || !hq?.country) return { hqCorrect: false };
  const city = folded(hq.city);
  if ((city === folded(truth.city) || city === filedCity(truth.city)) && countryCode(hq.country) === countryCode(truth.country)) return { hqCorrect: true };
  const p = await noul(judge, 'score/hq', HQ_QUESTION, { answer: { city: hq.city, state: hq.state ?? null, country: hq.country }, truth: { city: truth.city, state: truth.state ?? null, country: truth.country } });
  return { hqCorrect: p >= 0.5 };
}

/**
 * subsidiariesRecall and subsidiariesPrecision against the company's own list (`{ exhibit, url, count, items }`, its
 * Exhibit 21 or 8), one to one: a name the same as a listed one not yet taken matches it, first word for word, then once
 * the legal form is left out (two entities named alike in two jurisdictions are two). A name whose listed namesakes are
 * all taken is a repeat and matches nothing; any other name is Jev's against the whole list. Recall is over at most 15 of
 * the listed ones (the exhibit's count), the most an answer may give. No list: both null.
 */
export async function scoreSubsidiaries({ answer, truth, judge }) {
  const listed = Array.isArray(truth?.items) ? truth.items : null;
  if (!listed?.length) return { subsidiariesRecall: null, subsidiariesPrecision: null };
  const count = typeof truth.count === 'number' && truth.count >= listed.length ? truth.count : listed.length;
  const given = [...new Map((answer?.subsidiaries ?? []).map((s) => [folded(s.name), s])).values()];
  if (!given.length) return { subsidiariesRecall: 0, subsidiariesPrecision: null };
  const taken = new Set();
  const take = (same) => {
    const k = listed.findIndex((item, i) => !taken.has(i) && same(item));
    if (k >= 0) taken.add(k);
    return k >= 0;
  };
  const matched = new Set();
  for (const [i, s] of given.entries()) if (take((item) => folded(item.name) === folded(s.name))) matched.add(i);
  for (const [i, s] of given.entries()) if (!matched.has(i) && take((item) => entityName(item.name) === entityName(s.name))) matched.add(i);
  const text = listed.map((s) => s.name).join('; ').slice(0, MAX_LISTED_TEXT);
  let found = matched.size;
  for (const [i, s] of given.entries()) {
    if (matched.has(i) || listed.some((item) => entityName(item.name) === entityName(s.name))) continue;
    if ((await noul(judge, 'score/subsidiary', SUBSIDIARY_QUESTION, { subsidiary: s.name, listed: text })) >= 0.5) found += 1;
  }
  return { subsidiariesRecall: Math.min(1, found / Math.min(count, MAX_SUBSIDIARIES)), subsidiariesPrecision: found / given.length };
}

const claimOf = (cite, answer, codes) => {
  switch (cite.claim) {
    case 'sic': return `The company's main business is SIC ${answer.sic4} (${codes[answer.sic4] ?? 'unknown code'}).`;
    case 'segment': return Array.isArray(answer.segments)
      ? `The company's reportable operating segments include ${answer.segments.map((s) => `${s.name} (${Math.round(s.share * 100)}% of revenue)`).join(', ')}.`
      : 'The company reports one operating segment.';
    case 'hq': return `The company's headquarters are in ${[answer.hq?.city, answer.hq?.state, answer.hq?.country].filter(Boolean).join(', ')}.`;
    case 'subsidiary': return `At least one of these is a subsidiary of the company: ${(answer.subsidiaries ?? []).map((s) => s.name).join(', ')}.`;
    default: return `This is the company's annual report for fiscal year ${answer.annualReport?.fiscalYear}.`;
  }
};

/** The share of the answer's cites that what the run read at their URL supports; a URL it never read supports nothing. */
export async function scoreCites({ answer, read, codes = {}, judge }) {
  const cites = answer?.cites;
  if (!Array.isArray(cites) || !cites.length) return { evidenceSupported: null };
  let supported = 0;
  for (const cite of cites) {
    const texts = read.filter((r) => sameUrl(r.url) === sameUrl(cite.url)).map((r) => r.text);
    if (!texts.length) continue;
    const text = [...new Set(texts)].join('\n\n').slice(0, 24_000);
    if ((await noul(judge, 'score/cite', CITE_QUESTION, { claim: claimOf(cite, answer, codes), quote: cite.quote, locator: cite.locator, url: cite.url, text })) >= 0.5) supported += 1;
  }
  return { evidenceSupported: supported / cites.length };
}

const PDF_PAGE = /\bpdf p\.\s*\d+/i;

/**
 * The v4 score of one run. `company` is the truth row (companies-v4.json: sic, segments, hq, latestAnnual, subsidiaries;
 * CLASSIFY-CONTRACT.md v4 "Truth"),
 * `read` what the run read (`textsRead`), `codes` the label set, `judge` a runJudge port. `correct` is every part with
 * truth right: the code always, the segments (F1 0.8 or better) and the headquarters when they have truth; `correctOver`
 * names the parts that counted.
 */
export async function scoreV4({ answer, company, read, codes, judge }) {
  const sic4Answer = answer?.sic4 ?? null;
  const sicCorrect4 = sic4Answer !== null && sic4Answer === company.sic;
  const sicCorrect2 = sic4Answer !== null && sic4Answer.slice(0, 2) === String(company.sic).slice(0, 2);
  const segments = await scoreSegments({ answer, truth: company.segments, judge });
  const hq = await scoreHq({ answer, truth: company.hq, judge });
  const subsidiaries = await scoreSubsidiaries({ answer, truth: company.subsidiaries, judge });
  const report = answer?.annualReport ?? null;
  const truthYear = company.latestAnnual?.fy ?? null;
  // A newer annual report may have been filed after the truth's pinned quarters: then the next fiscal year is right too.
  const years = truthYear === null ? [] : [Number(truthYear), ...(company.latestAnnual.newerPossible ? [Number(truthYear) + 1] : [])];
  const reportYearCorrect = truthYear === null ? null : report !== null && years.includes(Number(report.fiscalYear));
  const reportRead = report !== null && (answer?.cites ?? []).some((c) => sameUrl(c.url) === sameUrl(report.url) && PDF_PAGE.test(c.locator ?? ''));
  const cites = answer ? await scoreCites({ answer, read, codes, judge }) : { evidenceSupported: null };
  return {
    sic4Answer, sic4Truth: company.sic, sicCorrect4, sicCorrect2,
    segmentsAnswer: answer?.segments ?? null,
    segmentsTruth: company.segments?.oneSegment === true ? { oneSegment: true } : Array.isArray(company.segments) && company.segments.length
      ? company.segments.map((s) => ({ label: s.label ?? null, member: s.member ?? null, share: typeof s.share === 'number' ? s.share : null })) : null,
    segmentsShareSum: shareSum(company.segments),
    ...segments,
    hqAnswer: answer?.hq ?? null, hqTruth: company.hq ?? null, ...hq,
    subsidiariesAnswer: answer?.subsidiaries ?? null, subsidiariesTruthCount: Array.isArray(company.subsidiaries?.items) ? company.subsidiaries.count ?? company.subsidiaries.items.length : null, ...subsidiaries,
    reportAnswer: report, reportTruth: company.latestAnnual ?? null, reportYearCorrect, reportRead,
    ...cites,
    correct: sicCorrect4 && (segments.segmentsF1 === null || segments.segmentsF1 >= 0.8) && hq.hqCorrect !== false,
    correctOver: ['sic4', ...(segments.segmentsF1 === null ? [] : ['segments']), ...(hq.hqCorrect === null ? [] : ['hq'])],
  };
}
