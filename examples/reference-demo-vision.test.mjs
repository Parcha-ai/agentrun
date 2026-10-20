// vision and code mode: the looks the entry keeps, the vision lane, and code mode's tools.bash, vision.see, vision.judge and vision.transcribe.
// One of the files the reference entry's demo tests are split into (each under about two minutes serial on CI); the shared helpers are in reference-demo-helpers.mjs.
// The reference entry as a demo's platform (item A of the entry brief): the spec's kills list through the supervisor (a named crossing, a storm, a box kind),
// --input, --max-usd, the browser choice, and the box the job's tools run in. The demo here is the reference job itself, started through demo-fixture.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { effectiveBoxes } from '../packages/harness/dist/demo-spec.js';
import { BOX_CROSSINGS, localPlace, priceJudge, chooseBrowser, crossings, demo, tapBox, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from '@parcha/agentrun-harness';
import { ORIGINAL, FIXTURE, BASELINE, run, composeHost, destroyBoxes, meterKnown, RUN_LABEL, localBoxes, ctx, finish, lines, planFor, recordingPlace, specWith, SITES, signInHome, filesIn, killSpec, boxed } from './reference-demo-helpers.mjs';

test('the vision option: each look is filed, whole, in a vision.looks document with the image the eyes saw as a blob, and the counters read the look and its cost', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_EYES: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  const filed = lines.filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks);
  assert.equal(filed.length, 1, 'one look, filed once');
  assert.equal(filed[0].record.status, 'ok');
  assert.equal(filed[0].images.length, 1);
  assert.equal(filed[0].images[0].type, 'image');
  const bytes = readFileSync(join(recording, 'blobs', `${filed[0].images[0].blob}.png`));
  assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], 'the scan the eyes saw is in blobs/ as a PNG');
  const counted = fold(lines);
  assert.equal(counted.paid.vision, 1);
  assert.ok(counted.cost > 0, 'the eyes\' price is in the cost');
  assert.equal(JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')).cost.parts.look, counted.cost);
});
test('a kill at vision.filing (the eyes answered, the look not yet filed): the next process files the kept answer and the eyes are asked once in all', { timeout: 300_000 }, async (t) => {
  const { result, recording, tmp } = await run(t, { kills: [{ point: 'vision.filing', why: 'the answer is paid and kept, the look is not filed', hold: 1 }] }, ['--kill', '--json'], { DEMO_EYES: '1' });
  assert.deepEqual(result.processes.map((process) => process.signal), ['SIGKILL', null]);
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(result.unlanded, []);
  assert.equal(result.kills[0].point, 'vision.filing');
  const asked = readFileSync(join(result.dir, 'eyes.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(asked, 1, 'the eyes were asked once, across both processes');
  assert.deepEqual(validateRecording(recording), []);
  const counted = fold(readEvents(recording));
  assert.deepEqual([counted.processes, counted.kills, counted.paid.vision, counted.repeated, counted.unknown], [2, 1, 1, 0, 0]);
  assert.ok(tmp);
});
test('looks carry their data set item, and every read leaves one live vision/shown line; a look that failed is kept with its miss', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_EYES: '1', DEMO_ITEM: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  const lines = readEvents(recording);
  const filed = lines.filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks);
  assert.deepEqual(filed.map((entry) => [entry.item, entry.miss]), [['scan filing.png', null]]);
  const shown = lines.filter((line) => line.source === 'vision' && line.kind === 'shown');
  assert.equal(shown.length, 1, 'one live line for the one read');
  assert.equal(shown[0].data.args.path, 'filing.png');
  assert.ok(shown[0].data.content.some((block) => block.type === 'image'));
  // Eyes that fail: the miss is kept with the look it belongs to.
  const failing = await run(t, {}, ['--json'], { DEMO_EYES: '1', DEMO_EYES_FAIL: '1' });
  const misses = readEvents(failing.recording).filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks).filter((entry) => entry.miss !== null);
  assert.ok(misses.length >= 1, 'a miss was kept');
  assert.ok(misses.every((entry) => entry.miss.code && entry.miss.reason && entry.record.facts.key));
});
test('the entry keeps every look and miss itself and calls a demo\'s own onLook and onMiss: it never replaces them', { timeout: 300_000 }, async (t) => {
  const { read } = { read: (dir) => { try { return readFileSync(join(dir, 'own-hooks.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } } };
  const filedOf = (recording) => readEvents(recording).filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks);
  const ok = await run(t, {}, ['--json'], { DEMO_EYES: '1', DEMO_OWN_HOOKS: '1' });
  assert.equal(ok.result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(read(ok.result.dir), ['look'], 'the demo\'s own onLook ran once for the one look');
  assert.equal(filedOf(ok.recording).length, 1, 'and the entry still kept the look');
  const failing = await run(t, {}, ['--json'], { DEMO_EYES: '1', DEMO_EYES_FAIL: '1', DEMO_OWN_HOOKS: '1' });
  assert.ok(read(failing.result.dir).includes('miss'), 'the demo\'s own onMiss ran');
  assert.ok(filedOf(failing.recording).some((entry) => entry.miss?.code), 'and the entry still kept the miss with its look');
});
// ---- the audit's five gaps (A2) -------------------------------------------------------------------------------------------------------------

test('Fakes.extensions are installed on a no-key run, and Fakes.vision is called with the host and the running run (its harness undefined until the run is open)', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-a2-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('@parcha/agentrun-harness');
  const place = await placeAt(join(tmp, 'run'));
  const probeExtension = { name: 'probe', tools: [] };
  const local = localHost(place, { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank', extensions: [probeExtension] });
  assert.deepEqual(local.host.tools.extensions, [probeExtension]);
  const { result } = await run(t, {}, ['--json'], { DEMO_VISION_PROBE: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(JSON.parse(readFileSync(join(result.dir, 'vision-called.json'), 'utf8')), { hasHost: true, harnessUndefinedAtBuild: true, input: { company: 'Acme Ltd' }, place: { root: result.dir, work: join(result.dir, 'work') } }, 'the third argument is the run\'s input (the job\'s own by default) and its place, as a tool sees it');
  // And the one the run was given: --input, on fakes and live alike (one seam).
  const given = await run(t, {}, ['--json', '--input', '{"company":"Gamma Ltd"}'], { DEMO_VISION_PROBE: '1' });
  assert.deepEqual(JSON.parse(readFileSync(join(given.result.dir, 'vision-called.json'), 'utf8')).input, { company: 'Gamma Ltd' });
});
test('a look is kept with the images of its own read: a read that produced no image finds none (not the previous read\'s), and a film window keeps only the frames inside it', async () => {
  const { shownShots } = await import('@parcha/agentrun-harness');
  const shown = shownShots();
  const afterTool = shown.extension.hooks[0].handlers.afterTool;
  const png = (text) => ({ type: 'image', data: Buffer.from(text).toString('base64'), mimeType: 'image/png' });
  const record = (path, args = {}) => ({ args: { path, model: 'm', native: false, ...args }, status: 'ok', facts: { key: 'k' } });
  await afterTool({ id: '1', name: 'read', arguments: { path: 'a.png' } }, { output: [png('A')], details: { evidence: 'evidence/a.json' } }, { conversationId: 7 });
  await afterTool({ id: '2', name: 'read', arguments: { path: 'b.png' } }, { output: [{ type: 'text', text: 'the file is gone' }], details: {} }, { conversationId: 7 });
  assert.equal(shown.of('7', record('b.png'), 'read'), undefined, 'the failed read finds no images, not a.png\'s');
  assert.equal(shown.of('7', record('a.png'), 'read').images.length, 1);
  assert.equal(shown.of('7', record('a.png'), 'read').receipt, 'evidence/a.json');
  await afterTool({ id: '3', name: 'read', arguments: { path: 'film.webm' } }, { output: [{ type: 'text', text: 'Frame at 1 s.' }, png('F1'), { type: 'text', text: 'Frame at 9 s.' }, png('F9')], details: {} }, { conversationId: 7 });
  assert.deepEqual(shown.of('7', record('film.webm', { from_s: 0, to_s: 5 }), 'read').images.map((image) => image.at), [1], 'only the frame inside the window');
  assert.deepEqual(shown.of('7', record('film.webm', { from_s: 5, to_s: 10 }), 'read').images.map((image) => image.at), [9]);
  // A screenshot is found as the newest of its tool.
  await afterTool({ id: '4', name: 'screenshot', arguments: {} }, { output: [png('S')], details: { evidence: 'evidence/shot.json' } }, { conversationId: 7 });
  assert.equal(shown.of('7', record('a screenshot result'), 'screenshot').images.length, 1);
});
test('a screenshot look, which the evidence sink does not file, takes the vision.filing and vision.filed crossings around its own keeping, and a hold parks it; a look the sink filed has had them already', async () => {
  const { aroundOwnFiling } = await import('../packages/harness/dist/crossings.js');
  const events = [];
  const cross = Object.assign((point) => { events.push(point); return false; }, { park: (point) => { events.push(`park ${point}`); return undefined; } });
  await aroundOwnFiling(cross, { receipt: null }, async () => { events.push('keep'); });
  assert.deepEqual(events, ['vision.filing', 'park vision.filing', 'keep', 'vision.filed'], 'around the screenshot look\'s own keeping');
  events.length = 0;
  await aroundOwnFiling(cross, { receipt: 'evidence/look-1.json' }, async () => { events.push('keep'); });
  assert.deepEqual(events, ['keep'], 'a look the sink filed is not crossed twice');
  // A parked filing never keeps the look: the hold waits for the kill.
  events.length = 0;
  const parkedForever = Object.assign((point) => { events.push(point); return false; }, { park: () => new Promise(() => {}) });
  let kept = false;
  void aroundOwnFiling(parkedForever, { receipt: null }, async () => { kept = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(kept, false);
});
// ---- code mode ---------------------------------------------------------------------------------------------------------------------------------

test('code mode is off by default; on, the agent\'s `code` tool runs a script whose bash runs in work/, whose vision.see is the composed handle\'s, and which reaches nothing else', { timeout: 300_000 }, async (t) => {
  // The script writes what it saw into work/ through its own bash: the proof is a file the run\'s environment made.
  const script = [
    'const ran = await tools.bash({ command: "echo hello > proof.txt; pwd > where.txt; echo $?" });',
    'const reach = [typeof fetch, typeof process, typeof require, typeof WebAssembly, typeof setTimeout, typeof vision.see].join(",");',
    'await tools.bash({ command: "printf %s " + JSON.stringify(reach) + " > reach.txt" });',
    'text("ran " + JSON.stringify(ran.trim()));',
    'return ran;',
  ].join('\n');
  const on = await run(t, {}, ['--json'], { DEMO_CODE: script, DEMO_CODE_ON: '1' });
  assert.equal(on.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(on.result.processes.at(-1)));
  const work = join(on.result.dir, 'work');
  assert.equal(readFileSync(join(work, 'proof.txt'), 'utf8').trim(), 'hello', 'bash ran, in work/');
  assert.equal(readFileSync(join(work, 'where.txt'), 'utf8').trim(), work, 'and its working directory is the run\'s work/');
  assert.equal(readFileSync(join(work, 'reach.txt'), 'utf8'), 'undefined,undefined,undefined,undefined,undefined,function', 'the sandbox has no fetch, process, require, WebAssembly or timers; vision.see is there');
  // Off: the same lead calls a tool that is not installed (the run may refuse for it), and nothing ran.
  const off = await run(t, {}, ['--json'], { DEMO_CODE: script, DEMO_CODE_ON: '' });
  assert.ok(!existsSync(join(off.result.dir, 'work', 'proof.txt')), 'off by default');
  // demo.json\'s codeMode is the same switch.
  const spec = await run(t, { codeMode: true }, ['--json'], { DEMO_CODE: script, DEMO_CODE_ON: '' });
  assert.equal(readFileSync(join(spec.result.dir, 'work', 'proof.txt'), 'utf8').trim(), 'hello');
});
test('code mode: a command\'s output is clipped while it streams (head kept, the rest counted), a command stops with its script, and the tool\'s description carries the declaration of vision.see', { timeout: 300_000 }, async (t) => {
  // Output: 100000 characters from one command; the script is given the first 100 and a count of the rest.
  const loud = ['const ran = await tools.bash({ command: "head -c 100000 /dev/zero | tr \'\\\\0\' x" });', 'await tools.bash({ command: "printf %s " + JSON.stringify(ran) + " > out.txt" });', 'return ran.length;'].join('\n');
  const clipped = await run(t, { codeMode: { outputChars: 100 } }, ['--json'], { DEMO_CODE: loud, DEMO_CODE_ON: '' });
  const out = readFileSync(join(clipped.result.dir, 'work', 'out.txt'), 'utf8');
  assert.ok(out.startsWith('x'.repeat(100)) && out.includes('[99900 more characters not shown]') && out.length < 200, `the script got the head and a count: ${out.slice(0, 160)}`);
  // Cancellation: the script's deadline passes while a command is sleeping; the command does not go on to write its file.
  const slow = 'await tools.bash({ command: "sleep 4; echo late > late.txt" }); return 1;';
  const cut = await run(t, { codeMode: { timeoutMs: 1500 } }, ['--json'], { DEMO_CODE: slow, DEMO_CODE_ON: '' });
  await new Promise((resolve) => setTimeout(resolve, 6000));
  assert.ok(!existsSync(join(cut.result.dir, 'work', 'late.txt')), 'the command stopped with its script');
  // The declaration the model reads is in the tool\'s description.
  const { codeModeExtension } = await import('../packages/harness/dist/code-mode.js');
  const tool = codeModeExtension({ see: () => ({ signature: '(request: { ask: string }): Promise<{ text: string }>', description: 'Ask the eyes about images.' }), judge: () => ({ signature: '(request: J): Promise<K>', description: 'Ask Jev.' }), transcribe: () => ({ signature: '(request: T): Promise<W>', description: 'Write what is said.' }) }, {}).tools[0];
  assert.match(tool.description, /vision\.see` is declared as `\(request: \{ ask: string \}\): Promise<\{ text: string \}>`: Ask the eyes about images\./);
});
test('code mode\'s tools.bash resolves the output string for a zero exit, and rejects for a non-zero exit with an Error that names the exit code and holds the output', { timeout: 300_000 }, async (t) => {
  const script = [
    'const ok = await tools.bash({ command: "echo fine" });',
    'let failed;',
    'try { await tools.bash({ command: "echo partial; echo oops 1>&2; exit 3" }); } catch (error) { failed = { message: String(error.message) }; }',
    'await tools.bash({ command: "printf %s \'" + JSON.stringify({ ok, failed }) + "\' > contract.json" });',
    'return typeof ok;',
  ].join('\n');
  const { result } = await run(t, { codeMode: true }, ['--json'], { DEMO_CODE: script, DEMO_CODE_ON: '' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const { ok, failed } = JSON.parse(readFileSync(join(result.dir, 'work', 'contract.json'), 'utf8'));
  assert.equal(ok, 'fine\n', 'a zero exit resolves the output as a string');
  assert.match(failed.message, /^the command exited with code 3:\n/, 'a non-zero exit rejects, and the message names its exit code');
  assert.ok(failed.message.includes('partial') && failed.message.includes('oops'), `and holds its output, stdout and stderr: ${JSON.stringify(failed)}`);
});
test('code mode: vision.judge answers through the host\'s judge seam (counted against its cap, priced, with a receipt), the declaration is in the tool\'s description, and the sandbox still has no fetch, process, require, WebAssembly or timers', { timeout: 300_000 }, async (t) => {
  const { deflateSync } = await import('node:zlib');
  // A solid 320 x 320 PNG, made here (Jev's images are at least 280 px a side).
  const crc = (bytes) => { let c = ~0; for (const byte of bytes) { c ^= byte; for (let bit = 0; bit < 8; bit += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(8 + data.length + 4); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(320, 0); header.writeUInt32BE(320, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(320 * 3, 200)]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 320 }, () => row)))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  const script = [
    `await tools.bash({ command: "printf %s ${png} | base64 -d > a.png" });`,
    'const reach = [typeof fetch, typeof process, typeof require, typeof WebAssembly, typeof setTimeout, typeof vision.see, typeof vision.judge].join(",");',
    'await tools.bash({ command: "printf %s " + JSON.stringify(reach) + " > reach.txt" });',
    'const judged = await vision.judge({ paths: ["a.png"], questions: { q: { type: "noul", instructions: "Is the image plain?" } } });',
    'const seen = await vision.see({ ask: "What is in the image?", paths: ["a.png"] });',
    'await tools.bash({ command: "cp a.png b.png" });',
    'await vision.judge({ paths: ["a.png", "b.png"], fragments: ["a.png#page=1", "b.png#page=2"], questions: { q: { type: "noul", instructions: "Are the images the same?" } } });',
    "await tools.bash({ command: \"printf %s '\" + JSON.stringify(judged) + \"' > judged.json\" });",
    'return judged.costUsd;',
  ].join('\n');
  const { result, recording } = await run(t, { codeMode: true }, ['--json'], { DEMO_CODE: script, DEMO_CODE_ON: '', DEMO_EYES: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const work = join(result.dir, 'work');
  assert.equal(readFileSync(join(work, 'reach.txt'), 'utf8'), 'undefined,undefined,undefined,undefined,undefined,function,function', 'the sandbox has no fetch, process, require, WebAssembly or timers; vision.see and vision.judge are there');
  const judged = JSON.parse(readFileSync(join(work, 'judged.json'), 'utf8'));
  assert.equal(judged.answers.q.noul, 0.92, 'the host\'s judge answered');
  assert.ok(judged.receipts.length >= 1 && typeof judged.costUsd === 'number', 'a receipt, and a price that is a number');
  // Every look a code-mode script made carries its picture as a blob: the look is filed with the images the eyes were shown, whichever tool held them.
  const looks = readEvents(recording).filter((line) => line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks).filter((look) => look.record.args.path === 'a.png');
  assert.ok(looks.length >= 2, `a see look and a judge look are filed: ${looks.length}`);
  for (const look of looks) assert.ok(look.images.length >= 1 && look.images.every((image) => /^[0-9a-f]{64}$/.test(image.blob)), `the look carries its picture: ${JSON.stringify(look.images)}`);
  // A judge over two images WITH fragments files one look named by both fragments, and carries both pictures, in the look's order.
  const two = readEvents(recording).filter((line) => line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks).filter((look) => look.record.args.path === 'a.png#page=1, b.png#page=2');
  assert.ok(two.length >= 1, `the two-image judge look is filed under its fragments: ${JSON.stringify(readEvents(recording).filter((line) => line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks).map((look) => look.record.args.path))}`);
  assert.equal(two[0].images.length, 2, 'both pictures');
  assert.ok(two[0].images.every((image) => /^[0-9a-f]{64}$/.test(image.blob)));
  // The description the model reads declares it.
  const { codeModeExtension } = await import('../packages/harness/dist/code-mode.js');
  const tool = codeModeExtension({ see: () => ({ signature: '(request: S): Promise<A>', description: 'Ask the eyes.' }), judge: () => ({ signature: '(request: J): Promise<K>', description: 'Ask Jev.' }), transcribe: () => ({ signature: '(request: T): Promise<W>', description: 'Write what is said.' }) }, {}).tools[0];
  assert.match(tool.description, /vision\.judge` is declared as `\(request: J\): Promise<K>`: Ask Jev\./);
});
test('code mode: vision.transcribe returns the words with times from the host\'s speech-to-text model, the look is filed priced as tool transcribe, and nothing key-shaped is in the sandbox', { timeout: 300_000 }, async (t) => {
  // A 2 s mono 8 kHz WAV of silence, made by the script's own bash from a 44-byte header (the faux lead types a script out at a fixed rate, so a script that carried the whole file would take minutes).
  const head = Buffer.alloc(44); head.write('RIFF', 0); head.writeUInt32LE(36 + 16000, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(8000, 24); head.writeUInt32LE(8000, 28); head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34); head.write('data', 36); head.writeUInt32LE(16000, 40);
  const octal = [...head].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
  const makeWav = `{ printf '${octal}'; head -c 16000 /dev/zero | tr '\\0' '\\200'; } > clip.wav`;
  const script = [
    `await tools.bash({ command: ${JSON.stringify(makeWav)} });`,
    'const reach = [typeof fetch, typeof process, typeof require, typeof WebAssembly, typeof setTimeout, typeof vision.transcribe].join(",");',
    'const heard = await vision.transcribe({ path: "clip.wav" });',
    'await tools.bash({ command: "printf %s \'" + JSON.stringify({ reach, heard, globals: Object.keys(globalThis).join(",") }) + "\' > heard.json" });',
    'return heard.text;',
  ].join('\n');
  const { result, recording } = await run(t, { codeMode: true }, ['--json'], { DEMO_CODE: script, DEMO_CODE_ON: '', DEMO_TRANSCRIBE: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const seen = JSON.parse(readFileSync(join(result.dir, 'work', 'heard.json'), 'utf8'));
  assert.equal(seen.reach, 'undefined,undefined,undefined,undefined,undefined,function');
  assert.deepEqual(seen.heard.words.map((word) => word.text), ['hello', 'world']);
  assert.equal(typeof seen.heard.costUsd, 'number', 'priced');
  assert.ok(!JSON.stringify(seen).includes('made-up-stt-key'), 'the key is not in the sandbox');
  const looks = readEvents(recording).filter((line) => line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks);
  assert.ok(looks.some((look) => look.record.tool === 'transcribe'), `a transcribe record is filed in vision.looks: ${JSON.stringify(looks.map((look) => look.record.tool))}`);
  assert.ok(!readFileSync(join(recording, 'events.jsonl'), 'utf8').includes('made-up-stt-key'), 'nor in the recording');
});
test('the host chooses the speech-to-text model from the keys its demo declares: a pass-through first, then fal, ElevenLabs, OpenAI; none set is no transcriber', async () => {
  const { transcriberFromEnv } = await import('../packages/harness/dist/transcriber.js');
  const pick = (env) => { const found = transcriberFromEnv(env); return found && `${found.provider}`; };
  assert.equal(pick({}), undefined);
  assert.match(pick({ FAL_KEY: 'k' }), /fal/);
  assert.match(pick({ ELEVENLABS_API_KEY: 'k' }), /eleven/i);
  assert.match(pick({ OPENAI_API_KEY: 'k' }), /openai/i);
  assert.match(pick({ TRANSCRIBE_BASE_URL: 'http://127.0.0.1:1', TRANSCRIBE_API_KEY: 'k', FAL_KEY: 'other' }), /fal/);
});

test('every node thinks: its own level, else low, never off', { timeout: 120_000 }, async (t) => {
  const { nodeAgent } = await import('../packages/harness/dist/assemble.js');
  const model = { id: 'lead' };
  assert.equal(nodeAgent(model, {}).thinkingLevel, 'low', 'a node with no thinking runs at low');
  assert.equal(nodeAgent(model, { thinking: 'high' }).thinkingLevel, 'high', 'a node\'s own level wins');
  assert.equal(nodeAgent(model, { thinking: 'off' }).thinkingLevel, 'low', 'thinking is never off, whatever a node carries');
  assert.equal(nodeAgent(model, {}).model, model);
  // In a run: the conversations the job's nodes open are recorded with the level they were given.
  const { recording } = await run(t, {}, ['--json']);
  const text = readFileSync(join(recording, 'events.jsonl'), 'utf8');
  assert.ok(/"thinkingLevel":"low"/.test(text), 'the recording shows a conversation at low');
  assert.ok(!/"thinkingLevel":"off"/.test(text), 'and none at off');
});
