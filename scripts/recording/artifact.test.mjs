// Draft 41: the run's artifact. The recorder takes `report/index.html` and its closure (packages/harness/src/artifact.ts), the validator and the gate refuse a page that loads
// outside its files or does what a page may not. The report folder is a real one (a take of the report skill, kept whole: a page, two frames, and links to a transcript the
// report does not hold); the refusals are hand-made pages.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { artifactProblems, readFile, takeArtifact } from '../../packages/harness/src/artifact.ts';
import { gateProblems } from './gate.mjs';
import { validateRecording } from './validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = (t, prefix = 'artifact-test-') => { const dir = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const write = (root, path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
/** A report folder from `files` (path -> text or bytes). */
const report = (t, files) => { const dir = scratch(t, 'report-test-'); for (const [path, bytes] of Object.entries(files)) write(dir, path, bytes); return dir; };
const PNG = Buffer.from('a picture, as far as the recorder can tell');
/** takeArtifact into a map, the way keepBlob would name it. */
const take = (dir) => { const kept = new Map(); const artifact = takeArtifact(dir, (bytes, extension) => { const hash = sha(bytes); kept.set(hash, { bytes, extension }); return hash; }, 'A fallback title'); return { artifact, kept }; };

/** A finished recording (the midstream-kill fixture) with `artifact` in its manifest and its blobs beside it, and the look keys `looks` filed by a live line. */
const recordingWith = (t, { artifact, kept, looks = [], extra = {} }) => {
  const dir = scratch(t, 'recording-test-');
  cpSync(join(here, 'fixtures', 'midstream-kill'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ...(artifact ? { artifact } : {}), ...extra }));
  for (const [hash, { bytes, extension }] of kept) write(dir, `blobs/${hash}.${extension}`, bytes);
  if (looks.length) {
    const lines = looks.map((key, index) => JSON.stringify({ channel: 'live', source: 'vision', kind: 'LookEvent', gen: 2, t: 6200 + index, seq: 100_000 + index, data: { record: { args: { path: 'transcript-tec.pdf#page=379' }, facts: { key } } } }));
    writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl'), 'utf8') + lines.join('\n') + '\n');
  }
  return dir;
};
const problems = (dir) => validateRecording(dir).map((each) => each.message);

test('a real report folder is taken whole: the page, the two frames it shows, and not the transcript it only links to', (t) => {
  const { artifact, kept } = take(join(here, 'fixtures', 'report-first-step'));
  assert.equal(artifact.entry, 'index.html');
  assert.deepEqual(Object.keys(artifact.files).sort(), ['frames/quote-close.jpg', 'frames/transcript-p379.jpg', 'index.html']);
  assert.ok(artifact.title.length > 0 && artifact.title !== 'A fallback title', 'the title is the page\'s own');
  for (const [path, hash] of Object.entries(artifact.files)) assert.equal(hash, sha(readFileSync(join(here, 'fixtures', 'report-first-step', path))), `${path} is recorded byte for byte`);
  const keys = [...readFile('index.html', readFileSync(join(here, 'fixtures', 'report-first-step', 'index.html'), 'utf8')).looks];
  assert.ok(keys.length >= 2, 'the page cites looks');
  const dir = recordingWith(t, { artifact, kept, looks: [...new Set(keys)] });
  assert.deepEqual(problems(dir), [], 'it records and validates');
  assert.deepEqual(gateProblemsOf(t, dir), []);
});

test('a data-look that names no look the run filed is refused', (t) => {
  const { artifact, kept } = take(join(here, 'fixtures', 'report-first-step'));
  const dir = recordingWith(t, { artifact, kept, looks: [] });
  const found = problems(dir);
  assert.ok(found.some((message) => /cites look "[0-9a-f]+".*did not file/.test(message)), found.join('\n'));
});

