// The compiled binary (scripts/build-binary.mjs) on a made-up home: the import CLI's known answer, one line per session,
// byte for byte what Node prints running the same CLI built to packages/import/dist. The binary is the one AGENTRUN_BINARY names (CI's binary job builds it on
// each runner); without one, the tests that run it skip.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { DEFAULT_ENTRY, hostTarget, missingImports } from './build-binary.mjs';

const BINARY = process.env.AGENTRUN_BINARY;
const skip = BINARY ? false : 'AGENTRUN_BINARY is unset: no compiled binary to run (node scripts/build-binary.mjs builds one)';

const scratch = mkdtempSync(join(tmpdir(), 'build-binary-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const lines = (path, records) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
};
const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

/** A home with each source's sessions, and the files a reader passes over beside them. */
function home() {
  const dir = mkdtempSync(join(scratch, 'home-'));
  const projects = join(dir, '.claude', 'projects');
  const usage = (input, cacheRead, cacheWrite, output) => ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output });
  const answer = (uuid, id, counts) => ({ type: 'assistant', uuid, sessionId: 's-a', timestamp: at(2), message: { id, role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'Done.' }], usage: counts } });
  const copied = answer('a3', 'msg_2', usage(5, 100, 0, 7));
  lines(join(projects, '-fixture-a', 's-a.jsonl'), [
    { type: 'user', uuid: 'u1', sessionId: 's-a', timestamp: at(1), message: { role: 'user', content: 'First question.' } },
    // One request in two records: the first holds the stream's start, the last the most of each count.
    answer('a1', 'msg_1', usage(10, 0, 100, 1)),
    answer('a2', 'msg_1', usage(10, 0, 100, 20)),
    copied,
  ]);
  // A resumed session's file carries a copy of a record the first file holds: counted once.
  lines(join(projects, '-fixture-b', 's-b.jsonl'), [copied, { ...answer('b1', 'msg_3', usage(3, 200, 50, 9)), sessionId: 's-b' }]);
  lines(join(projects, '-fixture-a', 's-a', 'subagents', 'agent-1.jsonl'), [answer('c1', 'msg_9', usage(1000, 0, 0, 1000))]);
  writeFileSync(join(projects, '-fixture-a', 'notes.txt'), 'not a session\n');
  symlinkSync(join(projects, '-fixture-a', 's-a.jsonl'), join(projects, '-fixture-b', 'linked.jsonl'));

  const tokenCount = (input, cached, output, total) => ({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, total_token_usage: { total_tokens: total } } } });
  const message = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  const context = { type: 'turn_context', payload: { model: 'fixture-model', effort: 'high' } };
  lines(join(dir, '.codex', 'sessions', '2026', '01', '02', 'rollout-2026-01-02-fixture.jsonl'), [
    { type: 'session_meta', payload: { id: 'codex-session', cwd: '/fixture/project', model_provider: 'fixture' } },
    context, message('user', 'First question.'), message('assistant', 'First answer.'), tokenCount(1000, 400, 50, 1050),
    // A token_count that repeats the last total is no new request.
    tokenCount(1000, 400, 50, 1050),
    context, message('user', 'Next question.'), message('assistant', 'Next answer.'), tokenCount(500, 500, 5, 1555),
  ].map((record, i) => ({ ...record, timestamp: at(i) })));
  lines(join(dir, '.codex', 'sessions', 'rollout-too-shallow.jsonl'), [{ type: 'session_meta', payload: { id: 'shallow' } }]);

  const piAnswer = (stopReason, counts) => ({ type: 'message', timestamp: at(3), message: { role: 'assistant', provider: 'fixture', model: 'fixture-model', stopReason, content: [{ type: 'text', text: 'Done.' }], usage: { ...counts, cost: { total: 0.01 } } } });
  lines(join(dir, '.pi', 'agent', 'sessions', '--fixture-project--', '2026-01-01T00-00-00-000Z_pi-session.jsonl'), [
    { type: 'session', id: 'pi-session', cwd: '/fixture/project', timestamp: at(0) },
    { type: 'message', timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'First question.' }] } },
    piAnswer('stop', { input: 40, output: 4, cacheRead: 60, cacheWrite: 30 }),
    // A request cut before its end has only the start of its counts: none counted.
    piAnswer('aborted', { input: 9000, output: 9000, cacheRead: 0, cacheWrite: 0 }),
  ]);
  return dir;
}

