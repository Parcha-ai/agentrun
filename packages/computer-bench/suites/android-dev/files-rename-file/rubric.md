# Rubric: Rename a file in the Files app

## Done means

- Download/computer-bench-{{nonce}} holds one file, {{f.new}}-{{nonce}}.txt, with the text it had before.

## Not done

- The extension dropped or doubled ({{f.new}}-{{nonce}}, {{f.new}}-{{nonce}}.txt.txt).
- A copy made under the new name while the old file stays.
- The rename dialog left open without confirming.

## What the checks cover

- `only-new-name` lists the folder (dot files hidden); it is exact for the name and shows no copy is left.
- `same-text` reads the renamed file's text, so a new empty file with the name doesn't pass.

## Side effects that fail the task

- Other files in Download moved, renamed or deleted.
