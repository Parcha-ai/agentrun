// A scan of a finished recording before it goes anywhere: no machine path, no private endpoint, no credential-shaped value, no URL that carries a
// browser session's signing key, and none of the exact secrets or addresses this run was given (the model gateway's address and credential, the
// browser provider's key and project, a provider key, this machine's name). It reads every text file of the directory and reports where a hit is and
// what kind it is, never the content. A hit is fixed where the line is written, never by editing the recording.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';

/** The shapes `scripts/verify-packages.mjs` refuses in a published package, and the browser provider's signed connect URLs. */
const FORBID: Array<[string, RegExp]> = [
  ['machine-specific path', /(?:\/(?:home|Users)\/[^/\s"']+\/|[A-Za-z]:\\Users\\[^\\\s"']+\\)/],
  ['private service endpoint', /https?:\/\/(?:localhost\b|127\.\d+\.\d+\.\d+\b|10\.\d+\.\d+\.\d+\b|192\.168\.\d+\.\d+\b|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+\b|169\.254\.\d+\.\d+\b|[a-z0-9.-]+\.(?:internal|local|localhost)\b)/i],
  ['embedded credential value', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][A-Za-z0-9_./+=-]{24,}["']/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider secret', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{30,}\b/],
  ['credential URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['signed connect URL', /wss?:\/\/[^\s"']*(?:signingKey|apiKey|token)=/i],
  ['bearer secret', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
];

/** The environment variables whose values must not be in a recording, and the ones whose values are addresses. */
const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'BROWSERBASE_BASE_URL', 'AUDIT_MODEL_API_KEY', 'AUDIT_MODEL_BASE_URL'];

export type Leak = { file: string; kind: string };

const TEXT = /\.(?:jsonl?|txt|html?|md|log|svg|csv)$/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const at = join(dir, name);
    return statSync(at).isDirectory() ? files(at) : [at];
  });
}

/** `extra` names more literals to refuse (a host's names, an address), each a string of at least 4 characters. */
export function scanRecording(dir: string, env: NodeJS.ProcessEnv = process.env, extra: string[] = []): Leak[] {
  const literals: Array<[string, string]> = [
    ...SECRET_NAMES.flatMap((name) => (env[name] && env[name]!.length >= 8 ? [[`the value of ${name}`, env[name]!] as [string, string]] : [])),
    ...[hostname(), ...extra, ...(env.AUDIT_SCAN_EXTRA ? env.AUDIT_SCAN_EXTRA.split(',') : [])].map((value) => value.trim()).filter((value) => value.length >= 4).map((value): [string, string] => ['a host name or address to keep out', value]),
  ];
  const leaks: Leak[] = [];
  for (const file of files(dir)) {
    if (!TEXT.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const where = relative(dir, file);
    for (const [kind, pattern] of FORBID) if (pattern.test(text)) leaks.push({ file: where, kind });
    for (const [kind, literal] of literals) if (text.includes(literal)) leaks.push({ file: where, kind });
  }
  return leaks;
}

if (import.meta.main) {
  const [dir, ...extra] = process.argv.slice(2);
  if (!dir) throw new Error('usage: scan.ts <recording dir> [literal to keep out]...');
  const leaks = scanRecording(dir, process.env, extra);
  console.log(leaks.length ? `${leaks.length} hit(s):\n${leaks.map((leak) => `  ${leak.file}: ${leak.kind}`).join('\n')}` : `clean: ${dir} holds nothing it should not`);
  if (leaks.length) process.exitCode = 1;
}
