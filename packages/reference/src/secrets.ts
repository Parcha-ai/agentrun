// The exact secret values a recording must not hold. A shape cannot catch a token (a refresh token is opaque), so the recorder is told the values: the values of the environment names a demo declares, and the sign-in's tokens
// in `auth.json` (`$AGENTRUN_HOME/auth.json`, else `~/.config/agentrun/auth.json`; one credential per provider, each `{ type: 'oauth', access, refresh, ... }` or `{ type: 'api_key', key }`). Every recorded line, text blob and the manifest has none of them, and
// a recording that still holds one is refused. A value is never printed: a finding names the key and the file only.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Redact } from './record.ts';
import { declaredEnv, type DemoSpec } from './demo-spec.ts';

/** A secret value and the name it is reported by (an environment name, or `<file> credentials.<provider>.<field>`). */
/** `whole`: a value that is also an ordinary word (a machine named `node`): it is redacted only as a whole token in text, never inside a JSON key or a word of the recording's format. */
export type Secret = { key: string; value: string; whole?: true };

/** The shortest value that counts as a secret: a short string is a word, and redacting it would damage the lines around it. */
const MIN = 12;
/** The credential fields that hold a secret string: an OAuth credential's tokens and an API-key credential's key (a user's own provider key has no shape). Never `expires`, an id, a scope list or any other non-secret field. */
const TOKEN_FIELDS = ['access', 'refresh', 'idToken', 'id_token', 'key'];

/** Where the sign-in keeps its tokens. */
export const signInFile = (env: NodeJS.ProcessEnv): string => join(resolve(env.AGENTRUN_HOME ?? join(homedir(), '.config', 'agentrun')), 'auth.json');

/** The sign-in's tokens. No file is fine (no sign-in); a file that cannot be read, or is not the sign-in's JSON, fails (the recording cannot be trusted to be clean). */
export function signInSecrets(file: string): Secret[] {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw new Error(`the sign-in file ${file} cannot be read (${(error as { code?: string }).code ?? 'unreadable'}): a recording cannot be checked against its tokens`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`the sign-in file ${file} is not JSON: a recording cannot be checked against its tokens`); }
  const credentials = (parsed as { credentials?: Record<string, Record<string, unknown>> } | null)?.credentials;
  if (!credentials || typeof credentials !== 'object') return [];
  const found: Secret[] = [];
  for (const [provider, credential] of Object.entries(credentials)) {
    if (!credential || typeof credential !== 'object') continue;
    for (const field of TOKEN_FIELDS) {
      const value = credential[field];
      if (typeof value === 'string' && value.length >= MIN) found.push({ key: `${file} credentials.${provider}.${field}`, value });
    }
  }
  return found;
}

/** Words the recording format itself is written in (its channels, sources, kinds and keys, and the values of its fixed fields): a host name that is one of them is not taken, because replacing it would rewrite the lines around it
 *  (a machine named `host` would turn every `"source":"host"` into `"source":"[redacted]"`). Such a name says nothing about the machine anyway. */
const RECORDING_WORDS = new Set(['host', 'node', 'workflow', 'process', 'kill', 'result', 'live', 'durable', 'workflow', 'browser', 'vision', 'transport', 'data', 'source', 'kind', 'channel', 'child', 'supervisor', 'run', 'status', 'point', 'label', 'side', 'null', 'true', 'false', 'blob', 'title', 'cost', 'model', 'done', 'failed', 'error', 'complete', 'revoke', 'delegation', 'receipt', 'localhost']);

/** This machine's own host name and boot id (where `/proc/sys/kernel/random/boot_id` exists): a recording shows labels for a holder's, never these. A short or generic name, or one of the recording's own words, is not taken (it would damage the lines around it). `name` is for a test. */
export function machineSecrets(name: string = hostname()): Secret[] {
  const found: Secret[] = [];
  if (name.length >= 4 && !RECORDING_WORDS.has(name.toLowerCase())) found.push({ key: 'this machine\'s host name', value: name, whole: true });
  try { const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); if (boot.length >= 16) found.push({ key: 'this machine\'s boot id', value: boot }); } catch { /* not a machine that has one */ }
  return found;
}

