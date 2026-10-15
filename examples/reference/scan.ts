// The one scan for what a published recording must never hold: a credential's shape or a machine path. It lives here so a
// copied example keeps it: the recorder (record.ts) scans a recording before it finishes one, and the repository's
// validator and the hosted gallery's gate (scripts/recording/) import this same module.
import { readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';

/** The credential shapes the package check and the source export refuse (scripts/export-source.mjs), with the machine paths. */
export const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['machine path', /\/(?:home|Users)\/[A-Za-z0-9._-]+\//],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider secret', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{30,}\b/],
  ['aws access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential url', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['bearer secret', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  ['literal credential', /(?:api[_-]?key|password|access[_-]?token|auth[_-]?token|client[_-]?secret)['"]?\s*[=:]\s*['"][^'"\n]{8,}['"]/i],
  // A loopback or private-network endpoint: 127/8, 10/8, 172.16/12, 192.168/16 and link-local 169.254/16; ::1, fc00::/7 and
  // link-local fe80::/10. What a run reached on its own machine or network is not for publishing.
  ['private network address', /(?<![\d.])(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})(?!\d|\.\d)/],
  ['private network address', /(?<![0-9a-f:])(?:::1|f[cd][0-9a-f]{2}:(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}|fe[89ab][0-9a-f]:(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4})(?![0-9a-f:])/i],
];

/** What one run must never publish besides the shapes above, known only where it records: the exact values of the secret
 *  env vars its demo names, read from the environment at record time and held only in memory, and this machine's own
 *  host names. Each is named by what it is (`a secret (the value of NAME)`), never by its value. */
export type Exposure = { label: string; test: (text: string) => boolean };

/** The env names a demo's `demo.json` lists under `keys`, a `oneOf` group's members and arrays included: every one is a
 *  secret by nature. */
export function secretNamesOf(demo: unknown): string[] {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isObject(value)) return;
    if (typeof value.env === 'string') names.add(value.env);
    if (Array.isArray(value.oneOf)) walk(value.oneOf);
  };
  walk(isObject(demo) ? demo.keys : undefined);
  return [...names];
}

/** The exposures to scan a run's recording for: each named secret's value (one under 8 characters cannot be told from
 *  ordinary text, so it is not scanned for, and one line on stderr says which name, never its value), and this machine's
 *  host name and its first label (`localhost`, and a name under 4 characters, are not). */
export function exposuresOf(secretNames: readonly string[], { env = process.env, host = hostname(), warn = (line: string) => { process.stderr.write(`${line}\n`); } }:
  { env?: Record<string, string | undefined>; host?: string; warn?: (line: string) => void } = {}): Exposure[] {
  const out: Exposure[] = [];
  for (const name of new Set(secretNames)) {
    const value = env[name];
    if (!value) continue;
    if (value.length < 8) { warn(`record: ${name} is under 8 characters, too short to scan a recording for; its value is not checked`); continue; }
    out.push({ label: `secret (the value of ${name})`, test: (text) => text.includes(value) });
  }
  for (const name of new Set([host, host.split('.')[0]!])) {
    if (name.length < 4 || name.toLowerCase() === 'localhost') continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`, 'i');
    out.push({ label: 'host name of this machine', test: (text) => pattern.test(text) });
  }
  return out;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The first credential shape in a text, by name, then the first of a run's exposures, by its label. */
export const credentialIn = (text: string, exposures: readonly Exposure[] = []): string | undefined =>
  FORBIDDEN.find(([, pattern]) => pattern.test(text))?.[0] ?? exposures.find((exposure) => exposure.test(text))?.label;

/** The credential shape in any string or key of a decoded JSON value: the raw text can hide one behind an escape (`sk-`). */
export function credentialInValue(value: unknown, exposures: readonly Exposure[] = []): string | undefined {
  if (typeof value === 'string') return credentialIn(value, exposures);
  if (Array.isArray(value)) { for (const inner of value) { const found = credentialInValue(inner, exposures); if (found) return found; } return undefined; }
  if (isObject(value)) { for (const [key, inner] of Object.entries(value)) { const found = credentialIn(key, exposures) ?? credentialInValue(inner, exposures); if (found) return found; } }
  return undefined;
}

/** The files a scan reads as text, by extension; the others (images, video) are kept whole and not read. */
export const TEXT_FILE = /\.(?:json|jsonl|txt|md|html|csv|svg|xml|yaml|yml|log)$/i;

/** The credential shape in a file's text: raw, then decoded when the whole text is JSON, whatever its extension (an escape
 *  hides one in any text, `\u0073k-`); and, for JSON lines, each line decoded too, since a file of lines is not one JSON
 *  value. The validator checks every text file this same way. */
export function credentialInFile(name: string, text: string, exposures: readonly Exposure[] = []): string | undefined {
  const decoded = (part: string) => { try { return credentialInValue(JSON.parse(part), exposures); } catch { return undefined; } };
  const whole = credentialIn(text, exposures) ?? decoded(text);
  if (whole || !/\.jsonl$/i.test(name)) return whole;
  for (const line of text.split('\n')) { const found = line ? decoded(line) : undefined; if (found) return found; }
  return undefined;
}

/** Every credential shape in the text files of a recording directory, each `{ file, found }` with `file` relative to it.
 *  The recorder's own spool (`.spool/`) is its working copy, not the recording, and is skipped. */
export function scanRecording(dir: string, exposures: readonly Exposure[] = []): { file: string; found: string }[] {
  const out: { file: string; found: string }[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { if (!(at === dir && entry.name === '.spool')) walk(path); continue; }
      if (!TEXT_FILE.test(entry.name)) continue;
      const found = credentialInFile(entry.name, readFileSync(path, 'utf8'), exposures);
      if (found) out.push({ file: relative(dir, path), found });
    }
  };
  walk(dir);
  return out;
}
