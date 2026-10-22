// The MCC job (the MCC cell's plan): one merchant per run, its 4-digit Merchant Category Code (ISO 18245), its risk tier
// and flags, each claim cited with a URL and a verbatim quote. There is no registry that states a merchant's MCC, so a
// run's receipt is structural grounding: the answer's MCC quote is on a page of the merchant's own site, and the answer
// cites that page. The labels a run is scored against are the swarm agent's (the teacher's), never truth.
// The answer's fields are learn-mcc's (examples/learn-mcc/SPEC.md and answer.mjs).
import { answerMcc, answerProblems, JOB_INPUT } from '../learn-mcc/answer.mjs';
import { readerResults } from './eval-lookup.mjs';
import { sameUrl } from './score-v2.mjs';

/** A quote shorter than this many words grounds nothing: a word or two is on every shop's pages. */
export const MIN_QUOTE_WORDS = 3;

/** Public suffixes with two labels, where the registrable domain keeps three. */
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'net.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr',
  'com.br', 'net.br', 'org.br', 'com.ar', 'com.mx', 'com.co', 'com.pe', 'com.cl', 'com.uy', 'com.ec', 'com.ve',
  'co.in', 'net.in', 'org.in', 'firm.in', 'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.sg', 'com.my', 'com.ph',
  'com.vn', 'co.id', 'co.th', 'com.pk', 'com.bd', 'co.il', 'com.tr', 'com.sa', 'com.eg', 'co.za', 'com.ng', 'co.ke',
  'com.ua', 'com.pl', 'com.gr', 'com.cy', 'com.mt', 'co.at', 'or.at',
]);

/** Hosting platforms that give each shop its own subdomain: the shop's registrable domain is that subdomain. */
const SHOP_HOSTS = new Set([
  'myshopify.com', 'square.site', 'squarespace.com', 'wixsite.com', 'weebly.com', 'wordpress.com', 'blogspot.com',
  'bigcartel.com', 'storenvy.com', 'ecwid.com', 'company.site', 'godaddysites.com', 'mystrikingly.com', 'jimdosite.com',
  'carrd.co', 'webflow.io', 'github.io', 'netlify.app', 'vercel.app', 'pages.dev', 'gumroad.com', 'tictail.com',
]);

