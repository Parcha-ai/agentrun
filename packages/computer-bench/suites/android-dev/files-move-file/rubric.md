# Rubric: Move a file into a folder in the Files app

## Done means

- {{f.file}}-{{nonce}}.txt is in Download/computer-bench-{{nonce}}/{{f.dest}} and no longer at the top of the folder.
- keep-{{nonce}}.txt is still at the top of the folder.

## Also acceptable

- Done with "Move to", or with copy then delete of the original.

## Not done

- Copied into {{f.dest}} with the original left behind.
- Moved into {{f.other}}, or into a new folder.
- keep-{{nonce}}.txt moved too.

## What the checks cover

- `files` lists every file under the run's folder (dot files hidden); it is exact for where each one ended up. Empty
  folders don't show, which the task doesn't care about.

## Side effects that fail the task

- Files outside the run's folder moved, renamed or deleted.
