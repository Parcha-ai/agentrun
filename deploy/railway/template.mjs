// The Railway template (template.json, in the shape of Railway's serializedConfig): reading it, rendering a service's
// variables the way a deploy of it does, and comparing two configs by what a deploy does with them. Used by
// publish-and-walk.mjs, local-walk.mjs and their test (packages/serve/test/railway-template.test.mjs).
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

export const TEMPLATE_FILE = new URL("./template.json", import.meta.url);

export const loadTemplate = (file = TEMPLATE_FILE) => JSON.parse(readFileSync(file, "utf8"));

/** The one service of a config, with its key. */
export function onlyService(config) {
  const entries = Object.entries(config?.services ?? {});
  if (entries.length !== 1) throw new Error(`a template of one service was expected, not ${entries.length}`);
  const [key, service] = entries[0];
  return { key, service };
}

/** A start command as Railway runs it, in exec form: words split on spaces, a double-quoted word kept whole. */
export function startArgv(command) {
  const words = [];
  for (const m of command.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]);
  return words;
}

/** `${{secret(length, alphabet)}}`, as Railway's template function makes it: `length` characters drawn from `alphabet`. */
const secret = (length, alphabet) => Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");

/** A variable's default value as a deploy makes it: each `${{secret(n, "abc")}}` generated, `${{RAILWAY_PUBLIC_DOMAIN}}`
 *  the service's domain. Any other reference is refused, so a new one can't pass untested. */
export function renderValue(value, { domain }) {
  return value.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (whole, inner) => {
    const fn = /^secret\((\d+)(?:,\s*"([^"]+)")?\)$/.exec(inner);
    if (fn) return secret(Number(fn[1]), fn[2] ?? "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    if (inner === "RAILWAY_PUBLIC_DOMAIN") return domain;
    throw new Error(`${whole} is a reference this renderer does not know`);
  });
}

/** Every variable of a service as a deploy sets it; an optional one left blank is not set. */
export function renderVariables(service, { domain }) {
  const env = {};
  for (const [name, v] of Object.entries(service.variables ?? {})) {
    const value = renderValue(v.defaultValue ?? "", { domain });
    if (value !== "" || !v.isOptional) env[name] = value;
  }
  return env;
}

/** What a deploy of a config does, without the ids Railway gives its services, volumes and domains: per service by name,
 *  its image, start and health settings, variables (value and whether optional), domain ports and mount paths. */
export function deployed(config) {
  const out = {};
  for (const service of Object.values(config?.services ?? {})) {
    const deploy = Object.fromEntries(Object.entries(service.deploy ?? {}).filter(([, v]) => v !== null && v !== "").sort(([a], [b]) => a.localeCompare(b)));
    const variables = Object.fromEntries(Object.entries(service.variables ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { value: v?.defaultValue ?? "", optional: Boolean(v?.isOptional) }]));
    out[service.name] = {
      image: service.source?.image ?? null,
      deploy,
      variables,
      ports: Object.values(service.networking?.serviceDomains ?? {}).map((d) => d?.port ?? null).sort(),
      mounts: Object.values(service.volumeMounts ?? {}).map((m) => m.mountPath).sort(),
    };
  }
  return out;
}

/** Where two configs differ in what a deploy does: one line per path, empty when they do the same. A secret-named
 *  variable's value is shown only when it is a template function (`${{...}}`), else by its length. */
export function differences(want, have) {
  const lines = [];
  const secretPath = /\.variables\.[^.]*(TOKEN|KEY|SECRET|PASSWORD)[^.]*\.value$/;
  const show = (v, path) => (typeof v === "string" && secretPath.test(path) && !v.includes("${{") ? `(a value of ${v.length} characters)` : JSON.stringify(v));
  const walk = (a, b, path) => {
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      lines.push(`${path}: the repository's ${show(a, path)}, Railway's ${show(b, path)}`);
    }
  };
  walk(deployed(want), deployed(have), "");
  return lines;
}
