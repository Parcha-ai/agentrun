// Truth set v2: the segment rule on hand-written num.txt rows, and the committed set's invariants.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATEGORIES, segmentName, segmentTruth } from './build-truth-v2.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8'));
const companies = read('companies-v2.json');
const report = read('build-report-v2.json');
const sicCodes = read('sic-codes.json');
const v1 = new Set(read('companies.json').map((c) => c.cik));
const run = companies.filter((c) => c.split === 'run').sort((a, b) => a.order - b.order);

const fact = (tag, segments, value, extra = {}) => ({ adsh: 'a', tag, version: 'us-gaap/2025', ddate: '20251231', qtrs: '4', uom: 'USD', segments, value: String(value), ...extra });
const annual = { adsh: 'a', form: '10-K', period: '20251231' };

test('the primary segment is the largest business-segment revenue member over the consolidated total', () => {
  const tag = 'RevenueFromContractWithCustomerExcludingAssessedTax';
  const { truth, members } = segmentTruth(annual, [
    fact(tag, '', 1000),
    fact(tag, 'BusinessSegments=NorthAmericaSegment;', 600),
    fact(tag, 'BusinessSegments=InternationalSegment;ConsolidationItems=OperatingSegments;', 250),
    fact(tag, 'BusinessSegments=AmazonWebServicesSegment;', 150),
    fact(tag, 'BusinessSegments=NorthAmericaSegment;ProductOrService=Retail;', 900),
    fact(tag, 'BusinessSegments=IntersegmentEliminations;', -40),
    fact(tag, 'BusinessSegments=CorporateNonSegment;', 5),
    fact(tag, 'BusinessSegments=NorthAmericaSegment;', 550, { ddate: '20241231' }),
    fact(tag, 'BusinessSegments=NorthAmericaSegment;', 160, { qtrs: '1' }),
  ]);
  assert.equal(truth.kind, 'largest');
  assert.equal(truth.name, 'North America');
  assert.equal(truth.member, 'NorthAmericaSegment');
  assert.equal(truth.share, 0.6);
  assert.equal(truth.segments, 3);
  assert.equal(truth.totalFrom, 'tag');
  assert.equal(truth.tag, tag);
  assert.deepEqual(members.map((m) => m.name), ['North America', 'International', 'Amazon Web Services']);
});

test('ifrs-full Segments count, a quarterly report uses its quarter, a missing total falls back to the sum', () => {
  const ifrs = segmentTruth({ adsh: 'a', form: '20-F', period: '20251231' }, [
    fact('Revenue', 'Segments=Foods;', 30, { uom: 'EUR' }), fact('Revenue', 'Segments=HomeCare;', 20, { uom: 'EUR' }),
  ]);
  assert.deepEqual([ifrs.truth.name, ifrs.truth.share, ifrs.truth.totalFrom, ifrs.truth.uom], ['Foods', 0.6, 'sum', 'EUR']);
  const quarter = segmentTruth({ adsh: 'a', form: '10-Q', period: '20251231' }, [
    fact('Revenues', '', 400), fact('Revenues', 'BusinessSegments=Cloud;', 100, { qtrs: '1' }), fact('Revenues', '', 100, { qtrs: '1' }),
  ]);
  assert.deepEqual([quarter.truth.kind, quarter.truth.name, quarter.truth.share, quarter.truth.qtrs], ['single', 'Cloud', 1, 1]);
});

test('a member standing for all reportable segments makes a single-segment company with no segment name', () => {
  const { truth } = segmentTruth(annual, [
    fact('Revenues', '', 100), fact('Revenues', 'BusinessSegments=ReportableSegmentAggregationBeforeOtherOperatingSegment;', 100),
  ]);
  assert.deepEqual([truth.kind, truth.name, truth.share, truth.segments], ['single', null, 1, 1]);
  const named = segmentTruth(annual, [
    fact('Revenues', '', 100), fact('Revenues', 'BusinessSegments=ReportableSegments;', 100), fact('Revenues', 'BusinessSegments=Retail;', 70),
    fact('Revenues', 'BusinessSegments=Wholesale;', 30),
  ]);
  assert.deepEqual([named.truth.kind, named.truth.name, named.truth.segments], ['largest', 'Retail', 2]);
  const custom = segmentTruth(annual, [fact('Revenues', '', 100), fact('Revenues', 'BusinessSegments=ReportableSegmentsRetail;', 90), fact('Revenues', 'BusinessSegments=ReportableSegmentsCredit;', 10)]);
  assert.deepEqual([custom.truth.kind, custom.truth.name], ['largest', 'Retail']);
  const short = segmentTruth(annual, [fact('Revenues', '', 100), fact('Revenues', 'BusinessSegments=ReportableSegmentAggregationBeforeOtherOperatingSegment;', 83)]);
  assert.match(short.why, /only a member for all segments together, covering 0.83/);
});

