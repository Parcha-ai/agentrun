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
import { exampleAt, fileName, inputOf, INSTRUCTIONS, job, jobOf, skills, thinkingOf, thinkingRefusal } from './vision-agent/agent.ts';
import { argvFor, options } from './vision-agent/run.ts';
import { scriptFor } from './vision-agent/fakes.ts';
import { jevKeyOf, jevOptionsOf, liveParts, missingKeys, namedModels, preflight } from './vision-agent/live.ts';
import { demo } from '@parcha/agentrun-harness';

const PROGRAMS = (() => { try { for (const cmd of ['ffmpeg', 'ffprobe', 'pdftoppm']) execFileSync(cmd, [cmd === 'pdftoppm' ? '-v' : '-version'], { stdio: 'ignore' }); return false; } catch { return 'ffmpeg, ffprobe and pdftoppm are needed'; } })();
const EXAMPLES = ['video-chapters', 'hear-and-find', 'document-check', 'apollo-descent', 'boulder-chapters', 'fair-robot', 'lake-mead', 'market-street'];
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

// A lead through the gateway that records every request it sends, and answers with the stream above.
function anthropicAsks() {
  const catalog = catalogOf({ model: 'anthropic/claude-sonnet-5-5' });
  const model = catalog.getModel('anthropic', 'claude-sonnet-5-5');
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: new URL(String(url)), key: new Headers(init.headers).get('x-api-key'), body: JSON.parse(init.body) });
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const ask = (reasoning) => catalog.streamSimple(model, { messages: [{ role: 'user', content: 'who sits first?', timestamp: 0 }] }, { reasoning, fetch }).result();
  return { ask, sent };
}
const effort = (body) => body.messages.filter((message) => message.role === 'system' && message.output_config).at(-1)?.output_config.effort;

test('an Anthropic lead through a gateway sends Anthropic\'s thinking at the level asked, to /v1/messages under the gateway\'s key, and keeps the thinking blocks that come back', async () => {
  const { ask, sent } = anthropicAsks();
  const reply = await ask('medium');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url.origin + sent[0].url.pathname, 'https://gateway.invalid/v1/messages');
  assert.equal(sent[0].key, GATEWAY.VIDEO_MODEL_API_KEY, 'the gateway\'s key');
  assert.deepEqual([sent[0].body.thinking.type, sent[0].body.thinking.display], ['adaptive', 'summarized'], 'Anthropic\'s thinking, summarized so its text comes back');
  assert.equal(effort(sent[0].body), 'medium', 'thinking medium is Anthropic\'s effort medium');
  assert.equal(reply.stopReason, 'stop');
  assert.deepEqual(reply.content.map((block) => [block.type, block.type === 'thinking' ? block.thinking : block.text]), [['thinking', 'seat one first'], ['text', 'Ana']]);
  await ask('low');
  assert.equal(effort(sent[1].body), 'low', 'and low is low');
});

const levelOf = (flags) => jobOf(thinkingOf(argvFor(['examples/document-check', ...flags]), {})).workflow.root.steps[0].thinking;

