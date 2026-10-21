// Runs-to-discovery's facts, read structurally from a run's recording lines with the tools' own archivedSecPage.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupOfLines, pageKind, revisionCarriesLookup } from './eval-lookup.mjs';

const W = (inner) => `https://web.archive.org/web/20260224213732id_/${inner}`;
const INDEX = W('https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm');
const HEADERS = W('https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index-headers.html');

const call = (conv, id, name, args) => ({ kind: 'pi.assistant', conv, data: { model: [{ content: [{ type: 'toolCall', id, name, arguments: args }] }] } });
const result = (conv, id, toolName, value, isError = false) => ({ kind: 'pi.tool-result', conv, data: { model: [{ toolName, toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify(value) }] }] } });
const nodes = (conversation) => ({ kind: 'agentrun.nodes', data: { key: `k:${conversation}`, value: { conversation } } });
const effect = (key, tool, args, value, status = 'completed') => ({ kind: 'agentrun.effects', data: { key, value: { intent: { tool }, args, status, result: { value } } } });

test('the kind of SEC page a Wayback copy holds', () => {
  assert.equal(pageKind(INDEX), 'index');
  assert.equal(pageKind(HEADERS), 'headers');
  assert.equal(pageKind(W('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000000001')), 'company');
  assert.equal(pageKind(W('https://data.sec.gov/submissions/CIK0000000001.json')), 'submissions');
  assert.equal(pageKind(W('https://www.sec.gov/Archives/edgar/data/1/x.htm')), 'other');
});

test('a run that read the SEC page, by the root agent and by a workflow node, and answered with its code and cite', () => {
  const lines = [
    nodes(12),
    call(1, 'a', 'fetch_page', { url: INDEX }), result(1, 'a', 'fetch_page', { ok: true, url: INDEX, text: 'ACME CORP SIC: 7372 Business Address' }),
    call(12, 'b', 'read_document', { url: HEADERS }), result(12, 'b', 'read_document', { ok: true, url: HEADERS, text: 'STANDARD INDUSTRIAL CLASSIFICATION: [7372]' }),
    effect('e1', 'fetch_page', { url: 'https://acme.example/' }, { ok: true, url: 'https://acme.example/', text: 'about 7372 things' }),
    call(1, 'z', 'answer', { sic4: '7372', cites: [{ claim: 'sic', url: INDEX }] }),
  ];
  assert.deepEqual(lookupOfLines(lines, { sic4: '7372' }), { touched: true, used: true, citeUse: true, byWorkflow: true, byRoot: true, kinds: ['headers', 'index'] });
});

test('a failed read, a code only in the address, an off-archive read and a call node all read as they are', () => {
  const failed = [call(1, 'a', 'fetch_page', { url: INDEX }), result(1, 'a', 'fetch_page', { ok: false, url: INDEX, status: 429 })];
  assert.deepEqual(lookupOfLines(failed, { sic4: '7372' }), { touched: false, used: false, citeUse: null, byWorkflow: false, byRoot: false, kinds: [] });
  const company = W('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&SIC=7372');
  const inAddress = [call(1, 'a', 'browse', { url: company }), result(1, 'a', 'browse', { ok: true, url: company, text: 'ACME CORP' })];
  assert.equal(lookupOfLines(inAddress, { sic4: '7372' }).used, false);
  assert.equal(lookupOfLines(inAddress, { sic4: '7372' }).touched, true);
  const byCallNode = [effect('e1', 'fetch_page', { url: INDEX }, { ok: true, url: INDEX, text: 'SIC: 5961' })];
  assert.deepEqual(lookupOfLines(byCallNode, { sic4: '5961' }), { touched: true, used: true, citeUse: null, byWorkflow: true, byRoot: false, kinds: ['index'] });
  assert.equal(lookupOfLines(byCallNode, { sic4: '596' }).used, false);
});

test('a revision carries the lookup when a call node reads a Wayback copy of an SEC page, its placeholders standing in', () => {
  const chain = (...steps) => ({ v: 2, name: 'w', root: { node: 'chain', steps } });
  assert.equal(revisionCarriesLookup(chain({ node: 'call', tool: 'fetch_page', args: { url: W('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}') } })), true);
  assert.equal(revisionCarriesLookup(chain({ node: 'call', tool: 'fetch_page', args: { url: 'https://{site}/about' } })), false);
  assert.equal(revisionCarriesLookup(chain({ node: 'agent', instructions: `read ${INDEX}` })), false);
  assert.equal(revisionCarriesLookup(chain({ node: 'route', branches: { a: { body: { node: 'call', tool: 'read_document', args: { url: HEADERS } } } } })), true);
});
