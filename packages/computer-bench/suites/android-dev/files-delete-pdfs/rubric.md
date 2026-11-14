# Rubric: Delete every PDF in a folder, keeping the rest, in the Files app

## Done means

- {{f.p1}}-{{nonce}}.pdf, {{f.p2}}-{{nonce}}.pdf and {{f.p3}}-{{nonce}}.pdf are gone from
  Download/computer-bench-{{nonce}}.
- The folder {{f.dir}} and the text file {{f.keep}}-{{nonce}}.txt are still there.

## Also acceptable

- The PDFs sent to the trash rather than deleted at once.
- The view left as list or grid.

## Not done

- A PDF left behind.
- {{f.keep}}-{{nonce}}.txt deleted because its name matches one of the PDFs.
- The PDFs moved to another folder instead of deleted.

## What the checks cover

- `left` lists the folder: exactly {{f.dir}} and {{f.keep}}-{{nonce}}.txt.

## Side effects that fail the task

- Anything outside the run's folder deleted or moved.
