// The one scan for what a published recording must never hold: a credential's shape or a machine path. It lives here so a
// copied example keeps it: the recorder (record.ts) scans a recording before it finishes one, and the repository's
// validator and the hosted gallery's gate (scripts/recording/) import this same module.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { hostname, networkInterfaces, userInfo } from 'node:os';
import { join, relative } from 'node:path';

/** The credential shapes a published recording must never hold, with the machine paths. The source export keeps its own
 *  list (scripts/export-source.mjs). Beyond the shapes every key has, a demo's key whose provider publishes a prefix has a
 *  shape of its own here, a backstop for the moment a run's tool result or a page carries the key itself. */
export const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['machine path', /\/(?:home|Users)\/[A-Za-z0-9._-]+\//],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['provider secret', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{30,}\b/],
  ['aws access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  // A signed JSON Web Token (a ChatGPT sign-in's access and id tokens are ones): a base64url JSON header and payload, each
  // starting `{"` (`eyJ`), and a signature.
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  // Browserbase (BROWSERBASE_API_KEY): its docs show a key as `bb_live_...`.
  ['browserbase api key', /\bbb_live_[A-Za-z0-9_-]{16,}/],
  ['credential url', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['bearer secret', /\bBearer\s+[A-Za-z0-9._-]{24,}/],
  ['literal credential', /(?:api[_-]?key|password|access[_-]?token|auth[_-]?token|client[_-]?secret)['"]?\s*[=:]\s*['"][^'"\n]{8,}['"]/i],
];

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The first credential shape in a text, by name. */
export const credentialIn = (text: string): string | undefined => FORBIDDEN.find(([, pattern]) => pattern.test(text))?.[0];

/** The credential shape in any string or key of a decoded JSON value: the raw text can hide one behind an escape (`sk-`). */
export function credentialInValue(value: unknown): string | undefined {
  if (typeof value === 'string') return credentialIn(value);
  if (Array.isArray(value)) { for (const inner of value) { const found = credentialInValue(inner); if (found) return found; } return undefined; }
  if (isObject(value)) { for (const [key, inner] of Object.entries(value)) { const found = credentialIn(key) ?? credentialInValue(inner); if (found) return found; } }
  return undefined;
}

/** The files a scan reads as text, by extension; the others (images, video) are kept whole and not read. */
export const TEXT_FILE = /\.(?:json|jsonl|txt|md|html|csv|svg|xml|yaml|yml|log)$/i;

/** The credential shape in a file's text: raw, then decoded when the whole text is JSON, whatever its extension (an escape
 *  hides one in any text, `\u0073k-`); and, for JSON lines, each line decoded too, since a file of lines is not one JSON
 *  value. The validator checks every text file this same way. */
export function credentialInFile(name: string, text: string): string | undefined {
  const decoded = (part: string) => { try { return credentialInValue(JSON.parse(part)); } catch { return undefined; } };
  const whole = credentialIn(text) ?? decoded(text);
  if (whole || !/\.jsonl$/i.test(name)) return whole;
  for (const line of text.split('\n')) { const found = line ? decoded(line) : undefined; if (found) return found; }
  return undefined;
}

/** Every credential shape in the text files of a recording directory, each `{ file, found }` with `file` relative to it.
 *  The recorder's own spool (`.spool/`) is its working copy, not the recording, and is skipped. */
export function scanRecording(dir: string): { file: string; found: string }[] {
  const out: { file: string; found: string }[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { if (!(at === dir && entry.name === '.spool')) walk(path); continue; }
      if (!TEXT_FILE.test(entry.name)) continue;
      const found = credentialInFile(entry.name, readFileSync(path, 'utf8'));
      if (found) out.push({ file: relative(dir, path), found });
    }
  };
  walk(dir);
  return out;
}

/** One of this machine's own values, and what it is. */
export type MachineValue = { kind: string; value: string };
const TAILNET = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

/** This machine's own values, read when asked and never written anywhere: its host name and the short form before the
 *  first dot, its boot id (Linux's `/proc/sys/kernel/random/boot_id`, macOS's `kern.bootsessionuuid`), its home
 *  directory, and each address it has in 100.64.0.0/10 (a tailnet's; the addresses, never the range). A recording or a
 *  fixture made here holds none of them. A short or generic value is not taken, since it would match ordinary text: a
 *  name under 4 characters or `localhost`, a boot id under 16, a home directory of `/`. */
export function machineValues(): MachineValue[] {
  const found: MachineValue[] = [];
  const add = (kind: string, value: string) => { if (!found.some((each) => each.value === value)) found.push({ kind, value }); };
  const name = hostname();
  for (const each of [name, name.split('.')[0] ?? '']) if (each.length >= 4 && each !== 'localhost') add('host name', each);
  let boot = '';
  try { boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { /* not Linux */ }
  if (!boot && process.platform === 'darwin') try { boot = execFileSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim(); } catch { /* no sysctl */ }
  if (boot.length >= 16) add('boot id', boot);
  try { const home = userInfo().homedir; if (home.length >= 4 && home !== '/') add('home directory', home); } catch { /* a user with no entry */ }
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) if (TAILNET.test(address.address)) add('tailnet address', address.address);
  return found;
}

const tokenChar = (char: string | undefined) => char !== undefined && /[A-Za-z0-9]/.test(char);
/** The kind of the first of `values` a text holds whole: never inside a longer name or number (`ns1` is not in `ns12`). */
export const machineValueIn = (text: string, values: readonly MachineValue[]): string | undefined =>
  values.find(({ value }) => {
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) if (!tokenChar(text[at - 1]) && !tokenChar(text[at + value.length])) return true;
    return false;
  })?.kind;
