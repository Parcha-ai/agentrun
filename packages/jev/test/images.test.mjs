// Images and Box questions (Jev 1.13 and 1.14): the header the SDK leaves to the caller goes on every request that carries an image or a Box
// and on no other; images travel as multipart file parts; a Box answer round-trips; and a request that cannot be valid is refused before any send.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createJevRunner, JevError } from '../dist/index.js';

const HEADER = 'TypeSafe-Danger-Zone-Images';
const png = (fill = 1) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, fill, 2, 3, 4]);
const jpeg = (fill = 1) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, fill, 2, 3, 4]);
const asPng = bytes => ({ bytes, mime: 'image/png' });
const asJpeg = bytes => ({ bytes, mime: 'image/jpeg' });
const box = { top: 0.1, bottom: 0.6, left: 0.2, right: 0.5 };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noulQuestions = { urgent: { type: 'noul', instructions: 'Is action urgent?' } };
const boxQuestions = { mug: { type: 'box', instructions: 'the mug in <photo>' }, open: { type: 'noul', instructions: 'Is the lid of the mug in <photo> open?' } };
const boxAnswers = { mug: { type: 'box', box, confidence: 0.8 }, open: { type: 'noul', noul: 0.2 } };
const quick = { retryBaseMs: 1, retryMaxMs: 2, apiKey: 'fake-test-key' };
// Box needs the model that answers it: jev-latest is 1.13.
const boxModel = { ...quick, model: 'jev-1.14.0' };
const code = expected => error => { assert.ok(error instanceof JevError, String(error)); assert.equal(error.code, expected); return true; };

// A fake transport that keeps what was sent: the headers, the content type, and the body read the way a server reads it.
function transport(...replies) {
  const seen = [];
  const fetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const type = headers['content-type'] ?? '';
    const record = { url: String(url), headers, type, encoding: headers['content-encoding'] };
    if (type.startsWith('multipart/form-data')) {
      const form = await new Response(init.body, { headers: { 'content-type': type } }).formData();
      const part = form.get('request');
      record.request = JSON.parse(typeof part === 'string' ? part : await part.text());
      record.parts = Object.fromEntries(await Promise.all([...form.entries()].filter(([name]) => name !== 'request').map(async ([name, file]) => [name, new Uint8Array(await file.arrayBuffer())])));
      record.firstPart = [...form.keys()][0];
    } else record.request = JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text());
    seen.push(record);
    const reply = replies[Math.min(seen.length, replies.length) - 1];
    return typeof reply === 'function' ? reply() : reply;
  };
  return { seen, fetch };
}
const ok = (answers, usage = { input_tokens: 900, output_tokens: 12 }) => response({ answers, model: 'jev-1.14', usage });

test('a request with no image and no Box sends no image header, as JSON, and hashes as it always did', async () => {
  const t = transport(ok({ urgent: { type: 'noul', noul: 0.9 } }));
  const result = await createJevRunner({ ...quick, fetch: t.fetch })({ label: 't', kind: 'judge', state: { ticket: 'Invoice issue' }, questions: noulQuestions });
  assert.equal(HEADER.toLowerCase() in t.seen[0].headers, false);
  assert.match(t.seen[0].type, /^application\/json/);
  assert.equal(t.seen[0].encoding, undefined, 'bodies are sent uncompressed, as before');
  assert.equal(result.request_sha256, createHash('sha256').update(JSON.stringify({ state: { ticket: 'Invoice issue' }, model: 'jev-latest', questions: noulQuestions })).digest('hex'));
});

test('an image goes as a multipart file part with the header, PNG or JPEG, and the state names it', async () => {
  for (const image of [asPng(png()), asJpeg(jpeg())]) {
    const t = transport(ok({ urgent: { type: 'noul', noul: 0.9 } }));
    await createJevRunner({ ...quick, fetch: t.fetch })({ label: 't', kind: 'judge', state: 'The photo <photo> shows a door.', questions: { urgent: { type: 'noul', instructions: 'Is the door in <photo> open?' } }, assets: { '<photo>': image } });
    const [sent] = t.seen;
    assert.equal(sent.headers[HEADER.toLowerCase()], 'true');
    assert.match(sent.type, /^multipart\/form-data; boundary=/);
    assert.equal(sent.firstPart, 'request', 'the JSON request is the first part');
    assert.equal(sent.request.state, 'The photo <photo> shows a door.');
    const asset = sent.request.assets['<photo>'];
    assert.ok(asset && typeof asset.part === 'string', 'the asset names its file part');
    assert.deepEqual(sent.parts[asset.part], image.bytes);
  }
});

