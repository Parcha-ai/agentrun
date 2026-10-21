// The SEC's own SIC vocabulary in the v4 code tools: which codes the SEC files companies under, and its largest filers
// under each, built from the pinned data sets with the study's companies left out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sicVocabulary } from './build-sic-filers.mjs';
import { sic2GroupsTool, sicCodesTool } from './host.mjs';
import { SETS } from './sets.mjs';

const DATA = join(import.meta.dirname, 'data');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const codes = { 1311: 'CRUDE PETROLEUM & NATURAL GAS', 2911: 'PETROLEUM REFINING', 5810: 'RETAIL-EATING & DRINKING PLACES', 5812: 'RETAIL-EATING PLACES', 6798: 'REAL ESTATE INVESTMENT TRUSTS' };
const labels = { 13: 'Oil And Gas Extraction', 29: 'Petroleum Refining And Related Industries', 58: 'Eating And Drinking Places', 67: 'Holding And Other Investment Offices', 99: 'Nonclassifiable Establishments' };

test('the vocabulary counts each filer once, at its latest code, leaves out the study\'s companies, and names the largest filers first', () => {
  const sub = [
    { cik: '11', sic: '5810' }, { cik: '11', sic: '5812' }, // a filer that moved: counted once, at its latest code
    { cik: '12', sic: '5812' }, { cik: '13', sic: '5812' }, { cik: '14', sic: '6798' }, { cik: '15', sic: '1311' },
    { cik: '16', sic: '0' }, { cik: '17', sic: '' }, { cik: '18', sic: '9995' }, // no code, and a code the SEC list lacks
    { cik: '99', sic: '2911' }, // a study company: its code is neither counted nor named
  ];
  const tickers = [{ cik_str: 12, title: 'BIG EATS' }, { cik_str: 99, title: 'STUDY CO' }, { cik_str: 14, title: 'TOWER REIT' }, { cik_str: 11, title: 'DINER INC' }, { cik_str: 13, title: 'SMALL EATS' }, { cik_str: 15, title: 'WELL OIL' }];
  const v = sicVocabulary({ sub, tickers, codes, exclude: ['0000000099'], perCode: 2, perGroup: 3 });
  assert.deepEqual(v.codes, {
    1311: { filers: 1, examples: ['WELL OIL'] },
    5812: { filers: 3, examples: ['BIG EATS', 'DINER INC'] },
    6798: { filers: 1, examples: ['TOWER REIT'] },
  });
  assert.deepEqual(v.groups, { 13: { examples: ['WELL OIL'] }, 58: { examples: ['BIG EATS', 'DINER INC', 'SMALL EATS'] }, 67: { examples: ['TOWER REIT'] } });
  assert.equal(JSON.stringify(v).includes('STUDY CO'), false);
});

const vocabulary = {
  codes: { 1311: { filers: 40, examples: ['WELL OIL'] }, 5812: { filers: 50, examples: ['BIG EATS', 'DINER INC'] }, 6798: { filers: 266, examples: [] } },
  groups: { 13: { examples: ['WELL OIL'] }, 58: { examples: ['BIG EATS', 'DINER INC'] }, 67: { examples: [] } },
};

test('with the vocabulary, sic_codes offers only the codes the SEC files companies under, each under its SEC title and its largest filers', async () => {
  const tool = sicCodesTool(codes, vocabulary);
  assert.deepEqual((await tool.run({ group: '58' })).codes, [{ code: '5812', name: 'RETAIL-EATING PLACES (SEC filers here include BIG EATS; DINER INC)' }]);
  assert.deepEqual((await tool.run({})).codes.map((c) => c.code), ['1311', '5812', '6798']);
  assert.deepEqual((await tool.run({ group: '67' })).codes, [{ code: '6798', name: 'REAL ESTATE INVESTMENT TRUSTS' }], 'no named filers: the title alone');
  assert.deepEqual((await tool.run({ group: '29' })).codes, [], 'a code no filer has is not offered');
  // The shape a saved workflow's call node reads is unchanged: code and name.
  assert.deepEqual(tool.resultSchema.properties.codes.items.required, ['code', 'name']);
  // Without a vocabulary the tool is what v2 had: every code under its title.
  assert.deepEqual((await sicCodesTool(codes).run({ group: '58' })).codes.map((c) => c.code), ['5810', '5812']);
});

test('with the vocabulary, sic2_groups offers only the groups the SEC files companies under, each with its largest filers', async () => {
  const { groups } = await sic2GroupsTool(labels, vocabulary).run({});
  assert.deepEqual(groups, [
    { code: '13', name: 'Oil And Gas Extraction (SEC filers here include WELL OIL)' },
    { code: '58', name: 'Eating And Drinking Places (SEC filers here include BIG EATS; DINER INC)' },
    { code: '67', name: 'Holding And Other Investment Offices' },
  ]);
  assert.equal((await sic2GroupsTool(labels).run({})).groups.length, 5);
});

test('the v4 set offers the built vocabulary: every code it offers is the SEC\'s, it names none of the study\'s companies, and every group has a code', async () => {
  const d = SETS.v4.load(DATA);
  const built = readJson(join(DATA, 'sic-filers.json'));
  assert.deepEqual(d.vocabulary, built);
  const secCodes = readJson(join(DATA, 'sic-codes.json'));
  for (const code of Object.keys(built.codes)) assert.ok(secCodes[code], `${code} is in the SEC's list`);
  const fold = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const study = new Set([...readJson(join(DATA, 'companies-v4.json')), ...readJson(join(DATA, 'companies.json'))].map((c) => fold(c.name)));
  const named = [...Object.values(built.codes), ...Object.values(built.groups)].flatMap((e) => e.examples);
  assert.ok(named.length > 300);
  assert.deepEqual(named.filter((n) => study.has(fold(n))), [], 'no study company is named');
  const [groupsTool, codesTool] = SETS.v4.labelTools(d);
  const { groups } = await groupsTool.run({});
  for (const g of groups) assert.ok((await codesTool.run({ group: g.code })).codes.length > 0, `group ${g.code} has an offered code`);
  // v2 keeps its tools as they were.
  assert.equal((await SETS.v2.labelTools(SETS.v2.load(DATA))[1].run({})).codes.length, Object.keys(secCodes).length);
});
