// The console's design tokens are generated outside this repository and vendored: src/tokens.css with the vocabulary
// it was generated from (design-tokens/vocabulary.json). This proves the vendored pair is whole: the stylesheet's
// header names the SHA-256 of the vocabulary beside it and of its own text below the header, so a hand edit to either
// file, or a vocabulary from another generation, fails. Run by src/tokens.test.ts and scripts/check-generated.mjs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TOKENS_CSS = 'src/tokens.css';
export const VOCABULARY = 'design-tokens/vocabulary.json';
export const STYLES_CSS = 'src/styles.css';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const HEADER = /^\/\*[\s\S]*?vocabulary-sha256: ([0-9a-f]{64})\s+content-sha256: ([0-9a-f]{64}) \*\/\n/;

/** The custom properties a stylesheet declares, by name without the leading dashes. */
export function declaredProperties(css) {
  return new Set([...css.matchAll(/(?:^|[\s;{])--([a-z0-9-]+)\s*:/g)].map((match) => match[1]));
}

/** Every rule the vendored files break, one message each; an empty list means they are whole. */
export function checkTokenFiles({ tokensCss, vocabularyText, stylesCss }) {
  const header = HEADER.exec(tokensCss);
  if (!header) return [`${TOKENS_CSS} has no generated header with vocabulary-sha256 and content-sha256`];
  const errors = [];
  const [whole, vocabularyHash, contentHash] = header;
  if (sha256(vocabularyText) !== vocabularyHash) errors.push(`${VOCABULARY} is not the vocabulary ${TOKENS_CSS} was generated from`);
  if (sha256(tokensCss.slice(whole.length)) !== contentHash) errors.push(`${TOKENS_CSS} was edited after it was generated`);
  const { tokens } = JSON.parse(vocabularyText);
  for (const name of declaredProperties(tokensCss)) {
    if (!(name in tokens)) errors.push(`${TOKENS_CSS} declares --${name}, which the vocabulary does not name`);
  }
  for (const name of declaredProperties(stylesCss)) {
    if (name in tokens) errors.push(`${STYLES_CSS} declares the token --${name}; token values belong in ${TOKENS_CSS}`);
  }
  return errors;
}

/** The three files, read from a console directory (a path, or a file: URL ending in a slash). */
export function readTokenFiles(consoleDir) {
  const base = consoleDir instanceof URL ? consoleDir : pathToFileURL(`${consoleDir}/`);
  const read = (file) => readFileSync(new URL(file, base), 'utf8');
  return { tokensCss: read(TOKENS_CSS), vocabularyText: read(VOCABULARY), stylesCss: read(STYLES_CSS) };
}

/** checkTokenFiles over the files in a console directory. */
export function checkTokens(consoleDir) {
  return checkTokenFiles(readTokenFiles(consoleDir));
}
