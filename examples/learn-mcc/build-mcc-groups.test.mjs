// The group table's build on synthetic text in the two documents' layouts: the range headings and their rows (a wrapped
// row's code alone on its line), Visa's listing with wrapped titles and T&E blocks, a repeat settled by a fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTable, rangesOf, visaCodesOf } from './build-mcc-groups.mjs';

const CITI = [
  'Table of Contents',
  '       MCCs 3000–3299 (Airlines)................................................. 15',
  'MCCs 3000–3299 (Airlines)',
  '       MCC           Description                                           Valid Payment Brand(s)',
  '       3000          United Airlines                                      V, M                   UNITED AIR',
  'MCCs 3300–3499 (Car Rental)',
  '       3351          Affiliated Auto Rental                               V, M',
  'MCCs 5700–7299 (Miscellaneous Stores)',
  '                     Direct Marketing–Other Direct Marketers–Not          V, M',
  '      5969',
  '                     Elsewhere Classified',
  '       5961          Mail Order Houses Including Catalog Order Stores     TSYS',
  '       6538          MoneySend Funding                                    M',
  '       9700          Automated Referral Service                           V',
  'MCCs 4000–4799 (Transportation Services)',
  '       4511          Airlines and Air Carriers                            V, M',
].join('\n');

const VISA = [
  'Section 2: Merchant Category Code Listing',
  'AIRLINES AND AIR CARRIERS',
  '3000     UNITED AIRLINES                            UNITED AIR',
  '3301     WIZZ AIR                             WIZZ AIR',
  'CAR RENTAL AGENCIES',
  '3351     AFFILIATED AUTO RENTAL',
  '4511     Airlines and Air Carriers (Not Elsewhere',
  '         Classified)',
  '',
  '         Merchants classified with this MCC are airlines.   Not Applicable',
  '5912     Drug Stores and Pharmacies',
  '5912     Package Stores – Beer, Wine, and Liquor',
  '5969     Direct Marketing – Other Direct Marketers (Not',
  '         Elsewhere Classified)',
  'Section 3: New MCC or MCC Change Requests',
  '9999     Not a listing row',
].join('\n');

test('the range headings in the body, in code order, each with the rows its table lists', () => {
  const groups = rangesOf(CITI);
  assert.deepEqual(groups.map((g) => [g.from, g.to, g.name]), [['3000', '3299', 'Airlines'], ['3300', '3499', 'Car Rental'], ['4000', '4799', 'Transportation Services'], ['5700', '7299', 'Miscellaneous Stores']]);
  assert.deepEqual(groups[0].listed['3000'], { name: 'United Airlines', brands: ['V', 'M'] });
  assert.deepEqual(groups[3].listed['5969'], { name: 'Direct Marketing–Other Direct Marketers–Not Elsewhere Classified', brands: ['V', 'M'] });
  assert.deepEqual(groups[3].listed['5961'].brands, ['TSYS']);
});

test('Visa\'s listing: wrapped titles joined, the T&E block of a merchant-specific code, a repeat kept apart, nothing past Section 3', () => {
  const { codes, repeats } = visaCodesOf(VISA);
  assert.deepEqual(codes['4511'], { name: 'Airlines and Air Carriers (Not Elsewhere Classified)' });
  assert.deepEqual(codes['3301'], { name: 'WIZZ AIR', block: 'airlines' });
  assert.deepEqual(codes['3351'], { name: 'AFFILIATED AUTO RENTAL', block: 'car-rental' });
  assert.equal(codes['5912'].name, 'Drug Stores and Pharmacies');
  assert.deepEqual(repeats, [{ code: '5912', name: 'Package Stores – Beer, Wine, and Liquor' }]);
  assert.equal(codes['9999'], undefined);
});

test('the table: overrides for an airline outside the airline range, the repeat moved by its fix, Mastercard-only codes, retired ones left out', () => {
  const t = buildTable({ citi: CITI, visa: VISA, sources: { retrieved: '2026-10-22', sample: ['3301', '5969'] }, fixes: { 5912: '5921' } });
  assert.deepEqual(t.overrides, { 3301: 'airlines' });
  assert.equal(t.codes['5921'], 'Package Stores – Beer, Wine, and Liquor');
  assert.deepEqual(t.mastercardOnly, { 6538: 'MoneySend Funding' }, '5961 is TSYS alone and 9700 Visa alone: neither is listed now');
  assert.deepEqual(t.teGeneric, { airlines: '4511', 'car-rental': '7512', lodging: '7011' });
  assert.deepEqual(t.checks.sample.map((s) => [s.code, s.group, s.citiTable]), [['3301', 'airlines', null], ['5969', 'miscellaneous-stores', 'Miscellaneous Stores']]);
  assert.equal(t.source.sample, undefined, 'the sample list is a check, not a source');
  assert.throws(() => buildTable({ citi: CITI, visa: VISA, sources: {} }), /lists 5912 twice/);
});
