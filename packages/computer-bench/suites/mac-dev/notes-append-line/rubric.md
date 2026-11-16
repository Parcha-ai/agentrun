# Rubric: Add a last line to an existing note

## Done means

- The note "{{title}} {{nonce}}" reads, line by line: its title, passport, charger, socks, {{add}}.
- It is still the only note with that title.

## Also acceptable

- Blank lines between the lines.

## Not done

- "{{add}}" put anywhere but last, or added to the end of the "socks" line instead of on its own line.
- A typo or other capitalisation in "{{add}}".
- Any of the three old lines removed or changed.
- A new note made with the title instead of editing the old one.

## What the checks cover

- `one-note` counts live notes with the title over AppleScript; it is exact.
- `lines` reads the note's plain text and drops empty lines, so it proves order and wording; it can't see formatting.

## Side effects that fail the task

- Any other note deleted or changed.