/** Everything a recording of `spec` must not hold: the values of the environment names it declares, the sign-in's tokens, and this machine's own host name and boot id. */
export function secretsOf(env: NodeJS.ProcessEnv, spec: DemoSpec, authFile: string = signInFile(env)): Secret[] {
  const found: Secret[] = [];
  for (const name of declaredEnv(spec)) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= MIN) found.push({ key: name, value });
  }
  return [...found, ...signInSecrets(authFile), ...machineSecrets()];
}

const escapeToken = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A value that is also a word: found only as a whole token (not inside a longer word, a dotted name or a path segment of the format) and not as a JSON key (`"node":`). */
const tokenOf = (value: string) => new RegExp(`(?<![\\w.-])${escapeToken(value)}(?![\\w.-])(?!"\\s*:)`, 'g');
type Form = string | RegExp;
const formsOf = (secrets: Iterable<Secret>): Form[] => {
  const list = [...secrets];
  const exact = [...new Set(list.filter((secret) => !secret.whole).flatMap((secret) => [secret.value, JSON.stringify(secret.value).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  const whole = [...new Set(list.filter((secret) => secret.whole).map((secret) => secret.value))].map(tokenOf);
  return [...exact, ...whole];
};
/** Whether a text holds a secret as the redaction would take it out. */
const holds = (bytes: Buffer, secret: Secret): boolean => (secret.whole ? tokenOf(secret.value).test(bytes.toString('latin1')) : bytes.includes(secret.value) || bytes.includes(JSON.stringify(secret.value).slice(1, -1)));
/** Replaces each form of each value (raw, and as written inside a JSON string) with `[redacted]`, the longest first, so one value that holds another goes whole. */
const apply = (forms: readonly Form[], text: string): string => forms.reduce<string>((out, form) => (typeof form === 'string' ? (out.includes(form) ? out.split(form).join('[redacted]') : out) : out.replace(form, '[redacted]')), text);

/** Replaces each value with `[redacted]`. */
export function redactorOf(secrets: readonly Secret[]): Redact | undefined {
  const forms = formsOf(secrets);
  return forms.length ? (text) => apply(forms, text) : undefined;
}

const stampOf = (file: string): string => { try { const stat = statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return 'absent'; } };

/** The secrets of a recording as they are over a run. A sign-in refreshes its access token during a long run, and the new token is a value the list read at the start never saw: before each write the sign-in file's
 *  stamp (mtime and size) is checked, and when it changed its values are read again and added. The redaction uses the union of every value seen. `final()` reads the file once more, for the scan at the end: an event
 *  can be written before the recorder sees the file change. A file that cannot be read when the tracker is made, or at the end, fails; one that cannot be read in between (a writer mid-rename) is read again at the next write. */
export function trackSecrets(env: NodeJS.ProcessEnv, spec: DemoSpec, authFile: string = signInFile(env)): { redact: Redact; final(): Secret[] } {
  const scrub = runScrub(env);
  const seen = new Map<string, Secret>();
  const add = (list: readonly Secret[]) => { for (const secret of list) if (!seen.has(secret.value)) seen.set(secret.value, secret); };
  add(secretsOf(env, spec, authFile));
  let stamp = stampOf(authFile);
  let forms = formsOf(seen.values());
  let count = seen.size;
  const refresh = () => {
    const now = stampOf(authFile);
    if (now === stamp) return;
    try { add(signInSecrets(authFile)); stamp = now; } catch { return; }
    if (seen.size !== count) { count = seen.size; forms = formsOf(seen.values()); }
  };
  return {
    redact: (text) => { refresh(); const hidden = forms.length ? apply(forms, text) : text; return scrub ? scrub(hidden) : hidden; },
    final: () => { add(signInSecrets(authFile)); return [...seen.values()]; },
  };
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What identifies the machine the run is on, taken out of every line and text blob beside the exact secret values: the run's own user name, its home directory, and the absolute paths under the run's directories.
 *  A path under a run directory becomes `<run>/...`, the home directory `~`. The user name is taken only as a whole token where it names a person on the machine: a path segment (`/ubuntu/`) and the owner and group columns of an `ls -l`
 *  row; the word elsewhere ("Ubuntu 24.04", a sentence) is left alone. No user, home or dirs given: nothing is taken out (`undefined`). */
export function scrubOf(options: { user?: string | undefined; home?: string | undefined; dirs?: readonly (string | undefined)[] }): Redact | undefined {
  const dirs = [...new Set((options.dirs ?? []).filter((dir): dir is string => typeof dir === 'string' && dir.length > 3 && dir.startsWith('/')).map((dir) => dir.replace(/\/+$/, '')))].sort((a, b) => b.length - a.length);
  const home = options.home && options.home.length > 3 && options.home.startsWith('/') && options.home !== '/root' ? options.home.replace(/\/+$/, '') : undefined;
  const user = options.user && options.user.length >= 3 ? options.user : undefined;
  if (!dirs.length && !home && !user) return undefined;
  // A path is taken by its prefix, up to the next character a path does not hold.
  const under = (prefix: string) => new RegExp(`${escapeRe(prefix)}(?=[/\\s"'\`:;,)\\]}]|$|\\\\)`, 'g');
  const parts = dirs.map((dir) => ({ pattern: under(dir), to: '<run>' }));
  if (home) parts.push({ pattern: under(home), to: '~' });
  const segment = user ? new RegExp(`(?<=/)${escapeRe(user)}(?=[/\\s"'\`:;,)\\]}]|$|\\\\)`, 'g') : undefined;
  // An `ls -l` row: permissions, links, owner, group (each may be the user); a row starts a line (a real newline, or the two characters a JSON string holds).
  const row = user ? new RegExp(`((?:^|\\n|\\\\n|")[-dlcbps][-rwxsStT]{9}[.+@]?\\s+\\d+\\s+)(${escapeRe(user)}|\\S+)(\\s+)(${escapeRe(user)}|\\S+)`, 'g') : undefined;
  return (text) => {
    let out = text;
    for (const part of parts) out = out.replace(part.pattern, part.to);
    if (segment) out = out.replace(segment, '[user]');
    if (row && user) out = out.replace(row, (_all, lead: string, owner: string, gap: string, group: string) => `${lead}${owner === user ? '[user]' : owner}${gap}${group === user ? '[user]' : group}`);
    return out;
  };
}

/** The scrub for a run: this process's user name and home, and the run's directories (the environment names them: `DIR`, `TMPDIR`, `RECORD_DIR`, `HOME` when it is not the real home). */
export function runScrub(env: NodeJS.ProcessEnv): Redact | undefined {
  let user: string | undefined;
  try { user = userInfo().username; } catch { user = env.USER; }
  return scrubOf({ user, home: homedir(), dirs: [env.DIR, env.TMPDIR, env.RECORD_DIR, env.HOME !== homedir() ? env.HOME : undefined] });
}

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

/** The record-time scan: every file of the recording (the lines, the manifest, every blob, the text ones and the image bytes alike) holds none of the values. A finding names the key and the file, never the value. */
export function scanRecording(dir: string, secrets: readonly Secret[]): void {
  if (!secrets.length) return;
  for (const file of filesUnder(dir)) {
    const bytes = readFileSync(file);
    for (const secret of secrets) {
      // Raw, and as written inside a JSON string (a line holds a token with a quote, a backslash or a newline escaped): the redaction takes both forms out, so the scan looks for both.
      if (holds(bytes, secret)) throw new Error(`the recording holds a secret that the redaction should have removed: ${secret.key} is in ${relative(dir, file)}`);
    }
  }
}

/** What a viewer following the run could already have fetched: `events.jsonl` as it was placed, and every blob. A secret there has been exposed, whatever the finished file will say, so the recording is refused (the spool is not scanned: it is what the finished file is rebuilt from, redacted). */
export function scanPlaced(dir: string, secrets: readonly Secret[]): void {
  if (!secrets.length) return;
  const files = [join(dir, 'events.jsonl'), ...(existsSync(join(dir, 'blobs')) ? filesUnder(join(dir, 'blobs')) : [])];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    // Raw, and as a JSON string holds it (escaped), the two forms the redaction takes out.
    for (const secret of secrets) if (bytes.includes(secret.value) || bytes.includes(JSON.stringify(secret.value).slice(1, -1))) throw new Error(`a secret was in ${relative(dir, file)} while the run was followed, and the recording is refused: ${secret.key}`);
  }
}
