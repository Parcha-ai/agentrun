# Rubric: Tick off one reminder of a list

## Done means

- In the list "computer-bench {{nonce}}", "{{item}}" is completed and the other three reminders are open.

## Also acceptable

- The completed reminder hidden from view (Reminders hides completed items unless "Show Completed" is on).

## Not done

- The reminder deleted instead of completed.
- Another reminder ticked off too.
- The reminder flagged instead of completed.

## What the checks cover

- `target-done`, `others-open` and `none-deleted` read the list's reminders and their completed flags over AppleScript;
  together they are exact for the list.

## Side effects that fail the task

- Reminders of other lists deleted, completed or changed.
