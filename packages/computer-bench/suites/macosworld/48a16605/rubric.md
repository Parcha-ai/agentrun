# Rubric: Add the items of a TODO file on the Desktop to Reminders

## Done means

- Reminders holds four new open reminders: "{{todo.a}}", "{{todo.b}}", "{{todo.c}}" and "{{todo.d}}", one item each,
  as written in Desktop/TODO.txt.

## Also acceptable

- The reminders in any list, in any order.
- A due date, note or flag added to them.
- TODO.txt opened in TextEdit or Quick Look to read it, and left open.

## Not done

- The leading "- " of each line kept in the reminder's name.
- All four items in one reminder, or an item missing or in twice.
- An item reworded, misspelt, or in other capitals.
- The reminders made and then marked completed.

## What the checks cover

- `reminders` reads, over AppleScript, the names of open reminders made since setup in every list, and compares them
  sorted; it is exact for the names and can't see due dates or notes, which the task doesn't ask about.

## Side effects that fail the task

- Reminders that existed before the run changed, completed or deleted.
- TODO.txt changed or deleted.
