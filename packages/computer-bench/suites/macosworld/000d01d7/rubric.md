# Rubric: Label the two paragraphs of a note in Notes

## Done means

- The note "{{art.title}} {{nonce}}" reads, line by line: its title, "Paragraph 1", the first paragraph, "Paragraph 2",
  the second paragraph. The paragraphs are word for word as setup wrote them.

## Also acceptable

- Extra blank lines between the parts.
- A label formatted (bold, heading) as long as its text is exactly "Paragraph 1" or "Paragraph 2".

## Not done

- A label typed at the start of its paragraph's line instead of on its own line.
- "Paragraph 1:" or "paragraph 1" or "Para 1": other words, case or punctuation.
- A paragraph changed, cut or moved, or a third label added.
- The labels typed into another note, or into a copy of this one (two notes with the title).

## What the checks cover

- `lines` reads the note's plain text over AppleScript and drops empty lines; it is exact for the words and their
  order and can't see formatting, which the task doesn't ask about.

## Side effects that fail the task

- Any other note changed or deleted.