test('a Box question round-trips: the header goes with it, the answer is validated and returned whole, beside other answers', async () => {
  const t = transport(ok(boxAnswers));
  const result = await createJevRunner({ ...boxModel, fetch: t.fetch })({ label: 't', kind: 'judge', state: 'Look at <photo>.', questions: boxQuestions, assets: { '<photo>': asJpeg(jpeg()) } });
  assert.equal(t.seen[0].headers[HEADER.toLowerCase()], 'true');
  assert.deepEqual(t.seen[0].request.questions, boxQuestions);
  assert.deepEqual(result.answers, boxAnswers);
  assert.deepEqual(result.usage, { input_tokens: 900, output_tokens: 12 });
});

test('a Box answer the provider got wrong is an invalid response, never returned', async () => {
  const bad = { mug: { type: 'box', box: { ...box, top: 1.5 }, confidence: 0.8 }, open: boxAnswers.open };
  const t = transport(ok(bad));
  await assert.rejects(createJevRunner({ ...boxModel, fetch: t.fetch })({ label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, assets: { '<photo>': asPng(png()) } }),
    error => { code('invalid_response')(error); assert.equal(error.responseDiagnostic.reason, 'box_coordinates'); return true; });
});

test('a request that cannot be valid is refused before any send: no image for a Box, a bad file, a reference nothing uses', async () => {
  const run = (params, options = {}) => { const t = transport(ok(boxAnswers)); return { t, promise: createJevRunner({ ...boxModel, ...options, fetch: t.fetch })({ label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, ...params }) }; };
  const cases = {
    'a Box with no image': { assets: undefined },
    'bytes that are neither PNG nor JPEG': { assets: { '<photo>': asPng(Uint8Array.from([1, 2, 3, 4])) } },
    'empty bytes': { assets: { '<photo>': asPng(new Uint8Array(0)) } },
    'a reference only a question id names': { state: 'no reference here', questions: { '<photo>': { type: 'noul', instructions: 'Is it open?' } }, assets: { '<photo>': asPng(png()) } },
    'a reference only an option name names': { state: 'no reference here', questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { '<photo>': null, other: null } } }, assets: { '<photo>': asPng(png()) } },
    'a mime type that names neither': { assets: { '<photo>': { bytes: png(), mime: 'image/gif' } } },
    'bytes that are a JPEG under a PNG label': { assets: { '<photo>': { bytes: jpeg(), mime: 'image/png' } } },
    'bytes that are not a Uint8Array': { assets: { '<photo>': { bytes: 'AAAA', mime: 'image/png' } } },
    'a file over 16 MiB': { assets: { '<photo>': asPng(Object.assign(new Uint8Array(16 * 1024 * 1024 + 1), png())) } },
    'a reference no state or question names': { state: 'no reference here', questions: { open: { type: 'noul', instructions: 'Is it open?' } }, assets: { '<photo>': asPng(png()) } },
    'an image that is not an object': { assets: { '<photo>': 'data:image/png;base64,AAAA' } },
  };
  for (const [name, params] of Object.entries(cases)) {
    const { t, promise } = run(params);
    await assert.rejects(promise, error => { code('invalid_request')(error); assert.equal(error.attempts, 0); return true; }, name);
    assert.equal(t.seen.length, 0, `${name}: nothing was sent`);
  }
});

test('the header is sent on every attempt of a retried image request, and the same bytes', async () => {
  const t = transport(() => response({ detail: 'busy' }, 429), ok(boxAnswers));
  await createJevRunner({ ...boxModel, fetch: t.fetch })({ label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, assets: { '<photo>': asPng(png()) } });
  assert.equal(t.seen.length, 2);
  for (const sent of t.seen) { assert.equal(sent.headers[HEADER.toLowerCase()], 'true'); assert.deepEqual(Object.values(sent.parts)[0], png()); }
});

test('the request hash names the image bytes: same bytes hash the same, other bytes do not, and no bytes are in the hash input', async () => {
  const hashOf = async bytes => (await createJevRunner({ ...boxModel, fetch: transport(ok(boxAnswers)).fetch })({ label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, assets: { '<photo>': asPng(bytes) } })).request_sha256;
  const [a, b, c] = [await hashOf(png(1)), await hashOf(png(1)), await hashOf(png(2))];
  assert.equal(a, b); assert.notEqual(a, c);
  assert.notEqual(a, createHash('sha256').update(JSON.stringify({ state: 'x <photo>', model: 'jev-latest', questions: boxQuestions })).digest('hex'), 'an image request never hashes as the same request without it');
});

test('priced and receipted as before: provider cost wins, a configured price estimates from the counted tokens, unknown stays null', async () => {
  const params = { label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, assets: { '<photo>': asPng(png()) } };
  const priced = await createJevRunner({ ...boxModel, fetch: transport(ok(boxAnswers, { input_tokens: 2000, output_tokens: 10 })).fetch, pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 } })(params);
  assert.equal(priced.cost_usd, 2000 * 0.042 / 1_000_000);
  const reported = await createJevRunner({ ...boxModel, fetch: transport(ok(boxAnswers, { input_tokens: 2000, output_tokens: 10, cost: 0.0002 })).fetch })(params);
  assert.equal(reported.cost_usd, 0.0002);
  assert.equal((await createJevRunner({ ...boxModel, fetch: transport(ok(boxAnswers)).fetch })(params)).cost_usd, null);
});