/** Marketplaces and platforms where a shop is a path, not a host: only the listing the merchant's website names is its own. */
const SHARED_HOSTS = new Set([
  'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.com.au', 'amazon.co.jp', 'amazon.in',
  'etsy.com', 'ebay.com', 'ebay.co.uk', 'ebay.de', 'walmart.com', 'target.com', 'aliexpress.com', 'alibaba.com', 'temu.com',
  'mercadolibre.com', 'mercadolibre.com.mx', 'mercadolivre.com.br', 'rakuten.com', 'rakuten.co.jp', 'wayfair.com', 'faire.com',
  'depop.com', 'poshmark.com', 'tiktok.com', 'instagram.com', 'facebook.com', 'linktr.ee', 'shopee.com', 'lazada.com', 'flipkart.com',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const hostOf = (url) => new URL(url).hostname.toLowerCase().replace(/\.$/, '');

/** The registrable domain of a host: its last two labels, three under a two-label public suffix, and the shop's own
 *  subdomain under a hosting platform. An IP literal is itself. */
export function registrableDomain(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (IPV4.test(h) || h.includes(':')) return h;
  const labels = h.split('.');
  const keep = TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  const base = labels.slice(-keep).join('.');
  if (SHOP_HOSTS.has(base)) return labels.length > keep ? labels.slice(-keep - 1).join('.') : null;
  return base;
}

/**
 * Where a merchant's own pages are, from the website the data gives it: `{ kind: 'merchant', domain }` for its own site
 * (any host under its registrable domain), or `{ kind: 'marketplace', domain, path }` when the website is a listing on a
 * marketplace (only pages under that listing's path). Null when there is no such place: no website, a bare marketplace
 * or platform home, or an address that does not parse.
 */
export function merchantScope(website) {
  if (typeof website !== 'string' || !website.trim()) return null;
  let url;
  try { url = new URL(/^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const domain = registrableDomain(hostOf(url.href));
  if (!domain) return null;
  if (SHARED_HOSTS.has(domain)) {
    const path = url.pathname.replace(/\/+$/, '');
    return path ? { kind: 'marketplace', domain, path: path.toLowerCase() } : null;
  }
  return { kind: 'merchant', domain };
}

/** True when `href` is a page of the merchant's own, by `scope` (merchantScope). */
export function merchantPage(href, scope) {
  if (!scope || typeof href !== 'string') return false;
  let url;
  try { url = new URL(href); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = hostOf(url.href);
  const within = host === scope.domain || host.endsWith(`.${scope.domain}`);
  if (!within) return false;
  if (scope.kind !== 'marketplace') return true;
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  return path === scope.path || path.startsWith(`${scope.path}/`);
}

const URLS = /\b(?:https?:\/\/|www\.)\S+/gi;
/** Text as a quote is compared (SPEC.md's grounding): URLs taken out and whitespace folded, nothing else. */
export function folded(text) {
  return String(text ?? '').replace(URLS, ' ').replace(/\s+/g, ' ').trim();
}

const WORD = /[\p{L}\p{N}]/u;
const ELLIPSIS = /\.\.\.|\u2026/;
const DELIMITERS = /^["'\u2018\u2019\u201C\u201D\s]+|["'\u2018\u2019\u201C\u201D\s.,;:!?]+$/g;

/** True when `quote` is a whole phrase of `text` word for word (folded), with at least MIN_QUOTE_WORDS words. The quote's
 *  own surrounding quotation marks and closing punctuation are not part of it. A quote that elides (an ellipsis), or that
 *  starts or ends inside a word of the text, is not verbatim. */
export function quoteOnPage(quote, text) {
  if (typeof quote !== 'string' || ELLIPSIS.test(quote)) return false;
  const q = folded(quote).replace(DELIMITERS, '');
  if (q.split(' ').filter((w) => WORD.test(w)).length < MIN_QUOTE_WORDS) return false;
  const t = folded(text);
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) {
    const before = at === 0 ? '' : t[at - 1];
    const after = t[at + q.length] ?? '';
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

const httpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
/** The page a reader result came from: its address after redirects when the tool gives one, else the one asked for. */
const pageUrlOf = ({ args, value }) => [value?.url, value?.source, args?.url].find(httpUrl) ?? null;
const pageOk = (value) => Boolean(value) && value.ok !== false && !value.refused && !value.error && !(Number.isInteger(value.status) && value.status >= 400);
const pageTextOf = (value) => [value?.title, value?.text].filter((t) => typeof t === 'string').join('\n');

/**
 * The run's MCC receipt, or null: an ok reader result (fetch_page, browse or read_document; the root agent's, a workflow
 * agent node's or a call node's) for a page of the merchant's own (merchantScope of `merchant.website`) whose text holds
 * the quote of an `mcc` evidence item of the answer as a whole phrase, word for word, and that item names the same page. `answer` is the
 * run's answer (a host's run of a workflow answers without an answer call). The receipt keeps the page's address, the
 * scope's kind and the code, never the page's text.
 */
export function receiptOfMcc(lines, answer, merchant) {
  const mcc = answer?.mcc;
  const cite = (answer?.evidence ?? []).find((c) => c?.claim === 'mcc');
  if (typeof mcc !== 'string' || !/^\d{4}$/.test(mcc) || !httpUrl(cite?.url) || typeof cite.quote !== 'string') return null;
  const scope = merchantScope(merchant?.website);
  if (!scope) return null;
  const cited = sameUrl(cite.url);
  for (const result of readerResults(lines).results) {
    const { args, value, byWorkflow } = result;
    if (!pageOk(value)) continue;
    const url = pageUrlOf(result);
    if (!url || !merchantPage(url, scope)) continue;
    if (![url, args?.url].some((u) => httpUrl(u) && sameUrl(u) === cited)) continue;
    if (!quoteOnPage(cite.quote, pageTextOf(value))) continue;
    return { url, kind: scope.kind, mcc, byWorkflow };
  }
  return null;
}

/** Whether a workflow's node read an ok page of the merchant's own in this run. */
export function merchantTouchOf(lines, merchant) {
  const scope = merchantScope(merchant?.website);
  if (!scope) return { touched: false, byWorkflow: false };
  const read = readerResults(lines).results.filter((r) => pageOk(r.value) && merchantPage(pageUrlOf(r), scope));
  return { touched: read.length > 0, byWorkflow: read.some((r) => r.byWorkflow) };
}

// ---- the job as the agent sees it ---------------------------------------------------------------------------------------

/** The run's input (learn-mcc's JOB_INPUT): the merchant's name and website, nothing the teacher said. */
export const jobInputMcc = (job) => Object.fromEntries(Object.keys(JOB_INPUT.properties).filter((k) => typeof job[k] === 'string' && job[k]).map((k) => [k, job[k]]));

export const jobTextMcc = (job) => [
  'Classify this merchant as an acquirer would set its card acceptance.',
  `Merchant: ${job.name}`,
  `Website: ${job.website ?? 'not given'}`,
  `A workflow for the whole job takes this input: ${JSON.stringify(jobInputMcc(job))}`,
].join('\n');

/** The MCC table as the answer and mcc_codes take it, code to title, from `{ code: title }` or `[{ code, title|name }]`. */
export function codeTableOf(codes) {
  if (Array.isArray(codes)) return Object.fromEntries(codes.map((c) => [String(c.code), String(c.title ?? c.name ?? '')]));
  return Object.fromEntries(Object.entries(codes ?? {}).map(([code, title]) => [String(code), String(typeof title === 'object' ? title?.title ?? title?.name ?? '' : title)]));
}

/** The ISO 18245 ranges as mcc_groups gives them, `[{ code: 'NNNN-NNNN', name }]`, from `[{ from, to, name|group }]` or
 *  `[{ code: 'NNNN-NNNN', name }]`, in code order. */
export function groupTableOf(groups) {
  return (Array.isArray(groups) ? groups : []).map((g) => ({
    code: g.code ?? `${String(g.from).padStart(4, '0')}-${String(g.to).padStart(4, '0')}`,
    name: String(g.name ?? g.group ?? g.title ?? ''),
  })).sort((a, b) => a.code.localeCompare(b.code));
}

const inRange = (code, range) => {
  const [from, to] = range.split('-');
  return code >= from && code <= to;
};

const LIST = (key) => ({
  type: 'object', additionalProperties: false, required: [key],
  properties: { [key]: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'name'], properties: { code: { type: 'string' }, name: { type: 'string' } } } } },
});

/** mcc_groups (SPEC.md's tools): the ISO 18245 ranges. */
export function mccGroupsTool(groups) {
  const all = groupTableOf(groups);
  return {
    name: 'mcc_groups',
    description: 'The ISO 18245 merchant category ranges, each as "NNNN-NNNN" with its name, in code order.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    resultSchema: LIST('groups'),
    run: async () => ({ groups: all }),
  };
}

/** mcc_codes (SPEC.md's tools): the 4-digit codes under their titles, all of them or one range's (`group`). */
export function mccCodesTool(codes) {
  const all = Object.entries(codeTableOf(codes)).map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code));
  return {
    name: 'mcc_codes',
    description: 'The 4-digit Merchant Category Codes (ISO 18245), code and title: all of them, or only those of one range from mcc_groups (`group`, such as "5900-5999").',
    parameters: { type: 'object', additionalProperties: false, properties: { group: { type: 'string', pattern: '^[0-9]{4}-[0-9]{4}$', description: 'A range from mcc_groups.' } } },
    resultSchema: LIST('codes'),
    run: async ({ group } = {}) => ({ codes: group ? all.filter((c) => inRange(c.code, group)) : all }),
  };
}

/** The answer tool: learn-mcc's answerMcc, refusing an answer answerProblems finds fault with (named, so the agent can
 *  fix it before it records). */
export function answerToolMcc(codes) {
  const table = codeTableOf(codes);
  return { ...answerMcc(table), problems: (args) => answerProblems(args, table) };
}

/** Sites that list merchants' codes, refused by every reader before a request: `domains` from the data (refused-hosts.json).
 *  A host matches when it is the domain or under it. search_web drops results on them. */
export function refusingHosts(effects, domains) {
  const list = (domains ?? []).map((d) => String(d).toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean);
  if (!list.length) return effects;
  const refused = (href) => {
    try {
      const host = new URL(href).hostname.toLowerCase().replace(/\.$/, '');
      return list.some((d) => host === d || host.endsWith(`.${d}`));
    } catch { return false; }
  };
  const note = 'refused: this site lists merchants\' codes';
  return effects.map((effect) => {
    if (effect.name === 'search_web') {
      return {
        ...effect,
        run: async (args, options) => {
          const result = await effect.run(args, options);
          if (!Array.isArray(result?.results)) return result;
          const kept = result.results.filter((r) => !refused(r.url));
          return { ...result, results: kept, filtered: (result.filtered ?? 0) + (result.results.length - kept.length) };
        },
      };
    }
    if (!['fetch_page', 'browse', 'read_document'].includes(effect.name)) return effect;
    return { ...effect, run: async (args, options) => (refused(args?.url) ? { ok: false, url: args.url, refused: note } : effect.run(args, options)) };
  });
}

// ---- scoring parts, hindsight and the row ---------------------------------------------------------------------------

/** A bank run's scored parts for the paired gate (scoreMcc's score), against the teacher: 1 agrees, 0 does not, null
 *  where the merchant has no teacher label for the part. */
export const partsOfMcc = (score) => ({
  mcc: typeof score?.mccCorrect === 'boolean' ? (score.mccCorrect ? 1 : 0) : null,
  risk: typeof score?.riskCorrect === 'boolean' ? (score.riskCorrect ? 1 : 0) : null,
});
export const MCC_GATE_PARTS = Object.freeze(['mcc', 'risk']);

export const MCC_HINDSIGHT_FIELDS = Object.freeze(['mcc', 'risk']);

/** The fields of an MCC score where the run and the teacher disagree, among `fields`, with the answer and the teacher's
 *  label. The label is the teacher's, not truth: `label: 'teacher'` says so wherever it is shown or kept. */
export function wrongFieldsMcc(score, fields = MCC_HINDSIGHT_FIELDS, { codes } = {}) {
  if (!score) return [];
  const title = (code) => codeTableOf(codes)[code];
  const out = [];
  if (score.mccCorrect === false) out.push({ field: 'mcc', answer: score.mccAnswer, truth: score.mccTeacher, truthTitle: title(score.mccTeacher) ?? null, label: 'teacher' });
  if (score.riskCorrect === false) out.push({ field: 'risk', answer: score.riskAnswer, truth: score.riskTeacher, label: 'teacher' });
  return out.filter((w) => fields.includes(w.field));
}

/** The teacher's values a hindsight lesson may not carry: the code (the guard skips short values, so the tier is left). */
export const teacherValuesMcc = (wrong) => wrong.filter((w) => w.field === 'mcc' && w.truth).map((w) => String(w.truth));

/** The reflection's first line for an MCC run. */
export const hindsightJobMcc = (job) => `The job: classify the merchant ${job.name}: its MCC (ISO 18245), risk tier, flags and evidence. The value given below as true is another agent's label (the teacher's), not ground truth.`;

/** Tools that open only the merchant's own pages: any other URL (or a path) is refused before a request. */
export function merchantPagesOnly(effects, merchant) {
  const scope = merchantScope(merchant?.website);
  return effects.map((effect) => ({
    ...effect,
    run: async (args, options) => (merchantPage(args?.url, scope) ? effect.run(args, options) : { ok: false, refused: 'this review opens only the merchant\'s own pages' }),
  }));
}

/** The row of an MCC run: rowOfV2's common parts (built with the answer key `mcc`) without the SEC job's fields, and the
 *  MCC score. `answer`, `truth` and `correct` are the code, the teacher's code and scoreMcc's headline (every part the
 *  teacher labelled agrees); every label is the teacher's (`label`). */
export function rowOfMcc(base, score) {
  const keep = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(sic|segment|hq|subsidiar|report|shareError|correctOver|ticker|evidenceSupported)/.test(key)));
  return {
    ...keep,
    set: 'mcc',
    merchantId: base.cik,
    label: 'teacher',
    answer: score?.mccAnswer ?? null,
    truth: score?.mccTeacher ?? null,
    correct: score?.correct ?? null,
    correctOver: score?.correctOver ?? [],
    mccAnswer: score?.mccAnswer ?? null,
    mccTeacher: score?.mccTeacher ?? null,
    mccCorrect: score?.mccCorrect ?? null,
    mccKnown: score?.mccKnown ?? null,
    mccGroupAnswer: score?.mccGroupAnswer ?? null,
    mccGroupTeacher: score?.mccGroupTeacher ?? null,
    mccGroupCorrect: score?.mccGroupCorrect ?? null,
    riskAnswer: score?.riskAnswer ?? null,
    riskTeacher: score?.riskTeacher ?? null,
    riskCorrect: score?.riskCorrect ?? null,
    riskDistance: score?.riskDistance ?? null,
  };
}
