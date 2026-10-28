// Advisories the package gate accepts until a date, each scoped to one package under the parents it names.
export const AUDIT_EXCEPTIONS = [
  // Root cause: @earendil-works/pi-coding-agent publishes an npm-shrinkwrap.json that pins
  // brace-expansion 5.0.9 (every release through 1.0.0). A dependency's shrinkwrap locks its
  // subtree, so neither consumer overrides nor `npm audit fix` can reach it. Upstream:
  // https://github.com/earendil-works/pi/issues/10288
  {
    package: 'brace-expansion',
    under: 'node_modules/@earendil-works/pi-coding-agent/',
    advisories: ['GHSA-qhr7-859c-m2p7', 'GHSA-6j4f-fj2g-mc7p', 'GHSA-q2hr-2g5m-vwhr'],
    expires: '2026-12-01',
  },
  // Stagehand pins zod 4.4.3 exactly and has no fixed release yet; this exception covers only that nested copy for
  // GHSA-mrhx-c7xc-m3w5 and expires 2026-11-06. Availability only: input that reaches Stagehand's host-side validation is
  // not size-capped, so the upgrade alone does not bound memory; a pi-browser fix is tracked privately. No data exposure.
  {
    package: 'zod',
    under: 'node_modules/@browserbasehq/stagehand/',
    advisories: ['GHSA-mrhx-c7xc-m3w5'],
    expires: '2026-11-06',
  },
  // The `disk` SDK and @earendil-works/pi-coding-agent pin undici 8.10.2 exactly in their latest releases (1.10.0 and 1.4.0),
  // so neither copy can reach the fixed 8.12.2 from here; this exception covers only those two nested copies, for the
  // advisories below, and expires 2026-11-06. Every fix awaits those upstream releases, and the follow-up is tracked privately.
  {
    package: 'undici',
    under: ['node_modules/disk/', 'node_modules/@earendil-works/pi-coding-agent/'],
    advisories: [
      'GHSA-xjj6-f33q-929c', // high: availability.
      'GHSA-4qv8-2p9j-2685', // moderate: availability.
      'GHSA-f72v-6w45-q472', // moderate: availability.
      'GHSA-4w7w-5xrc-9h26', // high: response caching across cross-origin redirects (confidentiality).
      'GHSA-2m5v-pch6-74hx', // high: TLS certificate validation (integrity and confidentiality).
      'GHSA-qrxm-fqhp-jwvm', // high: availability (TLS renegotiation).
      'GHSA-9fm3-97px-rjf6', // moderate: availability (WebSocket client).
      'GHSA-55wc-3pg8-jfw6', // moderate: availability (decompression).
    ],
    expires: '2026-11-06',
  },
];

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