test('a host client gets the header in the call options and the assets as SDK images, and none of it for a text-only request', async () => {
  const calls = [];
  const client = { async systemOne(request, options) { calls.push({ request, options }); return { answers: boxAnswers, usage: { input_tokens: 5, output_tokens: 1 }, model: 'jev-1.14' }; } };
  const run = createJevRunner({ client, model: 'jev-1.14.0' });
  await run({ label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, assets: { '<photo>': asPng(png()) } });
  assert.equal(calls[0].options.headers?.[HEADER], 'true');
  assert.equal(Object.keys(calls[0].request.assets).join(), '<photo>');
  assert.equal(calls[0].request.assets['<photo>'].type, 'image');
  client.systemOne = async (request, options) => { calls.push({ request, options }); return { answers: { urgent: { type: 'noul', noul: 0.5 } }, model: 'jev-1.14' }; };
  await run({ label: 't', kind: 'judge', state: 'text', questions: noulQuestions });
  assert.equal(calls[1].options.headers?.[HEADER], undefined);
  assert.equal(calls[1].request.assets, undefined);
});

test('OpenRouter is not asked for images: that path is unverified, so the request is refused before any send', async () => {
  const t = transport(ok(boxAnswers));
  await assert.rejects(createJevRunner({ ...boxModel, provider: 'openrouter', fetch: t.fetch })({ label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, assets: { '<photo>': asPng(png()) } }), code('invalid_request'));
  assert.equal(t.seen.length, 0);
});

test('a Box question is refused before any request unless the named model answers Box (jev-1.14.0, jev-preview): jev-latest is 1.13', async () => {
  const params = { label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, assets: { '<photo>': asPng(png()) } };
  for (const model of [undefined, 'jev-latest', 'jev-1.13', 'jev-1.13.2', 'typesafe/jev-1.13', 'something-else']) {
    const t = transport(ok(boxAnswers));
    await assert.rejects(createJevRunner({ ...quick, ...(model ? { model } : {}), fetch: t.fetch })(params), error => {
      code('invalid_request')(error); assert.equal(error.attempts, 0); assert.equal(error.requestDiagnostic.reason, 'unsupported_model');
      assert.match(error.message, /jev-1\.14\.0/, 'the message names the model Box needs'); return true;
    }, String(model));
    assert.equal(t.seen.length, 0, `${model}: nothing was sent`);
  }
  for (const model of ['jev-1.14.0', 'jev-1.14', 'jev-1.15.2', 'jev-2.0.0', 'jev-preview']) {
    const t = transport(ok(boxAnswers));
    await createJevRunner({ ...quick, model, fetch: t.fetch })(params);
    assert.equal(t.seen[0].request.model, model);
  }
});

test('the caller names the model per call, and an image question (no Box) is allowed on jev-latest', async () => {
  const t = transport(ok(boxAnswers), ok({ urgent: { type: 'noul', noul: 0.5 } }));
  const run = createJevRunner({ ...quick, fetch: t.fetch });
  await run({ label: 't', kind: 'judge', state: 'x <photo>', questions: boxQuestions, model: 'jev-1.14.0', assets: { '<photo>': asPng(png()) } });
  await run({ label: 't', kind: 'judge', state: 'x <photo>', questions: { urgent: { type: 'noul', instructions: 'Is <photo> urgent?' } }, assets: { '<photo>': asPng(png()) } });
  assert.deepEqual(t.seen.map(sent => sent.request.model), ['jev-1.14.0', 'jev-latest']);
  assert.ok(t.seen.every(sent => sent.headers[HEADER.toLowerCase()] === 'true'));
});

test('a reference counts where it sits in a string value of the state, an instruction or a criterion, however deep', async () => {
  const cases = [
    { state: { notes: ['see <photo>'] }, questions: noulQuestions },
    { state: 'plain', questions: { urgent: { type: 'noul', instructions: 'Is <photo> urgent?' } } },
    { state: 'plain', questions: { pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'looks like <photo>', b: null } } } },
    { state: 'plain', questions: { level: { type: 'score', instructions: 'How bad?', criteria: ['fine', 'like <photo>'] } } },
  ];
  for (const { state, questions } of cases) {
    const t = transport(ok({ urgent: { type: 'noul', noul: 0.9 } }));
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: 0.9 } : q.type === 'choice' ? { type: 'choice', choice: 'a', probabilities: { a: 0.5, b: 0.5 }, confidence: 0.1 } : { type: 'score', score: 0.5, legend: { 0: 'fine', 1: 'like <photo>' }, probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.1 }]));
    const run = createJevRunner({ ...quick, fetch: transport(ok(answers)).fetch });
    await run({ label: 't', kind: 'judge', state, questions, assets: { '<photo>': asPng(png()) } });
    void t;
  }
});