test('--thinking is the run\'s input, not a host flag: it sets the agent node\'s thinking, and a run that names none thinks at medium as before', () => {
  const example = inputOf(exampleAt('document-check'));
  const plain = argvFor(['examples/document-check', '--record', 'r']);
  assert.deepEqual(JSON.parse(plain.at(-1)), example, 'no flag: the input is the example\'s, unchanged');
  assert.equal(thinkingOf(plain, {}), 'medium');
  for (const [flags, level] of [[['--thinking', 'high'], 'high'], [['--thinking=low'], 'low'], [['--thinking', 'medium'], 'medium']]) {
    const argv = argvFor(['examples/document-check', ...flags, '--record', 'r']);
    assert.ok(!argv.some((arg) => arg.startsWith('--thinking')), 'the host reads no such flag, so it is not passed on');
    assert.deepEqual(JSON.parse(argv.at(-1)), { ...example, thinking: level });
    assert.equal(thinkingOf(argv, {}), level);
  }
  assert.equal(thinkingOf(argvFor(['--thinking', 'high', 'examples/document-check']), {}), 'high', 'before the folder too');
  const given = argvFor(['--thinking', 'high', '--input', JSON.stringify({ question: 'q', files: [] })]);
  assert.deepEqual(JSON.parse(given[given.indexOf('--input') + 1]), { question: 'q', files: [], thinking: 'high' }, 'and on an input given directly');
  assert.equal(thinkingOf(['--child'], { INPUT: JSON.stringify({ question: 'q', files: [], thinking: 'high' }) }), 'high', 'the child has only INPUT');
  assert.equal(thinkingOf(['--child'], { INPUT: JSON.stringify({ question: 'q', files: [] }) }), 'medium');
  const node = (each) => each.workflow.root.steps[0];
  assert.deepEqual([node(job).thinking, node(jobOf()).thinking, node(jobOf('high')).thinking], ['medium', 'medium', 'high']);
  const high = structuredClone(jobOf('high').workflow);
  high.root.steps[0].thinking = 'medium';
  assert.deepEqual(high, job.workflow, 'nothing else about the workflow changes');
  assert.equal(job.workflow.schemas.Input.additionalProperties, false);
  assert.deepEqual(job.workflow.schemas.Input.properties.thinking.enum, ['low', 'medium', 'high']);
});

test('a thinking level that is not low, medium or high is refused before anything starts, and a valid one is not', async (t) => {
  const refusal = (...flags) => thinkingRefusal(argvFor(['examples/document-check', ...flags]), {});
  assert.equal(refusal(), undefined);
  for (const level of ['low', 'medium', 'high']) assert.equal(refusal('--thinking', level), undefined);
  assert.equal(refusal('--thinking', 'max'), '--thinking is low, medium or high; max is not');
  assert.equal(refusal('--thinking=off'), '--thinking is low, medium or high; off is not', 'thinking is never off');
  assert.equal(refusal('--thinking'), '--thinking needs a value: low, medium or high');
  assert.equal(refusal('--thinking', '--live'), '--thinking needs a value: low, medium or high', 'a flag is not its value');
  const dir = await scratch(t);
  const record = join(dir, 'recording');
  const ran = command(dir, ['examples/document-check', '--thinking', 'max', '--record', record].map((arg) => (arg.startsWith('examples/') ? join(import.meta.dirname, '..', arg) : arg)), {});
  assert.notEqual(ran.status, 0);
  assert.equal(ran.stderr, '--thinking is low, medium or high; max is not\n');
  assert.doesNotMatch(`${ran.stdout}${ran.stderr}`, /cost:|recording:|run directory:|stopped:/);
  assert.deepEqual(readdirSync(dir), [], 'nothing was written');
  assert.equal(existsSync(record), false);
});

test('--thinking with an input it cannot place (a file or a capture name, none, one that is not an object) is refused before anything starts, not dropped', async (t) => {
  const message = '--thinking needs an example folder or an inline JSON --input';
  const refusal = (...args) => thinkingRefusal(argvFor(args), {});
  assert.equal(refusal('--input', 'q.json', '--thinking', 'high'), message, 'a file');
  assert.equal(refusal('--thinking=high', '--input', 'a-capture'), message, 'a capture name');
  assert.equal(refusal('--thinking', 'high'), message, 'no input at all');
  assert.equal(refusal('--thinking', 'high', '--input', '5'), message, 'JSON that is not an object');
  assert.equal(refusal('--thinking', 'high', '--input', '[]'), message, 'nor an array');
  assert.equal(refusal('--thinking', 'max', '--input', 'q.json'), '--thinking is low, medium or high; max is not', 'a bad level is told first');
  assert.equal(refusal('--thinking', 'high', '--input', JSON.stringify({ question: 'q', files: [] })), undefined, 'an inline JSON object takes it');
  assert.equal(refusal('--input', 'q.json'), undefined, 'and without the flag nothing is asked');
  const dir = await scratch(t);
  writeFileSync(join(dir, 'q.json'), JSON.stringify({ question: 'q', files: [] }));
  const record = join(dir, 'recording');
  const ran = command(dir, ['--input', join(dir, 'q.json'), '--thinking', 'high', '--record', record], {});
  assert.notEqual(ran.status, 0);
  assert.equal(ran.stderr, `${message}\n`);
  assert.doesNotMatch(`${ran.stdout}${ran.stderr}`, /cost:|recording:|run directory:|stopped:/);
  assert.deepEqual(readdirSync(dir), ['q.json'], 'nothing was written but the input the test made');
  assert.equal(existsSync(record), false);
});

