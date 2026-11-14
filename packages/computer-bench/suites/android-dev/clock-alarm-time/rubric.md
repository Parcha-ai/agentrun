# Rubric: Read the time of a labelled alarm in Clock

## Done means

- The final answer gives the time of the alarm labelled "{{lab.say}} {{nonce}}": {{t.h}}:{{t.m}} in 24-hour terms
  (minutes as two digits), with AM or PM when written as 12-hour time.

## Also acceptable

- 12-hour or 24-hour spelling, a colon or a dot between hours and minutes, "AM" or "a.m.", alone or in a sentence.

## Not done

- The time of the "{{lab.decoy}} {{nonce}}" alarm.
- A 12-hour time with the AM or PM missing or wrong.
- Several times given with no clear answer among them.

## What the checks cover

- `time` reads the final answer for the asked time in the accepted spellings; it is strict about AM and PM because the
  decoy alarm shares digits with the asked one.

## Side effects that fail the task

- Any alarm switched off, deleted or edited: the task only reads.
