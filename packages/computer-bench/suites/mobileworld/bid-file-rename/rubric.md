# Rubric: Rename the bid_ files in Download by date, oldest first

## Done means

- The four files in Download that began with bid_ are now named {{o.want}}: the oldest is bid_1, the newest bid_4, and
  each keeps its own extension.
- The eleven other files in Download keep their names.

## Also acceptable

- The renames done in any order, in any file manager.
- The dates read from the file manager's list (sorted by date, or the details of each file).

## Not done

- Numbers given by name order or newest first.
- An extension changed or dropped (bid_2 without .doc), or numbering from 0.
- A file copied instead of renamed, so the old name or a second copy is left.
- A file that did not begin with bid_ renamed into the bid_ series.

## What the checks cover

- `renamed-in-order` lists the bid_ names in Download (exact) and compares the dates of bid_1 to bid_4; renaming keeps
  a file's date, so rising dates show each number went to the right file. A copy made in place of a rename gets a new
  date and fails.
- `others-kept` counts the eleven other files by name.

## Side effects that fail the task

- Files in Download deleted or changed, other than the four renames.
