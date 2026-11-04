// The values of an environment's key-shaped variables, cut out of text this server keeps: the rule of the harness log's
// cut, for what the importer writes (a transcript can hold a key a tool printed or was given). The import adds the keys
// secretlint finds in what it reads (`secretsIn`): keys of a known format, whoever's they are.
import { lintSource } from "@secretlint/core";
import { secretLintProfiler } from "@secretlint/profiler";
import { rules as recommended } from "@secretlint/secretlint-rule-preset-recommend";

// No performance marks: the profiler would leave about 14 a call in the process's global buffer.
secretLintProfiler.setEnabled(false);

import { keyShaped } from "@parcha/pi-durable-disk/secret-name";

/** Whether a name is a secret's, whatever list names it or none does: one of its `_`-separated segments, in any case, is
 *  KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASS, PAT, CREDENTIAL, CREDENTIALS or DSN, or its last is PWD after another.
 *  The one rule, pi-durable-disk's own: this cut, the harness log's and a run's environment (secrets.ts' withoutSecrets)
 *  take it, so what one leaves out the others do. */
export { keyShaped };
export const REDACTED = "[redacted]";

/** A cut of every value of the key-shaped variables (8 characters or more) of `envs`, one environment or several (the
 *  process's and the keys saved on the server), out of a string, and out of every string in a JSON value, its field
 *  names included. `names` are secrets whatever their shape (the server's own, the launcher's list: AGENTRUN_SEAL_KEY
 *  among them, whose name matches no key pattern). */
export function secretCut(envs: NodeJS.ProcessEnv | readonly NodeJS.ProcessEnv[], names: readonly string[] = []) {
  // Every own name of each, enumerable or not: an environment object may hold a key it does not list.
  const secrets = (Array.isArray(envs) ? envs : [envs])
    .flatMap((env: NodeJS.ProcessEnv) => Object.getOwnPropertyNames(env).map((name) => [name, env[name]] as const))
    .filter(([name, value]) => (keyShaped(name) || names.includes(name)) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    // The longest first: a key that holds a shorter one is cut whole.
    .sort((a, b) => b.length - a.length);
  // `text.removed` counts the values it cut, each once however often it was met; `text.probe` cuts the same and counts
  // nothing (a string never kept); `add` takes more values to cut (the keys secretlint found).
  const removed = new Set<string>();
  // One pass a string: every value as it is and as a JSON string holds it (a quote or a backslash in it escaped), in one
  // alternation, the longest first, so the longest value wins where two start at one place. Built again when values
  // are added.
  let pattern: RegExp | undefined;
  let owner = new Map<string, string>();
  const compile = () => {
    owner = new Map();
    for (const secret of secrets) for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) if (!owner.has(form)) owner.set(form, secret);
    const forms = [...owner.keys()].sort((a, b) => b.length - a.length);
    pattern = forms.length ? new RegExp(forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;
  };
  compile();
  const cut = (value: string, count: boolean) =>
    pattern
      ? value.replace(pattern, (form) => {
          if (count) removed.add(owner.get(form)!);
          return REDACTED;
        })
      : value;
  const text = Object.assign(
    (value: string): string => {
      const out = cut(value, true);
      text.removed = removed.size;
      return out;
    },
    { removed: 0, probe: (value: string): string => cut(value, false) },
  );
  const add = (values: readonly string[]) => {
    const fresh = values.filter((value) => value.length >= 8 && !secrets.includes(value));
    if (!fresh.length) return;
    secrets.splice(0, secrets.length, ...[...secrets, ...fresh].sort((a, b) => b.length - a.length));
    compile();
  };
  const json = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, inner]) => [text(name), json(inner)]));
    return value;
  };
  return { text, json, add };
}

/** The recommended preset's rules, but its comment filter: a `secretlint-disable` line in what an import reads (a
 *  repository's own config a tool printed, a web page) would switch every rule off for the rest of it. */
const FILTER_COMMENTS = "@secretlint/secretlint-rule-filter-comments";
const SECRETLINT = { rules: recommended.filter((rule) => rule.meta.id !== FILTER_COMMENTS).map((rule) => ({ id: rule.meta.id, rule })) };
/** How many passes `secretsIn` has made in this process: for a test that a path makes none. */
export const secretlintCalls = { count: 0 };

/** The keys secretlint's recommended rules find in `content`, in one pass: each as the rule names it (the secret
 *  itself where the rule gives it, else what it matched), and as a JSON string holding it would read it, decoded up to
 *  three times, so the cut finds it in a record's parsed text and in a shell's output kept in one as JSON. */
export async function secretsIn(content: string): Promise<string[]> {
  if (!content) return [];
  secretlintCalls.count += 1;
  const { messages } = await lintSource({ source: { content, filePath: "/import.txt", ext: ".txt", contentType: "text" }, options: { config: SECRETLINT, maskSecrets: false } });
  const decoded = (value: string): string | undefined => {
    try {
      const out = JSON.parse(`"${value}"`) as unknown;
      return typeof out === "string" && out !== value ? out : undefined;
    } catch {
      return undefined;
    }
  };
  const found = new Set<string>();
  for (const message of messages) {
    const named = Object.values(message.data ?? {}).filter((value): value is string => typeof value === "string" && value.length >= 8 && content.includes(value));
    for (const each of named.length ? named : [content.slice(message.range[0], message.range[1])]) {
      let value: string | undefined = each;
      for (let level = 0; value !== undefined && level < 3; level++) (found.add(value), (value = decoded(value)));
    }
  }
  return [...found];
}
