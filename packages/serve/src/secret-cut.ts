// The values of an environment's key-shaped variables, cut out of text this server keeps: the rule of the harness log's
// cut, for what the importer writes (a transcript can hold a key a tool printed or was given).

/** Names whose values are secrets. */
const SECRET_NAME = /(_API_KEY|_TOKEN)$|SECRET/i;
export const REDACTED = "[redacted]";

/** A cut of every value of `env`'s key-shaped variables (8 characters or more) out of a string, and out of every string
 *  in a JSON value, its field names included. */
export function secretCut(env: NodeJS.ProcessEnv) {
  // Every own name, enumerable or not: an environment object may hold a key it does not list.
  const secrets = Object.getOwnPropertyNames(env)
    .map((name) => [name, env[name]] as const)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    // The longest first: a key that holds a shorter one is cut whole.
    .sort((a, b) => b.length - a.length);
  const text = (value: string) => secrets.reduce((out, secret) => out.split(secret).join(REDACTED), value);
  const json = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, inner]) => [text(name), json(inner)]));
    return value;
  };
  return { text, json };
}
