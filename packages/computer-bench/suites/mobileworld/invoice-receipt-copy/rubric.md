# Rubric: Copy November's invoice and receipt PDFs into Finance/invoice

## Done means

- A folder named invoice exists inside /sdcard/Finance (shown as Finance in file managers) and holds one file,
  invoice_2025_001.pdf, the only PDF in Download whose name says invoice or receipt and whose date is in November.
- The original invoice_2025_001.pdf is still in Download.

## Also acceptable

- The invoice folder made from the file manager's "New folder" (or by the copy dialog) before or during the copy.
- The copy's own date being the day of the run; only the original's date counts.

## Not done

- invoice_payment.pdf (October) or receipt_2025_002.pdf (December) copied too.
- Any of the six other files copied.
- The file moved instead of copied, so Download no longer has it.
- The folder made somewhere else (Download/Finance/invoice, or /sdcard/invoice).
- Asking which month is meant; November is stated.

## What the checks cover

- `folder-holds-the-file` lists /sdcard/Finance/invoice and wants exactly that one name.
- `original-kept` wants the original in Download, still dated November 2025.
- `copy-matches` compares the copy with the original byte for byte.

## Side effects that fail the task

- Files in Download deleted, renamed or changed.
