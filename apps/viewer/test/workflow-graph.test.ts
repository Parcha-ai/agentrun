// The workflow graph panel: the DSL's graph of the job's workflow (`workflowGraph`) and the DSL's status of each node
// (`nodeStatus`) over the driver's record the recording holds at the stop, drawn as they are; drawn only for a recording
// whose manifest names a job. The DSL's graph fixtures (packages/dsl/test/fixtures/graph: a sequence, a parallel, a route,
// a nested map with a child workflow, a map in each layout, each finished and cut) are fed in as recording lines, and
// every node drawn must show what each run did, as the DSL's own fixture test writes it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json, Line, Manifest } from '../src/format.ts';
import { workflowGraphPanel } from '../src/workflow-graph.ts';
import { panelsFor, type Node } from '../src/panels.ts';
import { reduceTo } from '../src/replay.ts';

const DIR = new URL('../../../packages/dsl/test/fixtures/graph/', import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) as Json;
const SHAPES = ['sequence', 'parallel', 'route', 'nested', 'map-v3', 'map-v4'];
// What each run did, as the DSL's fixture test writes it (packages/dsl/test/graph-fixtures.test.mjs): every node done,
// but these.
const FINISHED: Record<string, Record<string, string>> = { route: { '/root/steps/1/branches/other/body': 'not-run' } };
// Inside a map nothing is done before the map is: a node there stands for every item, and a cut run's map has not finished.
const INSIDE_MAP = (extra: Record<string, string> = {}) => ({ '/root': 'working', '/root/steps/0': 'working', '/root/steps/0/body': 'working', '/root/steps/0/body/steps/0': 'working', '/root/steps/0/body/steps/1': 'working', '/root/steps/1': 'not-run', ...extra });
const CUT: Record<string, Record<string, string>> = {
  sequence: { '/root': 'working', '/root/steps/2': 'not-run' },
  parallel: { '/root': 'working', '/root/steps/1': 'not-run' },
  route: { '/root': 'working', '/root/steps/1/branches/other/body': 'not-run', '/root/steps/2': 'not-run' },
  nested: INSIDE_MAP({ '/root/steps/0/body/steps/0/workflow/root': 'working', '/root/steps/0/body/steps/0/workflow/root/steps/0': 'working', '/root/steps/0/body/steps/0/workflow/root/steps/1': 'working' }),
  'map-v3': INSIDE_MAP(),
  'map-v4': INSIDE_MAP(),
};
const JOB = 'f'.repeat(64);

let clock = 0;
const driver = (commit: number, pin: Json, snapshot = false): Line => ({ channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: (clock += 10), commit, order: 0,
  data: { doc: 'agentrun.driver', value: { generation: 1, revision: commit, notes: [], state: { schema: 'agentrun.frozen_run.v4', pin } } }, ...(snapshot ? { snapshot } : {}) });
const item = (commit: number, order: number, record: Record<string, Json>, snapshot = false): Line => ({ channel: 'durable', source: 'workflow', kind: 'agentrun.items', gen: 1, t: (clock += 10), commit, order,
  data: { doc: 'agentrun.items', key: `run\u0000${String(record.map)}/items/${String(record.index)}`, value: record }, ...(snapshot ? { snapshot } : {}) });
const linesOf = (shape: string, variant: string): Line[] => [driver(1, read(`${shape}.${variant}.frame.json`)), ...(read(`${shape}.${variant}.items.json`) as Record<string, Json>[]).map((record, at) => item(2, at + 1, record))];

type Row = { path: string; status: string; cls: string };
const text = (node: Node): string => (typeof node === 'string' ? node : 'children' in node && node.children ? node.children.map(text).join(' ') : '');
const rows = (node: Node): Row[] => {
  if (typeof node === 'string' || !('children' in node)) return [];
  const status = node.tag === 'li' ? (node.children ?? []).find((child) => typeof child !== 'string' && 'class' in child && child.class === 'wg-status') : undefined;
  const own = node.tag === 'li' && typeof node.title === 'string' ? [{ path: node.title, status: status ? text(status) : '', cls: node.class ?? '' }] : [];
  return [...own, ...(node.children ?? []).flatMap(rows)];
};
const viewed = (lines: Line[], workflow: Json, context: { focus?: string } = {}) =>
  workflowGraphPanel.view(reduceTo(workflowGraphPanel, lines, lines.length), { t: 0, json: (sha) => (sha === JOB ? { workflow, input: {}, files: [] } : undefined), job: JOB, ...context });
