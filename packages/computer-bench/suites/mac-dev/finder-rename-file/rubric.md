# Rubric: Rename a file in a Documents folder

## Done means

- Documents › computer-bench-{{nonce}} holds "{{new}}.txt" (with the text "{{doc.body}}") and readme.txt, and no
  "{{doc.old}}.txt".

## Not done

- "{{new}}.txt.txt" or "{{new}}" without the extension (Finder hides extensions on some Macs; the file's real name is
  what counts).
- The file duplicated and the copy renamed, leaving "{{doc.old}}.txt".
- readme.txt renamed instead.

## What the checks cover

- `renamed` reads the new file's text over the shell, so a new empty file of that name fails.
- `old-gone` and `readme-kept` read the folder's other names; together the three are exact for this folder.

## Side effects that fail the task

- Any file outside the folder renamed, moved or deleted.
