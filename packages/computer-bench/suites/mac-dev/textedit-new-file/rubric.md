# Rubric: Write and save a one-line plain text file

## Done means

- Documents › computer-bench-{{nonce}} › {{name}}.txt exists, is plain text, and holds the one line "{{line}}".

## Also acceptable

- A trailing newline after the line.
- The document left open in TextEdit after saving.

## Not done

- The file saved as rich text (.rtf, or rich text under a .txt name).
- The file saved elsewhere (Documents itself, iCloud Drive, Desktop) or under another name.
- The text typed but never saved.
- A typo or other capitalisation in the line.

## What the checks cover

- `content` reads the file's bytes over the shell; it is exact up to whitespace at the ends, so rich text, a wrong
  folder or name, and an unsaved document all fail.

## Side effects that fail the task

- Any other file in Documents changed or deleted.
