# Rubric: Change one number in an open text file and save it

## Done means

- Documents › computer-bench-{{nonce}} › budget.txt, as saved on disk, reads "{{line}}: {{amount}}" where it read the
  old {{line}} amount, and every other line is as it was.

## Also acceptable

- The document left open in TextEdit after saving.

## Not done

- The edit made but the file on disk still has the old amount (not saved, and not autosaved yet).
- The new amount added beside the old one (the two numbers run together, or two {{line}} lines).
- Another line's amount changed, or the file saved under another name or as rich text.

## What the checks cover

- `new-amount` counts the exact new line in the saved file.
- `rest-same` compares the saved file with the pristine copy with that one line changed; it is exact up to trailing
  newlines, so an unsaved edit, a second change or rich text fails.

## Side effects that fail the task

- Any other file in Documents changed or deleted.
