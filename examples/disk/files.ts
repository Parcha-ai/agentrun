// The files the invoice review reads: the payment policy and ten invoices, a few lines each. They are the job's data (job.files puts them in the agent's workspace on the disk), and each fact is on a line the
// review cites. Two invoices break the policy by construction: INV-004 is over the limit and INV-007 names no purchase order. The other eight comply, so the key below is fixed by hand, not read back from a run.
export const POLICY = `# Vendor payment policy

1. Pay an invoice only when it names a purchase order, written PO- and four digits.
2. Pay an invoice only when its amount is $50.00 or less.
3. Pay a compliant invoice in full, once.
4. Hold any other invoice and say which rule it breaks.
`;

const invoice = (number: string, vendor: string, po: string, date: string, amount: string) => `Invoice: ${number}\nVendor: ${vendor}\nPO: ${po}\nDate: ${date}\nAmount: ${amount}\n`;

export const INVOICE_FILES: Record<string, string> = {
  'INV-001': invoice('INV-001', 'Harbor Print Co.', 'PO-4401', '2026-10-01', '$12.50'),
  'INV-002': invoice('INV-002', 'Lantern Freight', 'PO-4402', '2026-10-01', '$14.25'),
  'INV-003': invoice('INV-003', 'Pine & Co Supplies', 'PO-4403', '2026-10-02', '$16.00'),
  'INV-004': invoice('INV-004', 'Meridian Catering', 'PO-4404', '2026-10-02', '$64.00'),
  'INV-005': invoice('INV-005', 'Harbor Print Co.', 'PO-4405', '2026-10-03', '$19.50'),
  'INV-006': invoice('INV-006', 'Northgate Cleaning', 'PO-4406', '2026-10-03', '$21.25'),
  'INV-007': invoice('INV-007', 'Lantern Freight', 'none', '2026-10-04', '$22.00'),
  'INV-008': invoice('INV-008', 'Pine & Co Supplies', 'PO-4408', '2026-10-05', '$24.75'),
  'INV-009': invoice('INV-009', 'Meridian Catering', 'PO-4409', '2026-10-05', '$26.50'),
  'INV-010': invoice('INV-010', 'Northgate Cleaning', 'PO-4410', '2026-10-06', '$28.25'),
};

/** What the policy says of each invoice, by hand: who is paid (in the order of the batch, with the cents) and who is held (with the rule). */
export const KEY = {
  paid: [['INV-001', 1250], ['INV-002', 1425], ['INV-003', 1600], ['INV-005', 1950], ['INV-006', 2125], ['INV-008', 2475], ['INV-009', 2650], ['INV-010', 2825]] as const,
  held: [['INV-004', 2], ['INV-007', 1]] as const, // the rule each breaks
};

/** The invoice's path in the workspace. */
export const pathOf = (number: string) => `invoices/${number}.txt`;
export const NUMBERS = Object.keys(INVOICE_FILES);