const WORDS: Record<string, string> = { done: 'done', working: 'working', failed: 'failed', 'not-run': 'not run' };

for (const shape of SHAPES) {
  for (const variant of ['finished', 'cut']) {
    test(`${shape}, ${variant}: every node drawn shows what the run did there`, () => {
      const drawn = rows(viewed(linesOf(shape, variant), read(`${shape}.workflow.json`)));
      assert.ok(drawn.length > 0);
      const except = (variant === 'finished' ? FINISHED : CUT)[shape] ?? {};
      for (const row of drawn) {
        const want = except[row.path] ?? 'done';
        assert.equal(row.status, WORDS[want], `${row.path}`);
        assert.match(row.cls, new RegExp(`(^| )${want}( |$)`), `${row.path}'s class`);
      }
    });
  }
}

test('drawn only for a recording whose manifest names a job; every node of the graph is drawn, each once', () => {
  const lines = linesOf('nested', 'finished');
  const manifest = { format: 'agentrun.recording/1' } as unknown as Manifest;
  assert.equal(panelsFor(lines, [], undefined, manifest).some((each) => each.id === 'workflow-graph'), false, 'no job: not drawn');
  assert.equal(panelsFor(lines).some((each) => each.id === 'workflow-graph'), false, 'no manifest given: not drawn');
  assert.equal(panelsFor(lines, [], undefined, { ...manifest, job: { blob: JOB, sha256: JOB } }).some((each) => each.id === 'workflow-graph'), true, 'a job: drawn');
  const paths = rows(viewed(lines, read('nested.workflow.json'))).map((row) => row.path);
  assert.equal(new Set(paths).size, paths.length, 'each node once');
  assert.ok(paths.includes('/root/steps/0/body/steps/0/workflow/root/steps/1'), 'into the child workflow');
});

test('before the first checkpoint nothing has run; a later open\'s snapshot starts the record over; a scrub equals a fresh reduce', () => {
  const workflow = read('sequence.workflow.json');
  assert.ok(rows(viewed([], workflow)).every((row) => row.status === 'not run'));
  const finished = read('sequence.finished.frame.json');
  const cut = read('sequence.cut.frame.json');
  // The run finished, then a restore took its store back to the cut point: the next process's snapshot says so.
  const lines = [driver(1, cut, true), driver(5, finished), driver(2, cut, true)];
  assert.equal(rows(viewed(lines.slice(0, 2), workflow)).find((row) => row.path === '/root')?.status, 'done');
  assert.equal(rows(viewed(lines, workflow)).find((row) => row.path === '/root')?.status, 'working');
  let state = workflowGraphPanel.init();
  for (let p = 0; p <= lines.length; p += 1) {
    assert.deepEqual(state, reduceTo(workflowGraphPanel, lines, p), `at ${p}`);
    if (p < lines.length && workflowGraphPanel.accepts(lines[p]!)) state = workflowGraphPanel.reduce(state, lines[p]!);
  }
});

test('until the job is read, or when it holds no workflow, the panel says so; a focus dims the nodes outside it', () => {
  const lines = linesOf('map-v3', 'finished');
  const state = reduceTo(workflowGraphPanel, lines, lines.length);
  assert.match(text(workflowGraphPanel.view(state, { t: 0, json: () => undefined, job: JOB })), /The job that ran is not read yet/);
  assert.match(text(workflowGraphPanel.view(state, { t: 0, json: () => ({ input: {} }), job: JOB })), /no workflow this viewer can draw/);
  const focused = rows(viewed(lines, read('map-v3.workflow.json'), { focus: '/root/steps/0/items/1/body' }));
  assert.equal(focused.find((row) => row.path === '/root/steps/0/body')!.cls.endsWith(' dim'), false, 'the item\'s body, under the focus');
  assert.equal(focused.find((row) => row.path === '/root/steps/0')!.cls.endsWith(' dim'), false, 'the map the focus is in');
  assert.equal(focused.find((row) => row.path === '/root/steps/1')!.cls.endsWith(' dim'), true, 'a later step');
});

