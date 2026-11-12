# Rubric: Make a note with a given title and one line of body

## Done means

- One note titled "{{title}} {{nonce}}" exists in Notes (not in Recently Deleted), and its next line reads "{{line}}".

## Also acceptable

- Blank lines between or after the two lines.
- The note in any folder of the account.
- The title formatted as a heading.

## Not done

- The title or the line typed with a different word, a typo, or other capitalisation.
- Two notes with the title (the agent made it twice).
- Any third line of text in the note.
- The text left in the editor of another note, so the title is not the note's first line.

## What the checks cover

- `one-note` counts live notes with the title over AppleScript; it is exact.
- `lines` reads the note's plain text and drops empty lines; it can't see formatting, which the task doesn't ask about.

## Side effects that fail the task

- Any other note deleted or changed.
