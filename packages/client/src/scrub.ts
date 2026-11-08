// Cutting secrets from what the server answers: the API key from an error object, and a secret body's values from the
// answer to it. Always from a JSON value's strings and keys, never from its text, so what is left is still the same JSON
// with its structure and every other value kept.

/** The forms a server could quote a secret in: as it is, JSON-escaped and URL-encoded, longest first. */
const formsOf = (secret: string) => [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])];

/** Cuts every copy of each secret, in any of its forms, from a JSON value's strings and keys. Two keys the cut makes one
 *  are kept apart. */
export function scrubberOf(secrets: readonly string[]): <T>(value: T) => T {
  const forms = [...new Set(secrets.filter(Boolean).flatMap(formsOf))].sort((a, b) => b.length - a.length);
  const text = (string: string) => forms.reduce((at, form) => at.split(form).join("[hidden]"), string);
  const value = (node: unknown): unknown => {
    if (typeof node === "string") return text(node);
    if (Array.isArray(node)) return node.map(value);
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      let name = text(key);
      for (let n = 2; Object.hasOwn(out, name); n++) name = `${text(key)} (${n})`;
      // Defined, not assigned: a key named __proto__ is the object's own, as JSON.parse made it.
      Object.defineProperty(out, name, { value: value(child), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return <T>(node: T) => (forms.length ? (value(node) as T) : node);
}

/** The string values of a secret body, but for its public fields (full paths such as `auth.type`, or `scopes.[]` for
 *  each item of a list, as the CLI reads them): the secrets to cut. A value under a map is never public, whatever its
 *  key. A body that is not JSON is one secret whole. */
export function secretsOf(body: string, publicFields: readonly string[]): string[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return [body];
  }
  const open = new Set(publicFields.map((field) => JSON.stringify(field.split("."))));
  const found: string[] = [];
  const walk = (node: unknown, path: string[]) => {
    if (typeof node === "string") {
      if (!open.has(JSON.stringify(path))) found.push(node);
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) walk(child, Array.isArray(node) ? [...path, "[]"] : [...path, key]);
    }
  };
  walk(value, []);
  return found;
}