test('--thinking high reaches the Anthropic request as adaptive thinking at effort high, and a run that names none still asks medium', async () => {
  const { ask, sent } = anthropicAsks();
  assert.deepEqual([levelOf([]), levelOf(['--thinking', 'high']), levelOf(['--thinking=low'])], ['medium', 'high', 'low']);
  for (const flags of [[], ['--thinking', 'high'], ['--thinking', 'low']]) await ask(levelOf(flags));
  assert.deepEqual(sent.map((each) => each.body.thinking.type), ['adaptive', 'adaptive', 'adaptive']);
  assert.deepEqual(sent.map((each) => effort(each.body)), ['medium', 'high', 'low']);
});

test('on fakes the command with --thinking high carries it into the workflow the recording shows, and without the flag the run thinks at medium', { timeout: 300_000, skip: PROGRAMS }, async (t) => {
  const tmp = await scratch(t);
  const recorded = (name, flags) => {
    const dir = join(tmp, name);
    mkdirSync(dir);
    const record = join(dir, 'recording');
    const ran = command(dir, [join(import.meta.dirname, '..', 'examples', 'document-check'), ...flags, '--record', record], {});
    assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
    return readFileSync(join(record, 'events.jsonl'), 'utf8');
  };
  const high = recorded('high', ['--thinking', 'high']);
  assert.match(high, /"tools":\["code"\],"thinking":"high","state"/, 'the agent node the run\'s child ran thinks at high');
  assert.match(high, /"example":"document-check","thinking":"high"/, 'and the input says so');
  const plain = recorded('plain', []);
  assert.match(plain, /"tools":\["code"\],"thinking":"medium","state"/);
  assert.doesNotMatch(plain, /"thinking":"high"/);
});

// The example folder is the one token that is neither a flag nor a flag's value. A rule of "not after a --flag" took every flag for
// one that takes a value, so a folder after a switch (--live) was silently skipped and the run asked the default question.
const folderInput = (argv) => JSON.parse(argv.at(-1));

test('the example folder is found wherever it sits among the flags: after a switch, after a flag and its value, or first', () => {
  const doc = inputOf(exampleAt('document-check'));
  const places = [
    ['--live', 'examples/document-check'],
    ['--max-usd', '3', 'examples/document-check'],
    ['--max-usd=3', 'examples/document-check'],
    ['--record', 'r', '--live', 'examples/document-check'],
    ['--model', 'google/gemini-3.8-flash', '--fetch-sources', 'examples/document-check'],
    ['--see-also', 'a', '--see-also', 'b', 'examples/document-check'],
    ['--live', '--thinking', 'high', 'examples/document-check'],
    ['--thinking', 'high', '--live', 'examples/document-check'],
    ['examples/document-check', '--live', '--max-usd', '3'],
  ];
  for (const args of places) {
    const argv = argvFor(args);
    assert.deepEqual(folderInput(argv).example, 'document-check', `${args.join(' ')}: the folder is the example`);
    assert.deepEqual(folderInput(argv).files, doc.files);
    assert.ok(!argv.includes('examples/document-check'), `${args.join(' ')}: the folder is taken out of the arguments`);
  }
  assert.deepEqual(argvFor(['--live', 'examples/document-check']).slice(0, 1), ['--live'], 'a switch stays');
  assert.deepEqual(folderInput(argvFor(['examples/document-check', '--live', '--thinking', 'high'])), { ...doc, thinking: 'high' }, 'the folder first, as before');
  const same = argvFor(['--record', 'examples/document-check', 'examples/document-check']);
  assert.deepEqual(same.slice(0, 2), ['--record', 'examples/document-check'], 'a value that spells the folder is still the flag\'s value');
  assert.equal(folderInput(same).example, 'document-check');
});