test('the build inlines the DSL\'s graph module from its source, and refuses it once it imports anything', async () => {
  // @ts-expect-error: the build script is plain JavaScript
  const { bundle, checkModule, DSL_GRAPH } = await import('../build.mjs');
  const built = bundle('workflow-graph.ts') as { body: string; modules: string[] };
  assert.ok(built.modules.includes(DSL_GRAPH), built.modules.join(', '));
  assert.doesNotMatch(built.body, /^\s*import\s/m, 'no import is left in the classic script');
  assert.throws(() => checkModule(DSL_GRAPH, "import { x } from 'y';\nexport const a = 1;"), /imports something; the viewer inlines it only while it imports nothing/);
});

test('a row reads as words: its kind, label, way and status apart, in its text and on the page', () => {
  // A row's parts were drawn flush ("chainchainworking"): the text keeps a space between them, and the page's stylesheet
  // sets the parts apart and marks the status by what the run did.
  const own = (node: Node): string => (typeof node === 'string' ? node : 'children' in node && node.children
    ? node.children.filter((child) => typeof child === 'string' || !('class' in child) || !String(child.class).startsWith('wg-into')).map(own).join('') : '');
  const items: Node[] = [];
  const collect = (node: Node) => { if (typeof node === 'string' || !('children' in node)) return; if (node.tag === 'li') items.push(node); (node.children ?? []).forEach(collect); };
  collect(viewed(linesOf('nested', 'finished'), read('nested.workflow.json')));
  assert.ok(items.length > 3);
  for (const item of items) assert.match(own(item), /^\S+ \S.* (done|working|failed|not run)$/, own(item));
  assert.ok(items.some((item) => / via \S+ /.test(own(item))), 'a call names its way between its label and its status');
  const page = readFileSync(new URL('../viewer.css', import.meta.url), 'utf8');
  assert.match(page, /\.wg-node > span \{[^}]*margin-right/, 'the parts are set apart on the page');
  for (const status of ['done', 'working', 'failed', 'not-run']) assert.match(page, new RegExp(`\\.wg-node\\.${status} > \\.wg-status`), `a ${status} row's status is marked`);
});

test('a chain or a loop inside a chain draws its own steps inside it, before the step after it', () => {
  // A nested chain has two `next` edges: one into its first step, one on to the outer chain's next step. Taking only one
  // drew the outer step first and left the nested steps for after the rest.
  const workflow = { root: { node: 'chain', steps: [
    { node: 'chain', label: 'inner', steps: [{ node: 'agent', label: 'A' }, { node: 'agent', label: 'B' }] },
    { node: 'loop', label: 'again', body: { node: 'agent', label: 'L' } },
    { node: 'agent', label: 'C' },
  ] } } as unknown as Json;
  const drawn = viewed([], workflow);
  assert.deepEqual(rows(drawn).map((row) => row.path), ['/root', '/root/steps/0', '/root/steps/0/steps/0', '/root/steps/0/steps/1', '/root/steps/1', '/root/steps/1/body', '/root/steps/2']);
  const find = (node: Node, path: string): Node | undefined => (typeof node === 'string' || !('children' in node) ? undefined
    : node.tag === 'li' && node.title === path ? node : (node.children ?? []).map((child) => find(child, path)).find(Boolean));
  const inside = (path: string) => rows(find(drawn, path)!).map((row) => row.path).slice(1);
  assert.deepEqual(inside('/root/steps/0'), ['/root/steps/0/steps/0', '/root/steps/0/steps/1'], 'the inner chain holds its steps');
  assert.deepEqual(inside('/root/steps/1'), ['/root/steps/1/body'], 'the loop holds its body');
  assert.deepEqual(inside('/root/steps/2'), []);
});