test('a bundle that imports node:sqlite where it loads is refused, and one that imports it in a branch is not', () => {
  const inputs = (kind) => ({ inputs: { 'src/store.mjs': { imports: [{ path: 'node:fs', kind: 'import-statement' }, { path: 'node:sqlite', kind }] } } });
  for (const kind of ['import-statement', 'require-call']) assert.deepEqual(missingImports(inputs(kind)).map(({ file, module }) => [file, module]), [['src/store.mjs', 'node:sqlite']]);
  assert.deepEqual(missingImports(inputs('dynamic-import')), []);
  assert.deepEqual(missingImports({}), []);
});

test("this machine's target is Bun's name for its platform and architecture, and one Bun has none for is refused", () => {
  assert.equal(hostTarget('darwin', 'arm64'), 'bun-darwin-arm64');
  assert.equal(hostTarget('linux', 'x64'), 'bun-linux-x64');
  assert.throws(() => hostTarget('win32', 'ia32'), /no Bun target for win32-ia32/);
});

const key = (path) => createHash('sha256').update(path).digest('hex');
const run = (args, options = {}) => spawnSync(BINARY, args, { encoding: 'utf8', cwd: scratch, env: { PATH: process.env.PATH ?? '' }, ...options });
/** The import CLI as Node runs it: the build in packages/import/dist (npm run build -w packages/import). */
const NODE_CLI = fileURLToPath(new URL('../packages/import/dist/cli.js', import.meta.url));
const USAGE = /usage: agentrun-import <home> \[--sources claude-code,codex,pi\] --known-answer/;
const tokens = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite, cacheWrite1h: 0 });
// What the home holds, a line per session sorted by key: the resumed copy counts once, its subagent's requests join the
// parent's, the cut pi request counts as a call and not as tokens, and the file too shallow for codex is no session.
const EXPECTED = [
  { key: key('.codex/sessions/2026/01/02/rollout-2026-01-02-fixture.jsonl'), source: 'codex', tokens: tokens(600, 55, 900, 0), cost: null, turns: 2, calls: 2 },
  { key: key('.claude/projects/-fixture-a/s-a.jsonl'), source: 'claude-code', tokens: tokens(1018, 1036, 300, 150), cost: null, turns: 1, calls: 4 },
  { key: key('.pi/agent/sessions/--fixture-project--/2026-01-01T00-00-00-000Z_pi-session.jsonl'), source: 'pi', tokens: tokens(40, 4, 60, 30), cost: 0.02, turns: 1, calls: 2 },
].sort((a, b) => (a.key < b.key ? -1 : 1));

test('the default entry is the import CLI', () => {
  assert.equal(DEFAULT_ENTRY, fileURLToPath(new URL('../packages/import/src/cli.ts', import.meta.url)));
});

test("the binary prints each session's known answer under a home, byte for byte what Node running the CLI prints", { skip }, () => {
  const dir = home();
  const result = run([dir, '--known-answer']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map((line) => JSON.parse(line)), EXPECTED);
  const node = spawnSync(process.execPath, [NODE_CLI, dir, '--known-answer'], { encoding: 'utf8', cwd: scratch, env: { PATH: process.env.PATH ?? '' } });
  assert.equal(node.status, 0, `${node.stderr} (npm run build -w packages/import builds ${NODE_CLI})`);
  assert.equal(result.stdout, node.stdout);
});

test('--sources limits the binary to the sources named', { skip }, () => {
  const result = run([home(), '--sources', 'pi,codex', '--known-answer']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map((line) => JSON.parse(line).source).sort(), ['codex', 'pi']);
});

test('the binary prints nothing under an empty home', { skip }, () => {
  const empty = mkdtempSync(join(scratch, 'empty-'));
  const result = run([empty, '--known-answer']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('the binary exits 2 with its usage on no home, no --known-answer, an unknown source or an unknown option', { skip }, () => {
  const dir = home();
  for (const args of [[], ['--known-answer'], [dir], [dir, '--sources', 'nope', '--known-answer'], [dir, '--help'], ['--help']]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, USAGE);
    assert.equal(result.stdout, '');
  }
});

test('the binary reads no bunfig.toml from the directory it runs in', { skip }, () => {
  const dir = mkdtempSync(join(scratch, 'cwd-'));
  // A preload a bunfig.toml names would run before the entry, as code of the directory's.
  writeFileSync(join(dir, 'preload.mjs'), 'console.log("preloaded");\n');
  writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./preload.mjs"]\n');
  const result = run([home(), '--known-answer'], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /preloaded/);
});