test('the flags that take a value are the host\'s string options and --thinking: no flag the host reads is taken for the other kind', () => {
  const host = readFileSync(join(import.meta.dirname, '..', 'packages', 'harness', 'src', 'demo.ts'), 'utf8');
  const table = host.match(/const FLAGS = (\{.*?\}) as const;/s)?.[1];
  assert.ok(table, 'demo.ts still declares its FLAGS table where this test reads it');
  const flags = [...table.matchAll(/'?([a-z-]+)'?: \{ type: '(boolean|string)'/g)].map((match) => [match[1], match[2]]);
  assert.ok(flags.length >= 15 && flags.some(([name]) => name === 'live') && flags.some(([name]) => name === 'max-usd'));
  for (const [name, type] of [...flags, ['thinking', 'string']]) {
    const args = type === 'string' ? [`--${name}`, name === 'thinking' ? 'high' : 'v', 'examples/document-check'] : [`--${name}`, 'examples/document-check'];
    assert.equal(folderInput(argvFor(args)).example, 'document-check', `--${name} (${type}) then the folder: the folder is the example`);
  }
});

test('a folder that cannot be placed is refused before anything starts, never ignored: a second folder, a stray token, a folder that is not an example', async (t) => {
  assert.throws(() => argvFor(['examples/document-check', 'examples/video-chapters']), /^Error: one example folder at a time: examples\/document-check, examples\/video-chapters$/);
  assert.throws(() => argvFor(['--live', 'examples/document-check', '--max-usd', '3', 'examples/video-chapters']), /one example folder at a time/);
  assert.throws(() => argvFor(['--live', '3']), /^Error: 3: not an example folder/);
  const missing = (() => { try { argvFor(['examples/nowhere']); } catch (error) { return error.message; } })();
  assert.match(missing, /^examples\/nowhere: not an example folder/);
  assert.doesNotMatch(missing, /\/home\/|ENOENT/, 'a message, not a stack or a path of this machine');
  const dir = await scratch(t);
  const record = join(dir, 'recording');
  const ran = command(dir, ['examples/document-check', 'examples/video-chapters', '--record', record].map((arg) => (arg.startsWith('examples/') ? join(import.meta.dirname, '..', arg) : arg)), {});
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /^one example folder at a time: .*document-check, .*video-chapters\n$/);
  assert.doesNotMatch(ran.stderr, /\n.+\n/, 'one line');
  assert.doesNotMatch(`${ran.stdout}${ran.stderr}`, /cost:|recording:|run directory:|stopped:/);
  assert.deepEqual(readdirSync(dir), [], 'nothing was written');
  assert.equal(existsSync(record), false);
});

test('on fakes a folder after a switch is the run\'s example: the command asks the folder\'s question over its committed files', { timeout: 300_000, skip: PROGRAMS }, async (t) => {
  const tmp = await scratch(t);
  const dir = join(tmp, 'run');
  mkdirSync(dir);
  const record = join(dir, 'recording');
  const ran = command(dir, ['--json', join(import.meta.dirname, '..', 'examples', 'document-check'), '--record', record], {});
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  const events = readFileSync(join(record, 'events.jsonl'), 'utf8');
  assert.match(events, /"example":"document-check"/, 'the example reached the run\'s input');
  assert.match(events, /aveo-ex3-1-pages-1-4\.pdf/, 'and its committed files reached the workspace');
});
