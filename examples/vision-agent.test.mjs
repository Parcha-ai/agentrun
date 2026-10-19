// The one vision agent at $0, on the reference host: a scripted lead over real files, for each example folder's question.
// It checks the plumbing a live run rests on (the question and files reach the agent, its code tool has the vision
// functions, the skills are in its instructions, the report it writes is kept in the recording with its cites by key)
// and that each example folder is a question, files with their sources and checks, and a README. Without ffmpeg and
// pdftoppm the runs skip.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exampleAt, fileName, inputOf, INSTRUCTIONS, skills } from './vision-agent/agent.ts';
import { argvFor, options } from './vision-agent/run.ts';
import { scriptFor } from './vision-agent/fakes.ts';
import { jevKeyOf, jevOptionsOf, liveParts, missingKeys, namedModels, preflight } from './vision-agent/live.ts';
import { demo } from '@parcha/agentrun-reference';

const PROGRAMS = (() => { try { for (const cmd of ['ffmpeg', 'ffprobe', 'pdftoppm']) execFileSync(cmd, [cmd === 'pdftoppm' ? '-v' : '-version'], { stdio: 'ignore' }); return false; } catch { return 'ffmpeg, ffprobe and pdftoppm are needed'; } })();
const EXAMPLES = ['video-chapters', 'hear-and-find', 'document-check', 'apollo-descent', 'boulder-chapters', 'fair-robot'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = async (t) => { const tmp = await mkdtemp(join(tmpdir(), 'vision-agent-')); t.after(() => rm(tmp, { recursive: true, force: true })); return tmp; };
async function go(tmp, argv, env = {}) {
  Object.assign(process.env, env);
  try { return await demo({ ...options, argv: ['--dir', join(tmp, 'run'), ...argv] }); } finally { for (const name of Object.keys(env)) delete process.env[name]; }
}
const statusOf = (run) => run.processes.at(-1)?.outcome?.status;
const stderrOf = (run) => run.processes.map((process) => `${process.outcome?.message ?? ''}\n${process.stderr}`).join('\n');

test('each example is a question, its files with their sources and checks, and a README; nothing in it is code', () => {
  const assets = readFileSync(join(import.meta.dirname, '..', 'ASSETS.md'), 'utf8');
  for (const name of EXAMPLES) {
    const example = exampleAt(name);
    assert.ok(example.question.length > 40, `${name}: a question in plain words`);
    assert.ok(existsSync(join(example.dir, 'README.md')));
    assert.deepEqual(readdirSync(example.dir).filter((file) => /\.(m?[jt]s)$/.test(file)), [], `${name}: no code in the folder`);
    for (const item of example.items) {
      assert.match(item.sha256, /^[0-9a-f]{64}$/);
      assert.ok(item.bytes > 0 && (item.url || item.path), `${name}: ${item.id} is fetched or committed`);
      if (item.url) assert.match(item.url, /^https:\/\//);
      if (item.path) {
        const bytes = readFileSync(join(example.dir, item.path));
        assert.deepEqual([bytes.length, sha256(bytes)], [item.bytes, item.sha256], `${name}: ${item.path} is the file inputs.json checks`);
        assert.ok(assets.includes(`\`${fileName(item)}\``) && assets.includes(item.sha256), `${name}: ASSETS.md names ${fileName(item)} with its SHA-256`);
      }
    }
    assert.deepEqual(inputOf(example), { question: example.question, files: example.items.map(fileName), example: name });
  }
});

test('the agent\'s instructions carry the question\'s place, the functions, the citation rule, the report, and every skill the package ships', () => {
  const text = INSTRUCTIONS();
  for (const word of ['`question`', '`files`', 'vision.see', 'vision.judge', 'vision.transcribe', '#page=N', '#t=', 'report/']) assert.ok(text.includes(word), word);
  for (const skill of skills()) assert.ok(text.includes(`The ${skill.name} skill:`) && text.includes(skill.text.slice(0, 200)), skill.name);
  assert.ok(skills().some((skill) => skill.name === 'look') && skills().some((skill) => skill.name === 'find'));
  const [node] = options.job.workflow.root.steps;
  assert.deepEqual([node.tools, node.thinking], [['code'], 'medium'], 'one code tool, and the node thinks at medium');
  assert.deepEqual(options.spec.tools, [], 'no tool of the example\'s own');
});

test('Jev goes through the gateway\'s /typesafe when a gateway is set, else TYPESAFE_BASE_URL, else TypeSafe\'s own address', () => {
  const key = { TYPESAFE_API_KEY: 'not-a-secret' };
  assert.equal(jevOptionsOf({ ...key, VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1', VIDEO_MODEL_API_KEY: 'not-a-secret' }).baseURL, 'https://gateway.invalid/typesafe');
  assert.equal(jevOptionsOf({ ...key, VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1/' }).baseURL, 'https://gateway.invalid/typesafe');
  assert.equal(jevOptionsOf({ ...key, VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1', TYPESAFE_BASE_URL: 'https://proxy.invalid' }).baseURL, 'https://gateway.invalid/typesafe', 'the gateway wins');
  assert.equal(jevOptionsOf({ ...key, TYPESAFE_BASE_URL: 'https://proxy.invalid' }).baseURL, 'https://proxy.invalid');
  assert.equal('baseURL' in jevOptionsOf(key), false, 'no gateway and no base: the SDK\'s own address');
  assert.equal(jevOptionsOf(key).apiKey, 'not-a-secret');
  assert.ok(options.spec.keys.some((entry) => entry.env === 'TYPESAFE_BASE_URL'), 'declared, so a live child gets it');
});

// A live run's keys, told before anything starts. Every value here is a made-up string: no network, no model.
const GATEWAY = { VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1', VIDEO_MODEL_API_KEY: 'not-a-secret' };
const live = ['examples/document-check', '--live'];

test('a gateway serves the lead, the eyes and Jev: with no TYPESAFE_API_KEY its key is Jev\'s, and the preflight passes', () => {
  assert.deepEqual(missingKeys(GATEWAY), []);
  assert.equal(preflight(live, GATEWAY), undefined);
  assert.equal(jevKeyOf(GATEWAY), 'not-a-secret');
  assert.equal(jevOptionsOf(GATEWAY).apiKey, 'not-a-secret');
  assert.equal(jevOptionsOf({ ...GATEWAY, TYPESAFE_API_KEY: 'fake-test-key' }).apiKey, 'fake-test-key', 'TypeSafe\'s own key wins when it is given');
  assert.deepEqual(missingKeys({ ...GATEWAY, TYPESAFE_API_KEY: 'fake-test-key' }), []);
  assert.equal(jevKeyOf({ VIDEO_MODEL_API_KEY: 'not-a-secret' }), undefined, 'a gateway key without a gateway is no key for TypeSafe');
});

test('no gateway: Jev needs TYPESAFE_API_KEY, each provider the run uses needs its key, and the message names exactly what is missing', () => {
  const ok = { TYPESAFE_API_KEY: 'fake-test-key', GEMINI_API_KEY: 'fake' };
  assert.deepEqual(missingKeys(ok), []);
  assert.equal(preflight(live, ok), undefined);
  const noJev = preflight(live, { GEMINI_API_KEY: 'fake' });
  assert.match(noJev, /^--live is missing TYPESAFE_API_KEY \(typesafe\.ai: Jev judges the frames and pages and draws the boxes\)\. SETUP-PROMPT\.md says where to get it\.$/);
  assert.ok(!/GEMINI_API_KEY|VIDEO_MODEL/.test(noJev), 'a key it has is not named');
  const nothing = preflight(live, {});
  assert.match(nothing, /TYPESAFE_API_KEY/);
  assert.match(nothing, /OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY\) or a gateway \(VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY\)/);
  assert.match(nothing, /where to get them\.$/);
});

test('a missing lead or eyes key names the key, the role and the model; flags choose what is checked', () => {
  const jev = { TYPESAFE_API_KEY: 'fake-test-key' };
  assert.match(preflight([...live, '--model', 'anthropic/claude-haiku-5-5'], { ...jev, GEMINI_API_KEY: 'fake' }), /^--live is missing ANTHROPIC_API_KEY \(the lead anthropic\/claude-haiku-5-5\)\./);
  assert.match(preflight([...live, '--eyes-model', 'openai/gpt-6-sol'], { ...jev, GEMINI_API_KEY: 'fake' }), /^--live is missing OPENAI_API_KEY \(the eyes openai\/gpt-6-sol\)\./);
  assert.match(preflight([...live, '--model', 'openai/a', '--eyes-model', 'openai/b'], jev), /^--live is missing OPENAI_API_KEY \(the lead openai\/a and the eyes openai\/b\)\./, 'one key, both its roles');
  assert.match(preflight([...live, '--provider', 'openai', '--model', 'gpt-6-luna'], jev), /^--live is missing OPENAI_API_KEY \(the lead openai\/gpt-6-luna\); a key for the eyes \(OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY\) or a gateway/, 'the lead named, the eyes with no key to choose from');
  assert.deepEqual(namedModels({ provider: 'openai', model: 'gpt-6-luna' }), { lead: 'openai/gpt-6-luna' });
  assert.deepEqual(namedModels({ model: 'google/x', eyesModel: 'google/y' }), { lead: 'google/x', eyes: 'google/y' });
  assert.match(preflight([...live, '--model', 'nowhere/x'], jev), /^a model is named provider\/id with a provider of openai, google, anthropic; nowhere\/x is not$/, 'a model named wrongly is its own error, not a missing key');
  const typo = /^a model is named provider\/id with a provider of openai, google, anthropic; nowhere\/x is not$/;
  assert.match(preflight([...live, '--model', 'nowhere/x'], GATEWAY), typo, 'a gateway serves any provider, but a typo in the name is refused before anything starts all the same');
  assert.match(preflight([...live, '--eyes-model', 'nowhere/x'], GATEWAY), typo);
  assert.equal(preflight([...live, '--model', 'openai/gpt-6-luna'], { ...jev, OPENAI_API_KEY: 'fake', GEMINI_API_KEY: 'fake' }), undefined);
});

test('a gateway without its key names VIDEO_MODEL_API_KEY, and a run that is not live, or is a child of one, is not checked', () => {
  const lacking = preflight(live, { VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1' });
  assert.match(lacking, /^--live is missing VIDEO_MODEL_API_KEY \(the gateway's credential/);
  assert.ok(!/TYPESAFE_API_KEY/.test(lacking), 'a gateway needs only its own key');
  assert.equal(preflight(['examples/document-check'], {}), undefined, 'a run on fakes needs no key');
  assert.equal(preflight(['--live', '--child'], {}), undefined, 'the supervisor has checked');
  assert.equal(preflight(['--record', 'r', '--max-usd', '1'], {}), undefined);
});

/** run.ts as the command line starts it, with exactly `env` (so no key of this machine leaks in), in a directory of its own. */
function command(dir, args, env) {
  return spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', join(import.meta.dirname, 'vision-agent', 'run.ts'), ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, ...env }, encoding: 'utf8', timeout: 120_000 });
}

test('a live run without its keys stops with the message and a failing code, and leaves nothing: no recording, no run directory, no cost line', async (t) => {
  const dir = await scratch(t);
  const record = join(dir, 'recording');
  const ran = command(dir, ['examples/document-check', '--live', '--record', record].map((arg) => (arg.startsWith('examples/') ? join(import.meta.dirname, '..', arg) : arg)), {});
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /^--live is missing TYPESAFE_API_KEY .*; .*or a gateway \(VIDEO_MODEL_BASE_URL and VIDEO_MODEL_API_KEY\)\. SETUP-PROMPT\.md says where to get them\.\n$/s);
  assert.doesNotMatch(`${ran.stdout}${ran.stderr}`, /cost:|recording:|run directory:|stopped:/);
  assert.deepEqual(readdirSync(dir), [], 'nothing was written: not the recording, not a scratch directory');
  assert.equal(existsSync(record), false);
});

test('the live parts build with a gateway and no TYPESAFE_API_KEY (Jev under the gateway\'s key), and refuse, naming the key, without one', () => {
  const parts = liveParts({ env: GATEWAY, models: {} });
  assert.equal(parts.models.jev, 'typesafe/jev-1.14.0');
  assert.equal(typeof parts.host.decisions.runJudge, 'function');
  assert.throws(() => liveParts({ env: { GEMINI_API_KEY: 'fake' }, models: {} }), /^Error: --live is missing TYPESAFE_API_KEY \(typesafe\.ai/);
});

test('an example folder becomes the run\'s input', () => {
  const argv = argvFor(['examples/hear-and-find', '--live', '--record', 'r']);
  assert.deepEqual(argv.slice(0, 3), ['--live', '--record', 'r']);
  assert.deepEqual(JSON.parse(argv.at(-1)), inputOf(exampleAt('hear-and-find')));
  assert.deepEqual(argvFor(['--record', 'r']), ['--record', 'r'], 'no folder, nothing added');
});

test('on fakes the document check runs over the committed PDFs and ends with a report the recording keeps, its cite a look by key at #page=', { timeout: 300_000, skip: PROGRAMS }, async (t) => {
  const tmp = await scratch(t);
  const record = join(tmp, 'recording');
  const run = await go(tmp, ['--record', record, ...argvFor(['examples/document-check']).filter((arg, i, all) => i >= all.indexOf('--input'))], {});
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  assert.match(run.record.answer, /^\(scripted\)/);
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.kills, manifest.generations, manifest.example], [0, 1, 'document-check']);
  const kept = JSON.parse(readFileSync(join(record, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  assert.equal(kept.report.page, 'report/index.html');
  const page = readFileSync(join(record, 'blobs', `${kept.report.files['index.html']}.html`), 'utf8');
  assert.match(page, /<section id="answer">/);
  assert.ok(existsSync(join(record, 'blobs', `${kept.report.files['frames/one.png']}.png`)), 'the picture the report shows is a blob too');
  const [cite, ...more] = kept.rows[0].cites;
  assert.deepEqual(more, [], 'one cite, a look: the page itself is the result\'s report, not a cite');
  assert.deepEqual([cite.fragment, cite.note], ['#page=1', 'page 1']);
  const filed = readdirSync(join(tmp, 'run', 'evidence'), { recursive: true }).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(tmp, 'run', 'evidence', name), 'utf8')));
  assert.ok(filed.some((look) => look.facts.key === cite.look), 'the report\'s cite names a look the run filed');
});

test('on fakes a film question runs over a film given beside it, and the report cites the frame at #t=', { timeout: 300_000, skip: PROGRAMS }, async (t) => {
  const tmp = await scratch(t);
  const files = join(tmp, 'files');
  mkdirSync(files);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=160x120:rate=5', '-f', 'lavfi', '-i', 'sine=duration=4', '-shortest', '-pix_fmt', 'yuv420p', join(files, 'film.mp4')]);
  const input = { question: exampleAt('hear-and-find').question, files: ['film.mp4'] };
  const run = await go(tmp, ['--record', join(tmp, 'recording'), '--input', JSON.stringify(input)], { DEMO_FILES_DIR: files });
  assert.equal(statusOf(run), 'complete', stderrOf(run));
  const manifest = JSON.parse(readFileSync(join(tmp, 'recording', 'manifest.json'), 'utf8'));
  const kept = JSON.parse(readFileSync(join(tmp, 'recording', 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  assert.deepEqual(kept.rows[0].cites.map((cite) => [cite.fragment, cite.note]), [['#t=1', '1 s']]);
});

// The report skill writes report/index.html, so the scripted lead and the fallback prompt do too: one name, fakes and live alike.
test('the report is report/index.html everywhere: the scripted lead writes and returns it, and the instructions name it with or without the report skill', () => {
  const script = scriptFor({ question: 'q', files: ['a.pdf'] });
  assert.match(script, /cat > report\/index\.html <</);
  assert.match(script, /report: "report\/index\.html" \}/);
  assert.match(script, /in report\/index\.html\./);
  assert.doesNotMatch(script, /report\.html/);
  const withSkill = INSTRUCTIONS(skills());
  assert.ok(skills().some((skill) => skill.name === 'report'), 'the package ships the report skill');
  assert.match(withSkill, /report\/index\.html/, 'the report skill names its entry');
  assert.doesNotMatch(withSkill, /report\.html/);
  const without = INSTRUCTIONS([]);
  assert.match(without, /Write the report as `report\/index\.html`/);
  assert.match(without, /\(`report\/index\.html`\)/);
  assert.doesNotMatch(without, /report\.html/);
});

// Through a gateway's chat completions an Anthropic model answers with thinking off, so its lead would have no thinking blocks;
// Anthropic's own Messages API, which the gateway serves at its root, returns them.
const catalogOf = (models, env = GATEWAY) => liveParts({ env, models }).host.models.catalog;

test('through a gateway an Anthropic model goes over the Messages API at the gateway\'s root; the other providers stay OpenAI-compatible, and a provider\'s own key reaches Anthropic itself', () => {
  const lead = catalogOf({ model: 'anthropic/claude-sonnet-5-5' }).getModel('anthropic', 'claude-sonnet-5-5');
  assert.deepEqual([lead.api, lead.baseUrl], ['anthropic-messages', 'https://gateway.invalid'], 'the client adds /v1/messages to the root');
  const slash = catalogOf({ model: 'anthropic/claude-haiku-5-5' }, { ...GATEWAY, VIDEO_MODEL_BASE_URL: 'https://gateway.invalid/v1/' }).getModel('anthropic', 'claude-haiku-5-5');
  assert.equal(slash.baseUrl, 'https://gateway.invalid', 'a trailing slash too');
  const openai = catalogOf({ model: 'openai/gpt-6-luna' }).getModel('openai', 'gpt-6-luna');
  assert.ok(/^openai-(responses|completions)$/.test(openai.api) && openai.baseUrl === 'https://gateway.invalid/v1', 'OpenAI\'s models are unchanged');
  const eyes = catalogOf({}).getModel('google', 'gemini-3.8-flash');
  assert.ok(/^openai-(responses|completions)$/.test(eyes.api) && eyes.baseUrl === 'https://gateway.invalid/v1', 'so are Google\'s');
  const own = liveParts({ env: { TYPESAFE_API_KEY: 'fake-test-key', ANTHROPIC_API_KEY: 'fake', GEMINI_API_KEY: 'fake' }, models: { model: 'anthropic/claude-sonnet-5-5' } }).host.models.catalog.getModel('anthropic', 'claude-sonnet-5-5');
  assert.deepEqual([own.api, own.baseUrl], ['anthropic-messages', 'https://api.anthropic.com'], 'with no gateway the provider is pi-ai\'s own');
});

const SSE = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'seat one first' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Ana' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');

test('an Anthropic lead through a gateway sends Anthropic\'s thinking at the level asked, to /v1/messages under the gateway\'s key, and keeps the thinking blocks that come back', async () => {
  const catalog = catalogOf({ model: 'anthropic/claude-sonnet-5-5' });
  const model = catalog.getModel('anthropic', 'claude-sonnet-5-5');
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: new URL(String(url)), key: new Headers(init.headers).get('x-api-key'), body: JSON.parse(init.body) });
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const ask = (reasoning) => catalog.streamSimple(model, { messages: [{ role: 'user', content: 'who sits first?', timestamp: 0 }] }, { reasoning, fetch }).result();
  const reply = await ask('medium');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url.origin + sent[0].url.pathname, 'https://gateway.invalid/v1/messages');
  assert.equal(sent[0].key, GATEWAY.VIDEO_MODEL_API_KEY, 'the gateway\'s key');
  assert.deepEqual([sent[0].body.thinking.type, sent[0].body.thinking.display], ['adaptive', 'summarized'], 'Anthropic\'s thinking, summarized so its text comes back');
  const effort = (body) => body.messages.filter((message) => message.role === 'system' && message.output_config).at(-1)?.output_config.effort;
  assert.equal(effort(sent[0].body), 'medium', 'thinking medium is Anthropic\'s effort medium');
  assert.equal(reply.stopReason, 'stop');
  assert.deepEqual(reply.content.map((block) => [block.type, block.type === 'thinking' ? block.thinking : block.text]), [['thinking', 'seat one first'], ['text', 'Ana']]);
  await ask('low');
  assert.equal(effort(sent[1].body), 'low', 'and low is low');
});
