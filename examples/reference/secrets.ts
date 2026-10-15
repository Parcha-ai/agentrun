// The exact secret values a recording must not hold. A shape cannot catch a token (a refresh token is opaque), so the recorder is told the values: the values of the environment names a demo declares, and the sign-in's tokens
// in `auth.json` (`$AGENTRUN_HOME/auth.json`, else `~/.config/agentrun/auth.json`; one credential per provider, each `{ type: 'oauth', access, refresh, ... }` or `{ type: 'api_key', key }`). Every recorded line, text blob and the manifest has none of them, and
// a recording that still holds one is refused. A value is never printed: a finding names the key and the file only.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Redact } from './record.ts';
import { declaredEnv, type DemoSpec } from './demo-spec.ts';

/** A secret value and the name it is reported by (an environment name, or `<file> credentials.<provider>.<field>`). */
export type Secret = { key: string; value: string };

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

/** This machine's own host name and boot id (where `/proc/sys/kernel/random/boot_id` exists): a recording shows labels for a holder's, never these. A short or generic name is not taken (it would damage the lines around it). */
export function machineSecrets(): Secret[] {
  const found: Secret[] = [];
  const name = hostname();
  if (name.length >= 4 && name !== 'localhost') found.push({ key: 'this machine\'s host name', value: name });
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

const formsOf = (secrets: Iterable<Secret>): string[] => [...new Set([...secrets].flatMap((secret) => [secret.value, JSON.stringify(secret.value).slice(1, -1)]))].sort((a, b) => b.length - a.length);
/** Replaces each form of each value (raw, and as written inside a JSON string) with `[redacted]`, the longest first, so one value that holds another goes whole. */
const apply = (forms: readonly string[], text: string): string => forms.reduce((out, form) => (out.includes(form) ? out.split(form).join('[redacted]') : out), text);

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
    redact: (text) => { refresh(); return forms.length ? apply(forms, text) : text; },
    final: () => { add(signInSecrets(authFile)); return [...seen.values()]; },
  };
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
      if (bytes.includes(secret.value)) throw new Error(`the recording holds a secret that the redaction should have removed: ${secret.key} is in ${relative(dir, file)}`);
    }
  }
}
