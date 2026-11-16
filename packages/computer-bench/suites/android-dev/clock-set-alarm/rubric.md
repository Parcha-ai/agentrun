# Rubric: Set a labelled alarm in Clock

## Done means

- The Clock app's alarm list holds one enabled alarm at {{t.say}} with the label "{{label}} {{nonce}}".

## Also acceptable

- The alarm repeating on some days, as long as it is on and the next ring is at {{t.say}}.
- Sound, vibration or snooze left at their defaults or changed.

## Not done

- The alarm at the right minute but the wrong half of the day (AM against PM).
- No label, or a label with a typo or the six-character code left out.
- A timer, a bedtime schedule or a reminder made instead of an alarm.
- The alarm made but switched off.

## What the checks cover

- `next-alarm` reads AlarmManager's next alarm clock: it proves an enabled alarm rings next at {{t.hh}}:{{t.mm}},
  exact to the minute. It can't see the label; the grader reads the label from the alarm list in the last
  screenshots or the tree.

## Side effects that fail the task

- Any other alarm deleted, switched off or changed.
