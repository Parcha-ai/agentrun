# Rubric: Add a reminder with a priority to a given list

## Done means

- The list "computer-bench {{nonce}}" holds one open reminder "{{item}} {{nonce}}" with {{prio.say}} priority.

## Also acceptable

- A due date, note or flag added as well.

## Not done

- The reminder in another list (such as the default Reminders list).
- No priority, or another level than {{prio.say}}.
- Extra characters left in the name (such as "!" marks that Reminders did not turn into a priority).
- The reminder ticked off, or made twice.

## What the checks cover

- `one-reminder` counts the list's reminders with the name; it is exact.
- `priority` reads the reminder's priority and completed flag over AppleScript; it is exact for the band.

## Side effects that fail the task

- Reminders of other lists deleted, completed or changed.
