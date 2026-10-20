// Truth set v4: the exhibit reader on hand-written exhibits, and the committed set's invariants against v2.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coverAddress, readSubsidiaries } from './build-truth-v4.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8'));
const v2 = read('companies-v2.json');
const v4 = read('companies-v4.json');
const report = read('build-report-v4.json');

test('a table exhibit: header rows, percent columns and section headings are not subsidiaries', () => {
  const html = `<table><tr><td>Legal Name</td><td>State or Other Jurisdiction of Incorporation</td><td>Percent Owned</td></tr>
    <tr><td>Companies consolidated line by line</td></tr>
    <tr><td>Acme&nbsp;Holdings, LLC</td><td>100%</td><td>Delaware</td></tr>
    <tr><td><p>Acme Widgets Ltd.</p></td><td>United Kingdom</td><td>(51%)</td></tr>
    <tr><td>Acme GmbH</td><td>Germany</td></tr></table>`;
  assert.deepEqual(readSubsidiaries(html), [
    { name: 'Acme Holdings, LLC', jurisdiction: 'Delaware' },
    { name: 'Acme Widgets Ltd.', jurisdiction: 'United Kingdom' },
    { name: 'Acme GmbH', jurisdiction: 'Germany' },
  ]);
});

test('a list exhibit: a trailing (Jurisdiction) is read, a former name is not', () => {
  const html = '<p>Exhibit 21.1</p><p>Subsidiaries of the Registrant</p><p>Acme Holdings, LLC (Delaware)</p><p>Acme Foods Inc. (formerly Acme Snacks Inc.)</p><div>Acme Canada ULC</div>';
  assert.deepEqual(readSubsidiaries(html), [
    { name: 'Acme Holdings, LLC', jurisdiction: 'Delaware' },
    { name: 'Acme Foods Inc. (formerly Acme Snacks Inc.)' },
    { name: 'Acme Canada ULC' },
  ]);
});

test('the layouts real exhibits use: a header over two rows, numbered rows, two entries a row, places alone, brackets', () => {
  const table = `<table><tr><td></td><td>State of</td><td>Percent Owned</td></tr><tr><td></td><td>Incorporation</td><td>By Registrant</td></tr>
    <tr><td>1.</td><td>Acme Foods, LLC</td><td>Pennsylvania</td><td>100%</td></tr><tr><td>Acme One LLC (Delaware)</td><td>Acme Two Ltd. (Hong Kong)</td></tr></table>`;
  assert.deepEqual(readSubsidiaries(table), [
    { name: 'Acme Foods, LLC', jurisdiction: 'Pennsylvania' },
    { name: 'Acme One LLC', jurisdiction: 'Delaware' },
    { name: 'Acme Two Ltd.', jurisdiction: 'Hong Kong' },
  ]);
  const list = '<div>EX-21.1</div><div>exhibit211.htm</div><div>Domestic Subsidiaries</div><div>CHW LLC</div><div>West Virginia</div><div>Acme West LLC</div>' +
    '<div>Acme Media Brands, LLC Delaware</div><div>Acme Deutschland LLC [Delaware]</div><div>' + 'x'.repeat(250) + '</div>';
  assert.deepEqual(readSubsidiaries(list), [
    { name: 'CHW LLC', jurisdiction: 'West Virginia' },
    { name: 'Acme West LLC' },
    { name: 'Acme Media Brands, LLC', jurisdiction: 'Delaware' },
    { name: 'Acme Deutschland LLC', jurisdiction: 'Delaware' },
  ]);
});

test('the cover address: dei tags, a US state named or coded, a country named, no city no address', () => {
  const ix = (name, text, format = '') => `<ix:nonNumeric contextRef="c-1" name="dei:${name}"${format}><span>${text}</span></ix:nonNumeric>`;
  assert.deepEqual(coverAddress(ix('EntityAddressCityOrTown', 'Cambridge') + ix('EntityAddressStateOrProvince', 'MA')), { city: 'Cambridge', state: 'MA', country: 'US' });
  assert.deepEqual(coverAddress(ix('EntityAddressCityOrTown', 'Austin') + ix('EntityAddressStateOrProvince', 'Texas', ' format="ixt-sec:stateprovnameen"')), { city: 'Austin', state: 'TX', country: 'US' });
  assert.deepEqual(coverAddress(ix('EntityAddressCityOrTown', 'Singapore') + ix('EntityAddressCountry', 'Singapore')), { city: 'Singapore', state: null, country: 'SG', countryTag: 'Singapore' });
  assert.deepEqual(coverAddress(ix('EntityAddressCityOrTown', 'Calgary') + ix('EntityAddressStateOrProvince', 'AB') + ix('EntityAddressCountry', 'CA')), { city: 'Calgary', state: 'AB', country: 'CA', countryTag: 'CA' });
  assert.deepEqual(coverAddress(ix('EntityAddressCityOrTown', 'Calgary') + ix('EntityAddressStateOrProvince', 'Alberta')), { city: 'Calgary', state: 'AB', country: 'CA' });
  assert.deepEqual(coverAddress(ix('EntityAddressCityOrTown', 'Luxembourg') + ix('EntityAddressCountry', 'Grand Duchy of Luxembourg')), { city: 'Luxembourg', state: null, country: 'LU', countryTag: 'Grand Duchy of Luxembourg' });
  assert.equal(coverAddress(ix('EntityAddressStateOrProvince', 'MA')), null);
});

