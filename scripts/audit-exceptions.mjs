// Advisories the package gate accepts until a date, each scoped to one package under the parents it names.
// None today: the two this list held (brace-expansion 5.0.9 and undici 8.10.2, each pinned under
// @earendil-works/pi-coding-agent before 1.5.0) left the tree with pi 1.5.0, which pins neither. An entry names a parent the
// lockfile holds (audit-exceptions.test.mjs checks it), so one whose copy is gone is taken out, not left to expire.
/** @type {{ package: string, under: string | string[], advisories: string[], expires: string }[]} */
export const AUDIT_EXCEPTIONS = [];

const advisoryId = via => typeof via === 'object' && via !== null ? String(via.url ?? '').match(/GHSA(?:-[a-z0-9]{4}){3}$/)?.[0] : undefined;

// An `npm audit --json` entry is accepted only before its exception expires, when every installed
// copy sits under one of the named parents and every advisory it carries is one the exception names.
function accepts(exception, name, entry, now) {
  if (name !== exception.package || now >= Date.parse(`${exception.expires}T00:00:00Z`)) return false;
  const parents = [exception.under].flat();
  if (!entry.nodes?.length || !entry.nodes.every(node => parents.some(parent => node.startsWith(parent)))) return false;
  return entry.via?.length > 0 && entry.via.every(via => exception.advisories.includes(advisoryId(via)));
}

const blocks = severity => severity === 'high' || severity === 'critical';

// Splits high and critical audit entries into those an exception accepts and those that block. An entry that no exception
// names is accepted when every high or critical package it names as a cause is, with their advisories and the earliest
// expiry. A package the report lists as moderate or low blocks nothing, as on its own, and is never accepted. Anything
// else below it (an advisory of its own, a package no exception accepts, one the report does not list, a cycle) blocks it.
export function auditBlockers(audit, now = Date.now(), exceptions = AUDIT_EXCEPTIONS) {
  const entries = audit.vulnerabilities ?? {};
  const verdicts = new Map();
  const verdict = (name, path) => {
    if (verdicts.has(name)) return verdicts.get(name);
    const entry = entries[name];
    if (!entry || path.has(name)) return null;
    let result = null;
    const exception = exceptions.find(candidate => accepts(candidate, name, entry, now));
    if (exception) result = { advisories: entry.via.map(advisoryId), expires: exception.expires };
    else if (entry.via?.length > 0) {
      // A cause named by package is accepted when that package is, and an advisory of the entry's own never is. A package
      // the report lists below high is left out; one it does not list counts as high. An advisory of the entry's own
      // always counts, whatever its severity.
      const causes = entry.via
        .filter(via => typeof via !== 'string' || blocks(entries[via]?.severity ?? 'high'))
        .map(via => (typeof via === 'string' ? verdict(via, new Set([...path, name])) : null));
      if (causes.length > 0 && causes.every(Boolean)) result = { advisories: [...new Set(causes.flatMap(cause => cause.advisories))], expires: causes.map(cause => cause.expires).sort()[0] };
    }
    verdicts.set(name, result);
    return result;
  };
  const accepted = [];
  const blocking = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (!blocks(entry.severity)) continue;
    const found = verdict(name, new Set());
    if (found) accepted.push({ package: name, severity: entry.severity, ...found });
    else blocking.push({ package: name, severity: entry.severity });
  }
  return { accepted, blocking };
}
