// A structural check over a finished audit: every fact in the record cites a receipt, the receipt is a file the run filed, and it is
// the right kind of receipt for what the fact claims. A badge fact cites a look (vision's `read` of the badge image, status ok, with the
// image's SHA-256), a repository fact a browser read, and a registry, advisory or install fact the receipt its tool kept. It reads
// files and parses JSON; it never reads meaning into prose.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

type Fact = { claim: string; source: string; receipt: string };
type Row = { name: string; version: string; facts: Fact[] };

/** What a receipt of each kind must be: the folder it is kept in, and the fields of its JSON that name its kind. */
const KINDS: Record<string, { under: string; holds: (receipt: Record<string, any>) => string | undefined }> = {
  registry: { under: 'receipts/registry/', holds: (receipt) => (receipt.facts ? undefined : 'it holds no facts') },
  advisories: { under: 'receipts/advisories/', holds: (receipt) => (receipt.facts ? undefined : 'it holds no facts') },
  install: { under: 'receipts/install/', holds: (receipt) => (typeof receipt.ran === 'boolean' ? undefined : 'it does not say whether the install ran') },
  repository: { under: 'evidence/', holds: (receipt) => (receipt.tool === 'browser_read' && receipt.status === 'ok' ? undefined : `it is a ${receipt.tool} receipt with status ${receipt.status}, not an ok browser_read`) },
  badge: { under: 'evidence/', holds: (receipt) => (receipt.tool === 'look' && receipt.status === 'ok' && typeof receipt.facts?.sha256 === 'string' ? undefined : `it is a ${receipt.tool} receipt with status ${receipt.status}, not an ok look of an image`) },
};

/** Problems with the receipts the record's facts cite, each naming the dependency and the fact; none means every fact rests on a filed receipt of its kind. */
export function checkReceipts(root: string, record: { rows?: Row[] }): string[] {
  const problems: string[] = [];
  for (const row of record.rows ?? []) {
    for (const fact of row.facts) {
      const where = `${row.name}@${row.version}: "${fact.claim.slice(0, 60)}"`;
      const kind = KINDS[fact.source];
      if (!kind) { problems.push(`${where} has an unknown source ${fact.source}`); continue; }
      const at = resolve(root, fact.receipt);
      if (relative(resolve(root), at).startsWith('..')) { problems.push(`${where} cites a path outside the run`); continue; }
      if (!fact.receipt.startsWith(kind.under)) { problems.push(`${where} cites ${fact.receipt}, which is not under ${kind.under}`); continue; }
      if (!existsSync(at)) { problems.push(`${where} cites ${fact.receipt}, which does not exist`); continue; }
      let receipt: Record<string, any>;
      try { receipt = JSON.parse(readFileSync(at, 'utf8')); } catch { problems.push(`${where} cites ${fact.receipt}, which does not parse`); continue; }
      const why = kind.holds(receipt);
      if (why) problems.push(`${where} cites ${fact.receipt}, but ${why}`);
    }
  }
  return problems;
}

/** The record of a finished run in `dir`, or null. */
export function recordOf(dir: string): { rows?: Row[] } | null {
  const file = join(dir, 'out', 'record.json');
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { record?: { rows?: Row[] }; rows?: Row[] };
  return parsed.record ?? parsed;
}
