// The keys and tokens cut out of text this server keeps (what the importer writes: a transcript can hold a key a tool
// printed or was given). Two kinds: the values of an environment's key-shaped variables (the rule of the harness log's
// cut), and any key or token by its shape, whoever's it is (a rotated key, a colleague's, one an agent printed from a
// .env). Each cut counts what it removes.

/** Names whose values are secrets. */
const SECRET_NAME = /(_API_KEY|_TOKEN)$|SECRET/i;
export const REDACTED = "[redacted]";

/** A cut of every value of `env`'s key-shaped variables (8 characters or more) out of a string, and out of every string
 *  in a JSON value, its field names included. `names` are secrets whatever their shape (the server's own, the launcher's
 *  list: AGENTRUN_SEAL_KEY among them, whose name matches no key pattern). */
export function secretCut(env: NodeJS.ProcessEnv, names: readonly string[] = []) {
  // Every own name, enumerable or not: an environment object may hold a key it does not list.
  const secrets = Object.getOwnPropertyNames(env)
    .map((name) => [name, env[name]] as const)
    .filter(([name, value]) => (SECRET_NAME.test(name) || names.includes(name)) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    // The longest first: a key that holds a shorter one is cut whole.
    .sort((a, b) => b.length - a.length);
  // After the environment's values, every key or token of a known shape (shapedCut). `text.removed` counts the keys and
  // tokens cut, each once however many times it was met.
  const removed = new Set<string>();
  const text = Object.assign(
    (value: string): string => {
      const own = secrets.reduce((out, secret) => {
        const parts = out.split(secret);
        if (parts.length > 1) removed.add(secret);
        return parts.join(REDACTED);
      }, value);
      const shaped = shapedCut(own);
      for (const found of shaped.cut) removed.add(found);
      text.removed = removed.size;
      return shaped.text;
    },
    { removed: 0 },
  );
  const json = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, inner]) => {
          // A field whose name says its value is a secret (a tool's structured input): its value, the name beside it.
          const named = typeof inner === "string" ? namedSecret(name, inner) : undefined;
          if (named !== undefined) {
            removed.add(named);
            text.removed = removed.size;
            return [text(name), REDACTED];
          }
          return [text(name), json(inner)];
        }),
      );
    return value;
  };
  return { text, json };
}

/** Keys and tokens by their shape: the rules gitleaks and trufflehog lead with, the ones a transcript holds most. Each
 *  is anchored at a word edge and bounded (no quantifier nested in another), and together they run as one pass. */