test('v4 keeps v2\'s 130 companies, split and order', () => {
  assert.deepEqual(v4.map((c) => [c.cik, c.split, c.order, c.sic]), v2.map((c) => [c.cik, c.split, c.order, c.sic]));
});

test('every field has the v4 shape, and the coverage the report states is the set\'s', () => {
  for (const c of v4) {
    if (c.latestAnnual) {
      assert.match(c.latestAnnual.form, /^(10-K|10-KT|20-F|40-F)$/, c.cik);
      assert.ok(Number.isInteger(c.latestAnnual.fy) && /^\d{4}-\d{2}-\d{2}$/.test(c.latestAnnual.period) && /^\d{10}-\d{2}-\d{6}$/.test(c.latestAnnual.adsh), c.cik);
    }
    if (c.hq) {
      assert.deepEqual(Object.keys(c.hq), ['city', 'state', 'country'], c.cik);
      for (const k of ['city', 'state', 'country']) assert.ok(c.hq[k] === null || typeof c.hq[k] === 'string', c.cik);
      assert.ok(c.hq.city || c.hq.country, c.cik);
    } else assert.equal(c.hq, null, c.cik);
    if (Array.isArray(c.segments)) {
      assert.ok(c.segments.length >= 2, c.cik);
      // A reportable segment with no revenue yet is still one of the filer's segments.
      for (const s of c.segments) assert.ok(s.member && s.label && s.revenue >= 0 && s.share >= 0 && s.share <= 1, c.cik);
      assert.ok(c.segments.some((s) => s.share > 0), c.cik);
      const sum = c.segments.reduce((n, s) => n + s.share, 0);
      assert.ok(sum >= 0.85 && sum <= 1.2001, `${c.cik} sums to ${sum}`);
    } else if (c.segments) assert.deepEqual(c.segments, { oneSegment: true }, c.cik);
    else assert.equal(c.segments, null, c.cik);
    if (c.subsidiaries) {
      assert.ok(c.subsidiaries.count === c.subsidiaries.items.length && c.subsidiaries.count > 0, c.cik);
      assert.match(c.subsidiaries.exhibit, /^EX-(21|8)(\.\d+)?$/, c.cik);
      assert.match(c.subsidiaries.url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//, c.cik);
      for (const s of c.subsidiaries.items) assert.ok(s.name.length >= 3, c.cik);
    }
  }
  const { coverage } = report;
  assert.equal(coverage.total, 130);
  assert.equal(coverage.latestAnnual.truth, v4.filter((c) => c.latestAnnual).length);
  assert.equal(coverage.subsidiaries.truth, v4.filter((c) => c.subsidiaries).length);
  assert.equal(coverage.segments.truth + coverage.segments.oneSegment + coverage.segments.null, 130);
  for (const k of ['latestAnnual', 'hqCity', 'hqState', 'hqCountry', 'subsidiaries']) assert.equal(coverage[k].truth + coverage[k].null, 130, k);
  // Every head office names its source; a cover one is the report's cover address.
  for (const r of report.companies) {
    const c = v4.find((x) => x.cik === r.cik);
    if (!c.hq) continue;
    assert.ok(['cover', 'sub.txt'].includes(r.hq.source), r.cik);
    if (r.hq.source === 'cover') assert.deepEqual(c.hq, r.hq.cover, r.cik);
    else assert.ok(r.hq.why, r.cik);
  }
  assert.equal(coverage.hqSource.cover + coverage.hqSource['sub.txt'], v4.filter((c) => c.hq).length);
  // A null segment truth always has its reason; oneSegment only from a one-segment report.
  for (const c of v4) if (!c.segments && c.latestAnnual) assert.ok(report.companies.find((r) => r.cik === c.cik).segments, c.cik);
  for (const c of report.companies) if (!v4.find((x) => x.cik === c.cik).subsidiaries) assert.ok(c.subsidiaries?.why || c.latestAnnual, c.cik);
});
