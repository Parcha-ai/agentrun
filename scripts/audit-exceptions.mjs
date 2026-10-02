// Advisories the package gate accepts until a date, each scoped to one package under one parent.
// Root cause: @earendil-works/pi-coding-agent publishes an npm-shrinkwrap.json that pins
// brace-expansion 5.0.9 (every release through 1.0.0). A dependency's shrinkwrap locks its
// subtree, so neither consumer overrides nor `npm audit fix` can reach it. Upstream:
// https://github.com/earendil-works/pi/issues/10288
export const AUDIT_EXCEPTIONS = [
  {
    package: 'brace-expansion',
    under: 'node_modules/@earendil-works/pi-coding-agent/',
    advisories: ['GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p', 'GHSA-q2hr-2g5m-vwhr'],
    expires: '2026-12-01',
  },
];

const advisoryId = via => typeof via === 'object' && via !== null ? String(via.url ?? '').match(/GHSA(?:-[a-z0-9]{4}){3}$/)?.[0] : undefined;

// An `npm audit --json` entry is accepted only before its exception expires, when every installed
// copy sits under the named parent and every advisory it carries is one the exception names.
function accepts(exception, name, entry, now) {
  if (name !== exception.package || now >= Date.parse(`${exception.expires}T00:00:00Z`)) return false;
  if (!entry.nodes?.length || !entry.nodes.every(node => node.startsWith(exception.under))) return false;
  return entry.via?.length > 0 && entry.via.every(via => exception.advisories.includes(advisoryId(via)));
}

// Splits high and critical audit entries into those an exception accepts and those that block.
export function auditBlockers(audit, now = Date.now(), exceptions = AUDIT_EXCEPTIONS) {
  const accepted = [];
  const blocking = [];
  for (const [name, entry] of Object.entries(audit.vulnerabilities ?? {})) {
    if (entry.severity !== 'high' && entry.severity !== 'critical') continue;
    const exception = exceptions.find(candidate => accepts(candidate, name, entry, now));
    if (exception) accepted.push({ package: name, severity: entry.severity, advisories: entry.via.map(advisoryId), expires: exception.expires });
    else blocking.push({ package: name, severity: entry.severity });
  }
  return { accepted, blocking };
}
