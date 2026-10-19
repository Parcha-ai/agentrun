// The committed truth set holds the contract between the lanes: shape, split, spread, and websites a run may fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { siteNamesCompany } from './build-truth.mjs';
import { allowedHost, domainOf, refusedHost } from './tools.mjs';

const read = (name) => JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8'));
const companies = read('companies.json');
const sic2 = read('sic2.json');
const report = read('build-report.json');
const run = companies.filter((c) => c.split === 'run').sort((a, b) => a.order - b.order);
const sealed = companies.filter((c) => c.split === 'sealed');
const count = (list) => list.reduce((m, c) => m.set(c.sic2, (m.get(c.sic2) ?? 0) + 1), new Map());

test('130 companies with the contract fields, 100 run in order 1..100 and 30 sealed', () => {
  assert.equal(companies.length, 130);
  for (const c of companies) {
    assert.deepEqual(Object.keys(c), ['cik', 'name', 'ticker', 'website', 'sic', 'sic2', 'sicDescription', 'split', 'order']);
    assert.match(c.cik, /^\d{10}$/);
    assert.ok(c.name && c.ticker && c.sicDescription, c.cik);
    assert.match(c.sic, /^\d{4}$/);
    assert.equal(c.sic2, c.sic.slice(0, 2));
  }
  assert.equal(new Set(companies.map((c) => c.cik)).size, 130);
  assert.deepEqual(run.map((c) => c.order), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(sealed.length, 30);
  assert.ok(sealed.every((c) => c.order === null));
});

test('spread: no group over 8% of the set, at least 25 groups in the run, run interleaved, sealed groups seen in the run', () => {
  assert.ok(Math.max(...count(companies).values()) <= Math.ceil(0.08 * 130));
  assert.ok(count(run).size >= 25);
  for (let i = 1; i < run.length; i++) assert.notEqual(run[i].sic2, run[i - 1].sic2, `orders ${i} and ${i + 1}`);
  for (const c of sealed) assert.ok(count(run).has(c.sic2), c.cik);
});

test('sic2.json names exactly the groups used', () => {
  assert.deepEqual(Object.keys(sic2).sort(), [...count(companies).keys()].sort());
  for (const name of Object.values(sic2)) assert.ok(name.length > 3);
});

test('every website is one fetch_page allows, on a domain no other company uses, that names its company', () => {
  const domains = companies.map((c) => domainOf(c.website));
  assert.equal(new Set(domains).size, 130);
  for (const c of companies) {
    const host = new URL(c.website).hostname;
    assert.match(c.website, /^https?:\/\//);
    assert.equal(refusedHost(host), null, c.website);
    assert.ok(allowedHost(host, domainOf(c.website)), c.website);
    assert.ok(siteNamesCompany(c.website, c), c.website);
  }
});

test('every company passed the build-time website check', () => {
  const checks = new Map(report.checks.map((r) => [r.cik, r]));
  for (const c of companies) {
    const r = checks.get(c.cik);
    assert.ok(r, c.cik);
    assert.equal(r.website, c.website);
    assert.equal(r.usable, true, `${c.cik} ${r.why}`);
    assert.ok(r.status >= 200 && r.status < 300 && r.textChars >= report.rules.minText, c.cik);
    assert.equal(r.selected, true);
  }
  assert.equal(report.checks.filter((r) => r.selected).length, 130);
});

test('the report names where each input came from and when it was read', () => {
  const { via, secFiles, wikidata } = report.builtWith;
  assert.deepEqual(Object.keys(secFiles).sort(), ['fsds', 'sicList', 'tickers']);
  for (const file of Object.values(secFiles)) {
    assert.match(file.url, /^https:\/\/www\.sec\.gov\//);
    assert.ok(!Number.isNaN(Date.parse(file.retrievedAt)));
    if (via === 'wayback') {
      const ts = file.snapshot.replace(/\D/g, '');
      assert.equal(file.fetchedFrom, `https://web.archive.org/web/${ts}id_/${file.url}`);
    } else assert.equal(file.fetchedFrom, file.url);
  }
  assert.match(wikidata.query, /wdt:P5531/);
  assert.ok(!Number.isNaN(Date.parse(wikidata.retrievedAt)));
});

test('a website names its filer by name, distinctive word, initials or ticker', () => {
  const names = (website, name, ticker) => siteNamesCompany(website, { name, ticker });
  assert.equal(names('http://www.twilio.com/', 'TWILIO INC', 'TWLO'), true);
  assert.equal(names('https://www.bankofamerica.com/', 'BANK OF AMERICA CORP /DE/', 'BAC'), true);
  assert.equal(names('https://www.ti.com/', 'TEXAS INSTRUMENTS INC', 'TXN'), true);
  assert.equal(names('https://www.aig.com/', 'AMERICAN INTERNATIONAL GROUP, INC.', 'AIG'), true);
  assert.equal(names('https://f-e-t.com/', 'FORUM ENERGY TECHNOLOGIES, INC.', 'FET'), true);
  // A product's site filed under its parent, a former name's site, a site named only by an industry word.
  assert.equal(names('http://www.authy.com', 'TWILIO INC', 'TWLO'), false);
  assert.equal(names('http://www.aointl.com/', 'PYXUS INTERNATIONAL, INC.', 'PYYX'), false);
  assert.equal(names('https://www.upcinsurance.com/', 'AMERICAN COASTAL INSURANCE Corp', 'ACIC'), false);
});