const SHAPED = new RegExp(
  [
    // Anthropic and OpenAI keys (project, service account, admin and classic), never inside a word (`task-…`).
    String.raw`(?<![A-Za-z0-9_-])sk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,300}`,
    // GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained.
    String.raw`(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,255}`,
    String.raw`(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,255}`,
    // AWS access key ids.
    String.raw`(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])`,
    // Slack tokens.
    String.raw`(?<![A-Za-z0-9])xox[abpr]-[A-Za-z0-9-]{10,250}`,
    // Stripe live keys.
    String.raw`(?<![A-Za-z0-9])(?:sk|rk|pk)_live_[A-Za-z0-9]{16,250}`,
    // A PEM private key, its lines as text or escaped in a JSON string.
    String.raw`-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY-----[\s\S]{1,10000}?-----END (?:[A-Z0-9]+ ){0,3}PRIVATE KEY-----`,
  ].join("|"),
  "g",
);
/** An AWS secret access key: 40 characters of base64, only beside its name, the shape alone being too common. */
const AWS_SECRET = /(aws_?secret_?access_?key|aws_?secret_?key|aws_secret)(["']?\s{0,3}[:=]\s{0,3}["']?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi;
/** An AWS access key id, and a 40-character run of base64 (an AWS secret access key's shape) near one. */
const AWS_ID = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g;
const KEY_40 = /[A-Za-z0-9/+]{40}/g;
/** A bearer token (`Authorization: Bearer …`, a curl -H line, a JWT): its value, when it looks like a key. */
const BEARER = /(?<![A-Za-z0-9_])(bearer\s{1,3})([A-Za-z0-9._~+/=-]{20,2000})/gi;
/** `NAME=value` or `name: value` where the name says key, token, secret or password and the value looks like one. */
const ASSIGNED = /(?<![A-Za-z0-9_])([A-Za-z0-9_]{0,40}(?:api_?key|access_?key|secret|token|password|passwd|private_?key)[A-Za-z0-9_]{0,20})(["']?\s{0,3}[=:]\s{0,3}["']?)([^\s"'`<>,;]{16,300})/gi;

/** Whether `value` reads as a key, not a word, a path, a reference or a placeholder: two kinds of character or more,
 *  and the entropy of random text. */
function keyLike(value: string): boolean {
  if (/^(?:\$|~|\/|\.\/|https?:|\[redacted\])/i.test(value)) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((kind) => kind.test(value)).length;
  if (kinds < 2) return false;
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits >= 3.2;
}

/** `value` with every key or token of a known shape cut, and the ones cut. */
export function shapedCut(value: string): { text: string; cut: string[] } {
  const cut: string[] = [];
  if (value.length < 16) return { text: value, cut };
  let out = value;
  // An AWS secret access key pasted beside its access key id (within 100 characters, either side), its name nowhere:
  // trufflehog's pairing, before the id itself is cut below. Only the text around each id is looked at.
  if (/A[KS]IA/.test(out)) {
    const pairs = new Set<string>();
    for (const id of out.matchAll(AWS_ID)) {
      const from = Math.max(0, id.index - 140);
      for (const key of out.slice(from, id.index + id[0].length + 140).matchAll(KEY_40)) {
        const at = from + key.index;
        // Whole in the text itself, not a cut through a longer run at the window's edge.
        if (!/[A-Za-z0-9/+]/.test(out[at - 1] ?? "") && !/[A-Za-z0-9/+=]/.test(out[at + 40] ?? "")) pairs.add(key[0]);
      }
    }
    for (const secret of pairs) {
      cut.push(secret);
      out = out.split(secret).join(REDACTED);
    }
  }
  out = out.replace(SHAPED, (found) => {
    // A classic OpenAI key holds a digit; a long hyphenated slug after a bare `sk-` holds none. A key under a known
    // prefix (`sk-ant-`, `sk-proj-`, `sk-svcacct-`, `sk-admin-`) is cut whatever its body.
    if (/^sk-(?!ant-|proj-|svcacct-|admin-)/.test(found) && !/[0-9]/.test(found)) return found;
    cut.push(found);
    return REDACTED;
  });
  if (/aws/i.test(out))
    out = out.replace(AWS_SECRET, (_, name: string, between: string, secret: string) => {
      cut.push(secret);
      return `${name}${between}${REDACTED}`;
    });
  if (/bearer/i.test(out))
    out = out.replace(BEARER, (found, word: string, token: string) => {
      if (!keyLike(token)) return found;
      cut.push(token);
      return `${word}${REDACTED}`;
    });
  if (/[=:]/.test(out))
    out = out.replace(ASSIGNED, (found, name: string, between: string, value: string) => {
      // A sentence's own punctuation after the value ends it: `PASSWORD=<key>.` is the key, the period the sentence's.
      const secret = value.replace(/[.:)\]}!?]+$/, "");
      if (secret.length < 16 || !keyLike(secret)) return found;
      cut.push(secret);
      return `${name}${between}${REDACTED}${value.slice(secret.length)}`;
    });
  return { text: out, cut };
}

/** The value of a field named for a secret, when the value reads as one: an AWS secret access key under its name, or a
 *  key-like value under a KEY / TOKEN / SECRET / PASSWORD name, as `name=value` in text would be cut. */
function namedSecret(name: string, value: string): string | undefined {
  if (/^(?:aws_?secret_?access_?key|aws_?secret_?key|aws_secret)$/i.test(name) && /^[A-Za-z0-9/+]{40}$/.test(value)) return value;
  if (value.length >= 16 && value.length <= 300 && /^[A-Za-z0-9_]{0,40}(?:api_?key|access_?key|secret|token|password|passwd|private_?key)[A-Za-z0-9_]{0,20}$/i.test(name) && !/[\s"'`<>,;]/.test(value) && keyLike(value)) return value;
  return undefined;
}
