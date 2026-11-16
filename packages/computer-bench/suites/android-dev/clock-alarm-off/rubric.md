# Rubric: Stop a labelled alarm from ringing in Clock

## Done means

- The alarm labelled "{{label}} {{nonce}}" is switched off or gone from the alarm list.

## Also acceptable

- Deleted instead of switched off (the instruction allows either).
- Its upcoming ring dismissed from the notification, when that leaves the alarm with no next ring.

## Not done

- Only the next occurrence skipped while the alarm stays on for later days.
- Snoozed, or its sound set to silent, with the alarm still on.

## What the checks cover

- `not-next` reads AlarmManager's next alarm clock and passes when it isn't at {{t.hh}}:{{t.mm}}. It can't see the
  other alarms; the grader checks the list in the last screenshots for collateral changes.

## Side effects that fail the task

- Any other alarm switched off, deleted or changed.