/** The gate over a one-recording gallery built from `dir`. */
function gateProblemsOf(t, dir) {
  const dist = scratch(t, 'gate-test-');
  cpSync(dir, join(dist, 'recordings', 'one'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  writeFileSync(join(dist, 'gallery.js'), "window.AGENTRUN_GALLERY_INDEX = 'recordings/index.json';\n");
  const held = Object.fromEntries(readdirSync(join(dir, 'blobs')).map((name) => [name.split('.')[0], `blobs/${name}`]));
  writeFileSync(join(dist, 'recordings', 'index.json'), JSON.stringify([{ id: 'one', manifest, blobs: held }]));
  return gateProblems(dist).map((each) => `${each.path}: ${each.message}`);
}
const PAGE = (body, head = '') => `<!doctype html><html><head><title>A page</title>${head}</head><body>${body}</body></html>`;

test('each thing a page may not do is refused by the recorder, and by the validator on a recording that holds it', (t) => {
  const refusals = {
    'a script': [PAGE('<script>alert(1)</script>'), /has a <script>/],
    'an inline script on an element': [PAGE('<p onclick="x()">hi</p>'), /has the onclick attribute/],
    'an on* attribute in any case': [PAGE('<img src="a.png" ONERROR="x()">'), /has the onerror attribute/],
    'a data: URL': [PAGE('<img src="data:image/png;base64,AAAA">'), /a data: URL/],
    'a javascript: link': [PAGE('<a href="javascript:x()">go</a>'), /javascript: URL/],
    'an iframe': [PAGE('<iframe src="a.html"></iframe>'), /has a <iframe>/],
    'an object': [PAGE('<object data="a.png"></object>'), /has a <object>/],
    'an embed': [PAGE('<embed src="a.png">'), /has a <embed>/],
    'a form': [PAGE('<form action="a.html"><input></form>'), /has a <form>/],
    'a base': [PAGE('', '<base href="https://elsewhere.example/">'), /has a <base>/],
    'a meta refresh': [PAGE('', '<meta http-equiv="Refresh" content="0; url=a.html">'), /has a meta refresh/],
    'a picture from a site': [PAGE('<img src="https://elsewhere.example/a.png">'), /loads https:\/\/elsewhere.example\/a.png from outside/],
    'a srcset candidate from a site': [PAGE('<img src="a.png" srcset="a.png 1x, //elsewhere.example/b.png 2x">'), /srcset loads \/\/elsewhere.example\/b.png/],
    'a stylesheet from a site': [PAGE('', '<link rel="stylesheet" href="https://elsewhere.example/a.css">'), /loads https:\/\/elsewhere.example\/a.css/],
    'a style block\'s url() from a site': [PAGE('', '<style>body { background: url(https://elsewhere.example/a.png) }</style>'), /loads https:\/\/elsewhere.example\/a.png/],
    'a style attribute\'s url() with a data: URL': [PAGE('<p style="background:url(\'data:image/png;base64,AAAA\')">x</p>'), /a data: URL/],
    'an absolute path': [PAGE('<img src="/etc/passwd.png">'), /absolute path/],
    'a path that leaves the folder': [PAGE('<img src="../outside.png">'), /leaves the artifact/],
    'a file that is not there': [PAGE('<img src="missing.png">'), /missing.png is reached by the page and is not in report\//],
  };
  for (const [what, [html, message]] of Object.entries(refusals)) {
    const dir = report(t, { 'index.html': html });
    assert.throws(() => take(dir), message, `the recorder refuses ${what}`);
    // The validator reads the same page from a recording that holds it (a page an older recorder wrote).
    if (/not there/.test(what)) continue;
    const bytes = Buffer.from(html);
    const hash = sha(bytes);
    const found = problems(recordingWith(t, { artifact: { title: 'A page', entry: 'index.html', files: { 'index.html': hash } }, kept: new Map([[hash, { bytes, extension: 'html' }]]) }));
    assert.ok(found.some((each) => message.test(each)), `the validator refuses ${what}: ${found.join(' | ')}`);
  }
});

test('the closure is followed through src, srcset, a stylesheet and its url(), a poster, and a link to another page of the report; a leftover nothing reaches is dropped', (t) => {
  const dir = report(t, {
    'index.html': PAGE('<img src="img/a.png" srcset="img/a.png 1x, img/b.png 2x"><video poster="img/p.png" src="clip/c.mp4"></video><a href="items/3.html#row">three</a><a href="https://example.org/out">out</a><a href="#top">top</a>', '<link rel="stylesheet" href="css/site.css">'),
    'css/site.css': '@import "base.css"; body { background: url("../img/bg.png") } /* url(ignored.png) */',
    'css/base.css': 'p { background: url(font-free.png) }',
    'css/font-free.png': PNG,
    'items/3.html': PAGE('<img src="../img/c.png"><a href="../index.html">back</a>'),
    'img/a.png': PNG, 'img/b.png': Buffer.from('b'), 'img/p.png': Buffer.from('p'), 'img/bg.png': Buffer.from('bg'), 'img/c.png': Buffer.from('c'),
    'clip/c.mp4': Buffer.from('a clip'),
    // What an attempt that was killed wrote and the final page no longer shows:
    'img/leftover.png': Buffer.from('left over'), 'draft.html': PAGE('<script>never</script>'),
  });
  const { artifact, kept } = take(dir);
  assert.deepEqual(Object.keys(artifact.files).sort(), ['clip/c.mp4', 'css/base.css', 'css/font-free.png', 'css/site.css', 'img/a.png', 'img/b.png', 'img/bg.png', 'img/c.png', 'img/p.png', 'index.html', 'items/3.html']);
  assert.ok(![...kept.values()].some(({ bytes }) => bytes.toString() === 'left over'), 'the leftover was not kept');
  assert.deepEqual(problems(recordingWith(t, { artifact, kept })), []);
});

test('a file that is a link out of the folder is refused, not followed', (t) => {
  const outside = scratch(t, 'outside-');
  write(outside, 'secret.png', PNG);
  const dir = report(t, { 'index.html': PAGE('<img src="pic.png">') });
  symlinkSync(join(outside, 'secret.png'), join(dir, 'pic.png'));
  assert.throws(() => take(dir), /pic.png is not a file inside report\//);
});

test('a folder with no index.html has no artifact', (t) => {
  assert.equal(take(report(t, { 'other.html': PAGE('') })).artifact, undefined);
});

test('the validator checks the artifact\'s shape: entry, paths, hashes, blobs, extensions', (t) => {
  const bytes = Buffer.from(PAGE('<p>hi</p>'));
  const hash = sha(bytes);
  const good = { title: 'A page', entry: 'index.html', files: { 'index.html': hash } };
  const kept = new Map([[hash, { bytes, extension: 'html' }]]);
  assert.deepEqual(problems(recordingWith(t, { artifact: good, kept })), []);
  const shape = {
    'an entry that is not in files': [{ ...good, entry: 'other.html' }, /entry other.html is not in files/],
    'an entry that is not html': [{ ...good, entry: 'index.png', files: { 'index.png': hash } }, /entry is not a path ending in .html/],
    'a path with ..': [{ ...good, files: { 'index.html': hash, '../x.png': hash } }, /has an empty, "." or ".." part/],
    'a leading slash': [{ ...good, files: { 'index.html': hash, '/x.png': hash } }, /is absolute/],
    'a backslash': [{ ...good, files: { 'index.html': hash, 'a\\b.png': hash } }, /has a backslash/],
    'a scheme': [{ ...good, files: { 'index.html': hash, 'https://x.png': hash } }, /has a scheme/],
    'two paths that differ only in case': [{ ...good, files: { 'index.html': hash, 'A.png': hash, 'a.png': hash } }, /one path ignoring case/],
    'a hash that is not a SHA-256': [{ ...good, files: { 'index.html': 'abc' } }, /no 64-hex SHA-256/],
    'a blob that is not there': [{ ...good, files: { 'index.html': hash, 'gone.png': 'f'.repeat(64) } }, /not in blobs\//],
    'a blob with another extension than its path': [{ ...good, files: { 'index.html': hash, 'pic.png': hash } }, /needs blob [0-9a-f]+\.png, which is not in blobs\//],
  };
  for (const [what, [artifact, message]] of Object.entries(shape)) {
    const found = problems(recordingWith(t, { artifact, kept }));
    assert.ok(found.some((each) => message.test(each)), `${what}: ${found.join(' | ')}`);
  }
  assert.deepEqual(artifactProblems({ title: '', entry: 'index.html', files: { 'index.html': hash } }), ['artifact.title is not a non-empty string']);
  const tampered = recordingWith(t, { artifact: good, kept });
  writeFileSync(join(tampered, 'blobs', `${hash}.html`), PAGE('<p>changed</p>'));
  assert.ok(problems(tampered).some((each) => /does not hash to its name/.test(each)));
});

test('the gate repeats the machine-path scan on a binary blob of the report', (t) => {
  const page = Buffer.from(PAGE('<img src="pic.png">'));
  const picture = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), Buffer.from(['', 'home', 'someone', 'work', 'pic.png'].join('/')), Buffer.from([3, 4])]);
  const files = { 'index.html': sha(page), 'pic.png': sha(picture) };
  const kept = new Map([[sha(page), { bytes: page, extension: 'html' }], [sha(picture), { bytes: picture, extension: 'png' }]]);
  const dir = recordingWith(t, { artifact: { title: 'A page', entry: 'index.html', files }, kept });
  assert.deepEqual(problems(dir), [], 'the validator reads text; the bytes of a picture are the gate\'s to scan');
  assert.ok(gateProblemsOf(t, dir).some((each) => /blobs\/[0-9a-f]+\.png: contains a machine path/.test(each)), 'the gate refuses it');
});

test('what a browser reads is read here: an embedded tab in a scheme, escaped CSS, and every attribute that loads', (t) => {
  const refused = {
    'a javascript: link with an embedded tab': [PAGE('<a href="java&#x09;script:alert(1)">go</a>'), /javascript: URL/],
    'a javascript: link with a newline and a leading space': [PAGE('<a href=" \njava\nscript:alert(1)">go</a>'), /javascript: URL/],
    'an escaped url( in a style attribute': [PAGE('<p style="background:u\\72l(https://elsewhere.example/p.png)">x</p>'), /loads https:\/\/elsewhere.example\/p.png/],
    'an escaped url( in a style block': [PAGE('', '<style>p { background: \\75rl(https://elsewhere.example/p.png) }</style>'), /loads https:\/\/elsewhere.example\/p.png/],
    'a comment inside url': [PAGE('', '<style>p { background: url(https:/**/\n//elsewhere.example/p.png) }</style>'), /loads/],
    'an image-set from a site': [PAGE('<p style="background-image:image-set(\'https://elsewhere.example/p.png\' 1x)">x</p>'), /loads https:\/\/elsewhere.example\/p.png/],
    'a body background': [PAGE('', '').replace('<body>', '<body background="https://elsewhere.example/p.png">'), /body background loads https:\/\/elsewhere.example\/p.png/],
    'an imagesrcset on a preload': [PAGE('', '<link rel="preload" as="image" imagesrcset="https://elsewhere.example/p.png 1x">'), /imagesrcset loads https:\/\/elsewhere.example\/p.png/],
    'a ping': [PAGE('<a href="#x" ping="https://elsewhere.example/p">x</a>'), /a ping loads https:\/\/elsewhere.example\/p/],
  };
  for (const [what, [html, message]] of Object.entries(refused)) assert.throws(() => take(report(t, { 'index.html': html })), message, what);
  // image-set candidates are files; the type() beside one is a MIME string, not a file.
  const { artifact: set } = take(report(t, { 'index.html': PAGE('<p style="background-image:image-set(\'a.avif\' type(\'image/avif\') 1x, \'a.png\' type(\'image/png\') 2x)">x</p>'), 'a.avif': PNG, 'a.png': Buffer.from('png') }));
  assert.deepEqual(Object.keys(set.files).sort(), ['a.avif', 'a.png', 'index.html']);
  // A local file named through an escaped url() is followed, not missed.
  const { artifact } = take(report(t, { 'index.html': PAGE('<p style="background:u\\72l(img/a.png)">x</p>'), 'img/a.png': PNG }));
  assert.deepEqual(Object.keys(artifact.files).sort(), ['img/a.png', 'index.html']);
});

test('a link to a document beside the report is kept as written only when it cites the look that read it; any other link outside the report is refused by the validator', (t) => {
  const cited = (look, href) => Buffer.from(PAGE(`<a href="${href}" data-look="${look}">the document</a>`));
  const key = 'a'.repeat(64);
  const record = (page) => { const hash = sha(page); return recordingWith(t, { artifact: { title: 'A page', entry: 'index.html', files: { 'index.html': hash } }, kept: new Map([[hash, { bytes: page, extension: 'html' }]]), looks: [key] }); };
  // The recorder takes the page and leaves the link alone, whether or not it cites a look; the validator is the one that decides.
  assert.ok(take(report(t, { 'index.html': cited(key, '../film.mp4#t=5') })).artifact);
  assert.deepEqual(problems(record(cited(key, 'transcript-tec.pdf#page=379'))), [], 'the look read transcript-tec.pdf');
  assert.ok(problems(record(cited(key, 'another.pdf#page=1'))).some((each) => /another.pdf, which is not in files and is not the file of a look it cites/.test(each)));
  assert.ok(problems(record(Buffer.from(PAGE('<a href="transcript-tec.pdf">no look</a>')))).some((each) => /transcript-tec.pdf, which is not in files/.test(each)));
  assert.deepEqual(problems(record(Buffer.from(PAGE('<a href="https://example.org/out">out</a><a href="#top">top</a>')))), [], 'a link to a site loads nothing');
});

test('two paths with one content and two extensions are two blobs, and both validate', (t) => {
  const a = Buffer.from('one picture');
  const page = Buffer.from(PAGE('<img src="a.jpg"><img src="b.jpeg">'));
  const files = { 'index.html': sha(page), 'a.jpg': sha(a), 'b.jpeg': sha(a) };
  const kept = new Map([[sha(page), { bytes: page, extension: 'html' }], [`${sha(a)}`, { bytes: a, extension: 'jpg' }]]);
  const dir = recordingWith(t, { artifact: { title: 'A page', entry: 'index.html', files }, kept });
  writeFileSync(join(dir, 'blobs', `${sha(a)}.jpeg`), a);
  assert.deepEqual(problems(dir), []);
});
