// The exact secret values a recording must not hold. A shape cannot catch a token (a refresh token is opaque), so the recorder is told the values: the values of the environment names a demo declares, and the sign-in's tokens
// in `auth.json` (`$AGENTRUN_HOME/auth.json`, else `~/.config/agentrun/auth.json`; one credential per provider, each `{ type: 'oauth', access, refresh, ... }` or `{ type: 'api_key', key }`). Every recorded line, text blob and the manifest has none of them, and
// a recording that still holds one is refused. A value is never printed: a finding names the key and the file only.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** Everything a recording of `spec` must not hold: the values of the environment names it declares, and the sign-in's tokens. */
export function secretsOf(env: NodeJS.ProcessEnv, spec: DemoSpec, authFile: string = signInFile(env)): Secret[] {
  const found: Secret[] = [];
  for (const name of declaredEnv(spec)) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= MIN) found.push({ key: name, value });
  }
  return [...found, ...signInSecrets(authFile)];
}

/** Replaces each value, as it is written raw and as it is written inside a JSON string, with `[redacted]`: the longest first, so one value that holds another goes whole. */
export function redactorOf(secrets: readonly Secret[]): Redact | undefined {
  const forms = [...new Set(secrets.flatMap((secret) => [secret.value, JSON.stringify(secret.value).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  if (!forms.length) return undefined;
  return (text) => forms.reduce((out, form) => (out.includes(form) ? out.split(form).join('[redacted]') : out), text);
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