test('no segment revenue, or a member larger than the total, gives null with the reason', () => {
  assert.equal(segmentTruth(annual, [fact('Revenues', '', 100), fact('Revenues', 'ProductOrService=Widgets;', 60)]).truth, null);
  const over = segmentTruth(annual, [fact('Revenues', '', 100), fact('Revenues', 'BusinessSegments=Widgets;', 160)]);
  assert.equal(over.truth, null);
  assert.match(over.why, /largest member is 160 of 100/);
  const overlap = segmentTruth(annual, [fact('Revenues', '', 100), fact('Revenues', 'BusinessSegments=Utilities;', 80), fact('Revenues', 'BusinessSegments=AlabamaPower;', 40), fact('Revenues', 'BusinessSegments=Gas;', 30)]);
  assert.equal(overlap.truth, null);
  assert.match(overlap.why, /add up to 1.5 of revenue/);
  const partial = segmentTruth(annual, [fact('Revenues', '', 100), fact('Revenues', 'BusinessSegments=Public;', 40), fact('Revenues', 'BusinessSegments=Small;', 20)]);
  assert.match(partial.why, /add up to 0.6 of revenue/);
  assert.match(segmentTruth(annual, [fact('Revenues', '', 100), fact('Revenues', 'BusinessSegments=Cell;', 78)]).why, /one segment member, covering only 0.78/);
});

test('segment names read as words', () => {
  assert.equal(segmentName('AmazonWebServicesSegment'), 'Amazon Web Services');
  assert.equal(segmentName('BerkshireHathawayInsuranceGroup'), 'Berkshire Hathaway Insurance Group');
  assert.equal(segmentName('USOperatingSegmentMember'), 'US');
  assert.equal(segmentName('IPhone'), 'I Phone');
  assert.equal(segmentName('ReportableSegmentsCredit'), 'Credit');
  assert.equal(segmentName('ANReportableSegmentPremiumLuxury'), 'AN Premium Luxury');
});

test('130 companies, 100 run in order 1..100 and 30 sealed, none from v1', () => {
  assert.equal(companies.length, 130);
  for (const c of companies) {
    assert.deepEqual(Object.keys(c), ['cik', 'name', 'ticker', 'website', 'split', 'order', 'categories', 'sic', 'sic2', 'sicDescription', 'segmentTruth']);
    assert.match(c.cik, /^\d{10}$/);
    assert.ok(c.name && c.ticker, c.cik);
    assert.equal(c.sicDescription, sicCodes[c.sic]);
    assert.notEqual(c.sic, '6770');
    assert.ok(!v1.has(c.cik), c.cik);
  }
  assert.equal(new Set(companies.map((c) => c.cik)).size, 130);
  assert.deepEqual(run.map((c) => c.order), Array.from({ length: 100 }, (_, i) => i + 1));
  for (let i = 1; i < run.length; i++) assert.notEqual(run[i].sic2, run[i - 1].sic2, `orders ${i} and ${i + 1}`);
  assert.equal(companies.filter((c) => c.split === 'sealed' && c.order === null).length, 30);
});

test('every company is in a hard category, and every category holds at least a fifth of the set', () => {
  for (const c of companies) {
    assert.ok(c.categories.length > 0, c.cik);
    assert.deepEqual(c.categories, CATEGORIES.filter((k) => c.categories.includes(k)));
  }
  for (const k of CATEGORIES) assert.ok(companies.filter((c) => c.categories.includes(k)).length >= 26, k);
});

test('a category is backed by the facts in the report', () => {
  const facts = new Map(report.companies.map((r) => [r.cik, r]));
  for (const c of companies) {
    const r = facts.get(c.cik);
    assert.ok(r, c.cik);
    if (c.categories.includes('multi-segment')) assert.ok(c.segmentTruth.segments >= 3, c.cik);
    if (c.categories.includes('foreign')) assert.ok(/^(20|40)-F/.test(r.facts.form) && r.facts.countryba !== 'US', c.cik);
    if (c.categories.includes('renamed')) assert.ok(r.facts.former && r.facts.changed >= report.rules.renamedSince, c.cik);
    if (c.categories.includes('small-cap')) assert.ok(r.facts.revenueUsdAnnual > 0 && r.facts.revenueUsdAnnual < report.rules.smallCapBelowUsd, c.cik);
    if (c.categories.includes('bot-wall')) assert.ok(r.check && r.website, c.cik);
    if (c.segmentTruth) {
      assert.ok(c.segmentTruth.share > 0 && c.segmentTruth.share <= 1, c.cik);
      assert.ok(['largest', 'single'].includes(c.segmentTruth.kind), c.cik);
      assert.ok((c.segmentTruth.name || c.segmentTruth.kind === 'single') && c.segmentTruth.adsh && c.segmentTruth.tag, c.cik);
      if (c.segmentTruth.kind === 'largest') assert.ok(c.segmentTruth.segments >= 2 && r.segmentSumShare >= 0.85 && r.segmentSumShare <= 1.2, c.cik);
    } else assert.ok(r.segmentTruthNull, c.cik);
  }
});

test('about half the companies show a website; the rest leave it to search', () => {
  const shown = companies.filter((c) => c.website).length;
  assert.ok(shown >= 60 && shown <= 65, `${shown} shown`);
  for (const c of companies.filter((x) => x.website)) assert.match(c.website, /^https?:\/\//);
});

test('sic-codes.json is the SEC list of 4-digit codes', () => {
  assert.ok(Object.keys(sicCodes).length > 400);
  for (const code of Object.keys(sicCodes)) assert.match(code, /^\d{4}$/);
});
