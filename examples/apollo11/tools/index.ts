// The job's two tools. `landing` returns the landing's lines from the pages' receipts (the eyes' JSON lines), so the lead never
// copies a page; `cite` resolves every cite of the account to the look that backs it and builds the cited result. Both only read
// what the run filed under its directory.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { citedOf, landingOf, typedLines, type Output } from '../account.ts';
import { loadDataset } from '../dataset.ts';

/** The run's directory, where its receipts are filed: the place the reference entry hands every tool. */
const rootOf = (context?: { place?: { root: string } }) => {
  if (!context?.place) throw new Error('the reference entry hands every tool the run\'s place');
  return context.place.root;
};

export const tools = {
  landing: (args: Record<string, unknown>, context?: { place?: { root: string } }) => landingOf(rootOf(context), args as Parameters<typeof landingOf>[1]),
  // `typed` is the typed transcript's file in the run's workspace: the times read are checked against it.
  cite: (args: Record<string, unknown>, context?: { place?: { root: string } }) => {
    const root = rootOf(context);
    const { dataset, sha256 } = loadDataset();
    return citedOf(root, dataset, sha256, args as Output, typedLines(readFileSync(join(root, 'work', basename(String(args.typed))), 'utf8')));
  },
};
