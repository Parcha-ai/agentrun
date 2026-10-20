// The by-code checks of a disk invoice-review run (no model judges these): what was paid against the key fixed by hand, the held pair, every cite of the report resolved through the receipt of the read that made it, no
// path outside the workspace, receipts unique in the run, and (for a live run) a readable thinking block. Used by examples/disk.test.mjs on the fixture, and on a live run's recording and directory before anything is
// published. Each problem is a sentence; an empty list is a pass.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../scripts/recording/fold.mjs';

/** What the policy says of the batch (examples/disk/files.ts's KEY, by hand): the invoices paid in order with their cents, and those held with the rule each breaks. */
export const PAID = [['INV-001', 1250], ['INV-002', 1425], ['INV-003', 1600], ['INV-005', 1950], ['INV-006', 2125], ['INV-008', 2475], ['INV-009', 2650], ['INV-010', 2825]];
export const HELD = ['INV-004', 'INV-007'];

const ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
/**
 * Every anchor of `html` that carries `data-receipt`, whatever the order and quoting of its attributes: its cite when the link is `PATH#line=FROM,TO` with a receipt, else the anchor as written, a cite
 * the checks cannot read (which is a problem, never skipped).
 */
export function citesOf(html) {
  const cites = [];
  const unreadable = [];
  for (const [tag, attributes] of html.matchAll(/<a\b([^>]*)>/gi)) {
    const at = Object.fromEntries([...attributes.matchAll(ATTRIBUTE)].map(([, name, double, single, bare]) => [name.toLowerCase(), double ?? single ?? bare ?? '']));
    if (!('data-receipt' in at)) continue;
    const link = /^([^#]+)#line=(\d+),(\d+)$/.exec(at.href ?? '');
    if (!link || !at['data-receipt']) unreadable.push(tag.slice(0, 120));
    else cites.push({ path: link[1], from: Number(link[2]), to: Number(link[3]), receipt: at['data-receipt'] });
  }
  return { cites, unreadable };
}

/** The report's table rows that hold data: each `<tr>` (with or without attributes) up to its end, keeping only rows with a `<td>` cell, so a header row of `<th>` cells is not read as an invoice. */
export function reportRows(html) {
  return html.split(/<tr\b[^>]*>/i).slice(1).map((row) => row.split(/<\/tr>/i)[0]).filter((row) => /<td\b/i.test(row));
}

const rowsOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const lineCount = (text) => { const parts = text.split('\n'); if (parts.at(-1) === '') parts.pop(); return parts.length; };

/** The reads of a recording: each `read_lines` result with its receipt, window, content and the generation that wrote it. */
export function readsOf(lines) {
  return lines.filter((line) => line.kind === 'pi.tool-result' && line.data?.model?.[0]?.toolName === 'read_lines').map((line) => {
    const result = line.data.model[0];
    return { receipt: result.details?.receipt, path: result.details?.path, window: result.details?.lines, content: result.content, isError: result.isError === true, diagnostics: line.data.data?.diagnostics ?? [], gen: line.gen };
  });
}

export function reviewProblems({ recording, dir, record, live = false }) {
  const problems = [];
  const lines = readEvents(recording);
  // 1. What was paid: the paid tool was called once for each invoice of the key and for no other, with the key's cents. The ledger counts each call; the run keeps each call's answer, with its arguments, under its own id.
  const calls = rowsOf(join(dir, 'ledger.jsonl')).filter((row) => row.kind === 'tool' && row.name === 'charge').length;
  const answersDir = join(dir, 'answers');
  const kept = existsSync(answersDir) ? readdirSync(answersDir).map((name) => JSON.parse(readFileSync(join(answersDir, name), 'utf8'))) : [];
  const paid = kept.map((answer) => [answer.args?.invoice, answer.args?.cents]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (JSON.stringify(paid) !== JSON.stringify([...PAID].sort((a, b) => a[0].localeCompare(b[0])))) problems.push(`the paid tool's kept answers are for ${JSON.stringify(paid)}, not the key ${JSON.stringify(PAID)}`);
  if (calls !== PAID.length) problems.push(`the paid tool was called ${calls} times, not ${PAID.length}`);
  // 2. The entries the run delivered: the decisions are the key's, the held pair is held and nothing else is.
  const entries = record?.entries ?? [];
  const decided = Object.fromEntries(entries.map((entry) => [entry.review.invoice, entry.review.decision]));
  for (const [invoice] of PAID) if (decided[invoice] !== 'approve') problems.push(`${invoice} should be approved and is ${decided[invoice]}`);
  for (const invoice of HELD) if (decided[invoice] !== 'hold') problems.push(`${invoice} should be held and is ${decided[invoice]}`);
  if (entries.length !== PAID.length + HELD.length) problems.push(`the run has ${entries.length} entries, not ${PAID.length + HELD.length}`);
  // 3. Receipts: each read states one, unique in the run (across hosts too), and its window is exactly its part.
  const reads = readsOf(lines);
  const receipts = reads.map((read) => read.receipt);
  if (receipts.some((receipt) => typeof receipt !== 'string' || !receipt)) problems.push('a read states no receipt');
  if (new Set(receipts).size !== receipts.length) problems.push('two reads share a receipt');
  for (const read of reads) {
    if (read.isError) continue;
    const { from, to, part } = read.window ?? {};
    if (![from, to, part].every(Number.isInteger)) { problems.push(`read ${read.receipt} states no window`); continue; }
    const text = read.content?.[part]?.type === 'text' ? read.content[part].text : undefined;
    if (text === undefined) { problems.push(`read ${read.receipt}: part ${part} is not a text part`); continue; }
    if (text.split('\n').length - 1 !== to - from) problems.push(`read ${read.receipt}: part ${part} holds ${text.split('\n').length - 1} line breaks, not ${to - from}`);
    if (read.diagnostics.some((diagnostic) => diagnostic.code === 'truncated')) problems.push(`read ${read.receipt}: the harness cut its result`);
    const file = join(dir, 'work', read.path ?? '');
    if (existsSync(file)) {
      const all = readFileSync(file, 'utf8');
      const parts = all.split('\n'); if (parts.at(-1) === '') parts.pop();
      if (text !== parts.slice(from, to).map((line, index) => line + (from + index < parts.length - 1 || all.endsWith('\n') ? '\n' : '')).join('')) problems.push(`read ${read.receipt}: part ${part} is not the lines ${from} to ${to} of ${read.path}`);
    }
  }
  // 4. The report: every invoice has a row, and every cite resolves through a read of that file whose window holds it and links the same file beside the page.
  const reportFile = join(dir, 'work', 'report', 'index.html');
  if (!existsSync(reportFile)) problems.push('there is no report/index.html');
  else {
    const html = readFileSync(reportFile, 'utf8');
    if (/<script/i.test(html)) problems.push('the report holds a script');
    for (const [invoice] of [...PAID, ...HELD.map((held) => [held])]) if (!html.includes(invoice)) problems.push(`the report has no row for ${invoice}`);
    const rows = reportRows(html);
    for (const row of rows) if (citesOf(row).cites.length === 0) problems.push(`a row of the report has no cite: ${row.replace(/<[^>]+>/g, ' ').trim().slice(0, 60)}`);
    const byReceipt = new Map(reads.map((read) => [read.receipt, read]));
    const { cites, unreadable } = citesOf(html);
    for (const anchor of unreadable) problems.push(`a cite the checks cannot read (its link is not PATH#line=FROM,TO with a receipt): ${anchor}`);
    for (const cite of cites) {
      const { path, receipt } = cite;
      const [a, b] = [String(cite.from), String(cite.to)];
      // A cite links a file beside the page: a path that climbs out of report/ or starts at the root names no file the report carries.
      if (path.startsWith('/') || path.split('/').includes('..')) { problems.push(`a cite links ${path}, outside the report's folder`); continue; }
      const read = byReceipt.get(receipt);
      if (!read) { problems.push(`a cite names receipt ${receipt}, which no read stated`); continue; }
      if (read.path !== path) problems.push(`a cite of ${path} names receipt ${receipt}, a read of ${read.path}`);
      else if (!(Number(a) >= read.window.from && Number(b) <= read.window.to && Number(a) < Number(b))) problems.push(`a cite of ${path} lines ${a} to ${b} is outside the read's window ${read.window.from} to ${read.window.to}`);
      const file = join(dir, 'work', path);
      if (existsSync(file) && Number(b) > lineCount(readFileSync(file, 'utf8'))) problems.push(`a cite of ${path} reaches line ${b}, past the end of the file`);
      // The link opens the copy beside the page: it must be the file that was read, byte for byte.
      const beside = join(dir, 'work', 'report', path);
      if (!existsSync(beside)) problems.push(`a cite links ${path}, which is not beside the report`);
      else if (existsSync(file) && readFileSync(beside, 'utf8') !== readFileSync(file, 'utf8')) problems.push(`the copy of ${path} beside the report is not the file that was read`);
    }
  }
  // 5. Nothing outside the workspace: no tool call's arguments or results name an absolute path of a machine.
  const outside = /(^|[\s"'=(])\/(home|tmp|mnt|root|var|Users|opt|etc|run)\//;
  for (const line of lines) {
    if (line.kind !== 'pi.assistant' && line.kind !== 'pi.tool-result') continue;
    const text = JSON.stringify(line.data?.model ?? '');
    if (outside.test(text.replaceAll('\\n', ' ').replaceAll('\\"', '"'))) { problems.push(`a ${line.kind} line names a path outside the workspace`); break; }
  }
  // 6. A live agent's readable thinking: a thinking block with text in the agent's own messages.
  if (live) {
    const thinking = lines.filter((line) => line.kind === 'pi.assistant').flatMap((line) => line.data?.model?.[0]?.content ?? []).filter((block) => block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim());
    if (!thinking.length) problems.push('no readable thinking block in the recording');
  }
  return problems;
}
