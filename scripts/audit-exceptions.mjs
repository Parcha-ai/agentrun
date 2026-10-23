// Advisories the package gate accepts until a date, each scoped to one package under named parents.
// brace-expansion: @earendil-works/pi-coding-agent publishes an npm-shrinkwrap.json that pins
// brace-expansion 5.0.9 (every release through 1.0.0). A dependency's shrinkwrap locks its
// subtree, so neither consumer overrides nor `npm audit fix` can reach it. Upstream:
// https://github.com/earendil-works/pi/issues/10288
// zod: @browserbasehq/stagehand pins zod 4.4.3 exactly (every release through 4.3.0), below the
// fix for GHSA-mrhx-c7xc-m3w5 (4.6.6). @parcha/pi-browser keeps zod at stagehand's version, so the
// schemas it hands stagehand are built by stagehand's own zod. Every other package takes the fixed zod.
export const AUDIT_EXCEPTIONS = [
  {
    package: 'brace-expansion',
    under: ['node_modules/@earendil-works/pi-coding-agent/'],
    advisories: ['GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p', 'GHSA-q2hr-2g5m-vwhr'],
    expires: '2026-12-01',
  },
  {
    package: 'zod',
    under: ['node_modules/@browserbasehq/stagehand/', 'node_modules/@parcha/pi-browser/'],
    advisories: ['GHSA-mrhx-c7xc-m3w5'],
    expires: '2026-12-01',
  },
];

const advisoryId = via => typeof via === 'object' && via !== null ? String(via.url ?? '').match(/GHSA(?:-[a-z0-9]{4}){3}$/)?.[0] : undefined;

// An `npm audit --json` entry is accepted only before its exception expires, when every installed
// copy sits under one of the named parents and every advisory it carries is one the exception names.
function accepts(exception, name, entry, now) {
  if (name !== exception.package || now >= Date.parse(`${exception.expires}T00:00:00Z`)) return false;
  if (!entry.nodes?.length || !entry.nodes.every(node => exception.under.some(parent => node.startsWith(parent)))) return false;
  return entry.via?.length > 0 && entry.via.every(via => exception.advisories.includes(advisoryId(via)));
}

// Splits high and critical audit entries into those an exception accepts and those that block. An
// entry flagged only through other entries (every `via` a package name, no advisory of its own) is
// accepted when each of them is, with their advisories and the earliest of their expiry dates.
export function auditBlockers(audit, now = Date.now(), exceptions = AUDIT_EXCEPTIONS) {
  const flagged = Object.entries(audit.vulnerabilities ?? {}).filter(([, entry]) => entry.severity === 'high' || entry.severity === 'critical');
  const accepted = new Map();
  for (const [name, entry] of flagged) {
    const exception = exceptions.find(candidate => accepts(candidate, name, entry, now));
    if (exception) accepted.set(name, { package: name, severity: entry.severity, advisories: entry.via.map(advisoryId), expires: exception.expires });
  }
  const through = ([, entry]) => entry.via?.length > 0 && entry.via.every(via => typeof via === 'string');
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, entry] of flagged.filter(item => !accepted.has(item[0]) && through(item))) {
      if (!entry.via.every(via => accepted.has(via))) continue;
      const accepting = entry.via.map(via => accepted.get(via));
      accepted.set(name, {
        package: name,
        severity: entry.severity,
        advisories: [...new Set(accepting.flatMap(cause => cause.advisories))],
        expires: accepting.map(cause => cause.expires).sort()[0],
      });
      grew = true;
    }
  }
  const blocking = flagged.filter(([name]) => !accepted.has(name)).map(([name, entry]) => ({ package: name, severity: entry.severity }));
  return { accepted: flagged.filter(([name]) => accepted.has(name)).map(([name]) => accepted.get(name)), blocking };
}
