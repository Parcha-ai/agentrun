# Rubric: Move a labelled alarm to a new time in Clock

## Done means

- The alarm labelled "{{label}} {{nonce}}" is on and set to {{t.to_say}}.
- No alarm is left on at {{t.from_say}}.

## Also acceptable

- The old alarm deleted and a new one made at {{t.to_say}} with the same label.

## Not done

- A second alarm added at {{t.to_say}} while the {{t.from_say}} one stays on.
- The new time in the wrong half of the day (AM against PM).
- The label dropped or changed.

## What the checks cover

- `next-alarm` reads AlarmManager's next alarm clock: it proves an enabled alarm rings next at {{t.thh}}:{{t.tmm}}. It
  can't see the label, and when the new time comes before the old one in the day it can't see an alarm left at the
  old time; the grader checks both in the alarm list of the last screenshots or tree.

## Side effects that fail the task

- Any other alarm switched off, deleted or changed.
