# Rubric: Move a note into another folder

## Done means

- The note "{{title}} {{nonce}}" is in the folder "{{folder}} {{nonce}}" and nowhere else.
- Its text is unchanged: the title, then "filed by computer-bench".

## Not done

- The note copied into the folder while the original stays in Notes (two notes with the title).
- A new folder made with a similar name and the note moved there.
- The note's text retyped or changed on the way.

## What the checks cover

- `in-folder` reads the container of the one live note with the title; it fails when there are zero or two.
- `text-kept` reads the note's plain text; it can't see formatting, which the task doesn't touch.

## Side effects that fail the task

- Any other note moved, deleted or changed, or another folder deleted or renamed.
