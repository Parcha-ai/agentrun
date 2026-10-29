// The product is "Claude Agent": no shipped string, error, log tag, exported name, the package's README, changelog or
// metadata, or the repository's docs about it say "Claude Code". Comments in the copied files keep their upstream's
// factual wording (they describe that project's code), so the check reads the built code with its comments removed.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ts = createRequire(import.meta.url)('typescript');
const root = fileURLToPath(new URL('..', import.meta.url));
const BANNED = /claude[\s_-]*code(?![\s_-]*(?:20\d{6}|_preset))/i;
// API values the SDK and the CLI define, which the adapter must pass as they are: the system-prompt preset, the
// tool-use id's metadata key, the CLI's environment variables, its own beta flag, and the SDK's spawn and executable options.
const API_VALUES = /\bclaude_code\b|claudecode\/toolUseId|\bCLAUDE_CODE_[A-Z_]+|claude-code-20250219|claudeCodeVersion|spawnClaudeCodeProcess|pathToClaudeCodeExecutable/g;

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Every string and template text in a file of built code (its comments and identifiers are not text a user sees). */
function strings(code) {
  const out = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code);
  const text = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);
  // Inside a template's `${...}`: how many braces deep, per open template.
  const templates = [];
  // A `/` starts a regular expression unless it follows something an expression can end with.
  const ends = new Set([ts.SyntaxKind.Identifier, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.ThisKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken]);
  let previous;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.OpenBraceToken && templates.length) templates[templates.length - 1] += 1;
    else if (kind === ts.SyntaxKind.CloseBraceToken && templates.length) {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        kind = scanner.reScanTemplateToken(false);
      } else templates[templates.length - 1] -= 1;
    } else if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) && !ends.has(previous)) kind = scanner.reScanSlashToken();
    if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle) templates.push(0);
    if (text.has(kind)) out.push(scanner.getTokenValue());
    previous = kind;
  }
  return out;
}

test('no built string, error or log tag says "Claude Code"', () => {
  let seen = 0;
  for (const file of files(join(root, 'dist')).filter((f) => f.endsWith('.js'))) {
    for (const value of strings(readFileSync(file, 'utf8'))) {
      seen += 1;
      const found = value.replace(API_VALUES, '').match(BANNED);
      assert.equal(found, null, `${file.slice(root.length)}: ${JSON.stringify(value.slice(0, 160))}`);
    }
  }
  assert.ok(seen > 200, `the scan read the built strings (${seen})`);
});

test('no exported name says it either', async () => {
  for (const entry of ['dist/index.js', 'dist/testing/index.js']) {
    const names = Object.keys(await import(join(root, entry)));
    for (const name of names) assert.doesNotMatch(name, /claude.?code/i, `${entry} exports ${name}`);
  }
});

test("the package's README, changelog and metadata, and the repository's docs about it, say Claude Agent", () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const texts = {
    'README.md': readFileSync(join(root, 'README.md'), 'utf8'),
    'CHANGELOG.md': readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
    'package.json description and keywords': [manifest.description, ...(manifest.keywords ?? [])].join(' '),
    'changes/run-adapters-claude-agent.md': readFileSync(join(root, '../../changes/run-adapters-claude-agent.md'), 'utf8'),
  };
  for (const [where, text] of Object.entries(texts)) assert.equal(text.replace(API_VALUES, '').match(BANNED), null, where);
  assert.match(texts['README.md'], /Claude Agent/);
});
