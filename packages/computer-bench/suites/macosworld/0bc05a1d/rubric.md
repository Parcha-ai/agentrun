# Rubric: Make a new note with an empty table in Notes

## Done means

- A new note exists in Notes (made during the run, not in Recently Deleted) and holds a table with no text in any cell.

## Also acceptable

- A table of any size, Notes' default or another.
- A title or other text in the note outside the table.
- More than one new note, as long as the tables in them are empty.

## Not done

- A table added to a note that existed before the run, with no new note.
- Text typed into any cell.
- A grid drawn with characters (dashes, pipes) or a checklist instead of a Notes table.

## What the checks cover

- `empty-table` reads the HTML body of every note made since setup over JavaScript for Automation, counts its
  `<table>` elements and the cells that hold text; it is exact for "a new note has a table and the tables are empty". It
  can't see notes changed but not made in the run.

## Side effects that fail the task

- Any note that existed before the run changed or deleted.
