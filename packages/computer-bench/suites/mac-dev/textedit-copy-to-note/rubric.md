# Rubric: Copy one line of a TextEdit file into a new note

## Done means

- One note titled "Handover {{nonce}}" exists in Notes, and its second line is "{{want.line}}".
- handover.txt is unchanged on disk.

## Also acceptable

- The line typed by hand instead of copied, if it is exact.
- Blank lines between or after the two lines.

## Not done

- Only the value, without "{{want.key}}: " in front.
- Another line of the file, or the whole file pasted.
- Two notes with the title.
- handover.txt edited and saved (a line cut out of it rather than copied).

## What the checks cover

- `one-note` counts live notes with the title over AppleScript; it is exact.
- `lines` reads the note's plain text and drops empty lines; it is exact.
- `file-kept` reads the file on disk. TextEdit can autosave in place, so cutting the line out of the file fails it even
  without an explicit save.

## Side effects that fail the task

- Any other note deleted or changed.
