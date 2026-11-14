# Rubric: Add a labelled alarm that repeats on given days in Clock

## Done means

- A new alarm at {{x.hh}}:{{x.mm}}, switched on, labelled "{{n}} {{nonce}}".
- It repeats on {{s.say}} and on no other day.

## Also acceptable

- The time shown as {{x.find}} AM where the app uses a 12-hour clock.
- Other capitalisation of the label.
- The alarm expanded or collapsed at the end.

## Not done

- A one-off alarm (Repeat off), or a day missing or extra.
- The label left out, misspelt, or the six-character code left out.
- The wrong time, or {{x.hh}}:{{x.mm}} in the evening.
- One of the phone's own alarms changed to this time instead of adding a new one.

## What the checks cover

- `next-ring` reads AlarmManager's next alarm clock and checks its weekday and time: {{x.hh}}:{{x.mm}} on one of
  {{s.say}}. It shows an alarm at that time is on and its next ring is an asked day. It can't see the label or the
  other days, so the grader reads the run's last screen of the alarm for those.

## Side effects that fail the task

- The phone's own 8:30 or 9:00 alarm switched on, changed or deleted.
- More than one new alarm left behind.
