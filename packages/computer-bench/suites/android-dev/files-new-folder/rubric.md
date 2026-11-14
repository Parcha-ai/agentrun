# Rubric: Make a folder inside a given folder in the Files app

## Done means

- Download/computer-bench-{{nonce}}/{{s.parent}} holds one new folder, "{{s.child}} {{nonce}}".
- {{s.other}}, notes-{{nonce}}.txt and the run's folder are otherwise unchanged.

## Not done

- The folder made in computer-bench-{{nonce}} itself, in {{s.other}}, or anywhere else.
- A name with a typo, other capitalisation, or the six-character code left out.
- A file made instead of a folder.

## What the checks cover

- `made` lists {{s.parent}}, {{s.other}} and the run's folder, and checks the new entry is a folder.

## Side effects that fail the task

- Any file or folder in the run's folder renamed, moved or deleted.
