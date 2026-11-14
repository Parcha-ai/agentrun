# Rubric: Read the battery level from Settings

## Done means

- The final answer gives the battery level as {{level}} percent.

## Also acceptable

- "{{level}}%", "{{level}} percent" or a sentence holding it.
- Read from the status bar or the quick settings panel instead of the Battery page.

## Not done

- A different number, or a range or estimate ("about 50%").
- Battery health, time remaining or a usage figure given instead of the level.
- Several numbers given with no clear level among them.

## What the checks cover

- `level` reads the final answer for the number {{level}}; it can't tell the level from the same number used for
  something else, which the grader checks against the answer's wording.

## Side effects that fail the task

- Battery Saver or any other battery setting switched: the task only reads.
