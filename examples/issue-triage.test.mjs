// The issue-triage workflow keeps the maintainers' labels out of everything its classifier reads: the research agent and both Jev questions. The labels are the
// truth the run is scored against; a run that could read them would score itself.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';

const dir = new URL('./issue-triage/', import.meta.url);
const workflow = JSON.parse(readFileSync(new URL('workflow.json', dir), 'utf8'));
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', dir), 'utf8'));
const MAP = { bug: 'bug', enhancement: 'feature', docs: 'docs', question: 'question', 'awaiting more info': 'needs-info' };
const issues = fixtures.issues.slice(0, 6);

async function run() {
  const seen = { node: [], judge: [] };
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const result = await runWorkflow(workflow, { repo: 'synthetic/repo', numbers: issues.map((issue) => issue.number), label_map: MAP }, {
    runEffect: async ({ node, input }) => {
      const issue = byNumber.get(input.number);
      if (node.tool === 'github_issue') { const { prs, paths, labels, ...record } = issue; return record; }
      if (node.tool === 'github_linked_prs') return { prs: issue.prs };
      if (node.tool === 'github_code') return { paths: issue.paths };
      if (node.tool === 'github_labels') return { labels: issue.labels };
      throw new Error(node.tool);
    },
    runNode: async (params) => { seen.node.push(params); return { summary: 'It asks for something.', reproduces: 'not stated', code_paths: [], evidence: [{ source: 'issue', quote: 'x' }] }; },
    runJudge: async (params) => {
      seen.judge.push(params);
      return { answers: Object.fromEntries(Object.entries(params.questions).map(([id, question]) => [id, question.type === 'choice'
        ? { type: 'choice', choice: Object.keys(question.criteria)[0], probabilities: Object.fromEntries(Object.keys(question.criteria).map((option, index) => [option, index === 0 ? 0.8 : 0.05])), confidence: 0.8 }
        : { type: 'noul', noul: 0.1 }])), usage: null, cost_usd: 0 };
    },
  });
  return { result, seen };
}

test('no maintainer label reaches the research agent or a judge, in its state, instructions or questions', async () => {
  const { result, seen } = await run();
  assert.equal(result.status, 'complete');
  assert.equal(seen.node.length, issues.length);
  assert.equal(seen.judge.length, issues.length * 2);
  const labels = [...new Set(issues.flatMap((issue) => issue.labels))];
  for (const [kind, calls] of Object.entries(seen)) for (const call of calls) {
    const read = JSON.stringify(kind === 'node' ? [call.user, call.system] : [call.state, call.questions]);
    // The questions name the five labels (their options); a maintainer's own label name must appear only as a word of the issue's text, never as a field.
    assert.doesNotMatch(read, /"labels"\s*:/, `${kind}: a labels field was handed over`);
    // The rubric says "a maintainer's design decision"; what must never be handed over is the maintainers' record of this issue.
    assert.doesNotMatch(read, /"maintainer"|maintainer_label|read-maintainer-labels|github_labels/, `${kind}: the maintainers' record was handed over`);
    for (const label of labels.filter((name) => name.includes(' '))) assert.equal(read.includes(label), false, `${kind}: "${label}" was handed over`);
  }
});

test('the row compares the classifier with the maintainers after the fact, and an issue with no label compares with nothing', async () => {
  const { result } = await run();
  const rows = result.output.rows;
  assert.equal(rows.length, issues.length);
  for (const row of rows) {
    const issue = issues.find((candidate) => candidate.number === row.number);
    assert.equal(row.maintainer_label, MAP[issue.labels[0]]);
    assert.equal(row.agrees, row.maintainer_label === row.label);
  }
  assert.equal(result.output.agreement.total, issues.length);
  assert.match(result.output.agreement.summary, /^Jev agreed with the maintainers on \d+ of \d+/);
});
