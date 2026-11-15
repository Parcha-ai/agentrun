// The kernel's o200k_base count (src/host/o200k.ts), which the local input count is made of. It ships OpenAI's own
// vocabulary file, unchanged and checked by the sha256 tiktoken pins, and no tokenizer package: gpt-tokenizer (some 28 MB
// and 1,563 files installed, for the one encoding) is no dependency of any package. The counts below are gpt-tokenizer
// 4.1.2's (o200k_base countTokens, no special token allowed), which the kernel's count matched on 45,352 strings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { O200K_SHA256, O200K_VOCABULARY, o200kModel, o200kTokens } from '@parcha/agentrun-kernel/host';

const root = new URL('../../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test("no package depends on a tokenizer package: the kernel ships the one vocabulary it counts with", () => {
  for (const name of readdirSync(new URL('packages/', root))) {
    const at = new URL(`packages/${name}/package.json`, root);
    let manifest;
    try { manifest = JSON.parse(readFileSync(at, 'utf8')); } catch { continue; }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      assert.equal(manifest[field]?.['gpt-tokenizer'], undefined, `${name} ${field}`);
    }
  }
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
  assert.deepEqual(Object.keys(lock.packages).filter((path) => path.endsWith('node_modules/gpt-tokenizer')), [], 'nor is one installed');
});

test("the vocabulary is OpenAI's o200k_base file, unchanged (tiktoken's pinned sha256), packed with its license, under 4 MB", () => {
  assert.equal(O200K_SHA256, '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d');
  const vocabulary = readFileSync(O200K_VOCABULARY);
  assert.equal(createHash('sha256').update(vocabulary).digest('hex'), O200K_SHA256);
  assert.ok(statSync(O200K_VOCABULARY).size < 4_000_000, `${statSync(O200K_VOCABULARY).size} bytes`);
  assert.equal(vocabulary.toString('latin1').trimEnd().split('\n').length, 199_998, 'one line a rank');
  assert.ok(pkg.files.includes('vendor/o200k/o200k_base.tiktoken') && pkg.files.includes('vendor/o200k/LICENSE'), JSON.stringify(pkg.files));
  const license = readFileSync(new URL('../vendor/o200k/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Copyright \(c\) 2022 OpenAI, Shantanu Jain/);
  assert.match(license, /Copyright \(c\) 2023-2024 Bazyli Brzoska/);
  assert.match(readFileSync(new URL('../NOTICE', import.meta.url), 'utf8'), /vendor\/o200k\/LICENSE/);
});

test("it counts as gpt-tokenizer's o200k_base did: special tokens' spellings as text, Unicode 16's classes, long runs", async () => {
  const cases = [
    ['', 0],
    ['hello world', 2],
    ['<|endoftext|>', 7],
    ['Ünïcödé 日本語のテキスト 😀👨‍👩‍👧', 20],
    ["I've said it'S fine, they'LL go", 10],
    // Characters Unicode 17 moved into a letter or number class: counted as Unicode 16 classed them.
    ['aʕb ʕʕ 1౜2', 14],
    ['    indented\n\n\tcode();\r\n', 6],
    ['a'.repeat(10_000), 1_250],
    [JSON.stringify({ model: 'gpt-6.1-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look up the capital of France.' }] }] }), 42],
  ];
  for (const [text, tokens] of cases) assert.equal(await o200kTokens(text), tokens, JSON.stringify(text.slice(0, 60)));
});

test("the models it counts are o200k_base's", () => {
  assert.deepEqual(['gpt-6.1-sol', 'openai/gpt-6.1-sol', 'gpt-4o', 'o3', 'codex-mini', 'gpt-oss-120b'].map(o200kModel), [true, true, true, true, true, true]);
  assert.deepEqual(['gpt-4', 'gpt-3.5-turbo', 'claude-sonnet-5-5', 'anthropic/claude-opus-5-5', undefined].map(o200kModel), [false, false, false, false, false]);
});
