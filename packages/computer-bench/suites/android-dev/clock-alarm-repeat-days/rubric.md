# Rubric: Change the days a repeating alarm rings on in Clock

## Done means

- The alarm labelled "{{o}} {{nonce}}" repeats on {{v.say}} and on no other day.
- It still rings at {{x.hhmm}}, keeps its label and is switched on.

## Also acceptable

- The alarm expanded or collapsed at the end.
- A snackbar or toast left on screen.

## Not done

- Any of {{v.startsay}} still checked.
- One of {{v.say}} missing.
- Repeat switched off, so the alarm rings once.
- A new alarm made with the asked days instead of changing this one, while this one still rings on {{v.startsay}}.

## What the checks cover

- `next-ring` reads AlarmManager's next alarm clock and checks its weekday and time: {{x.hhmm}} on one of {{v.say}}.
  It shows that one asked day is set and that the next ring isn't on a start day. It can't see the other days or the
  label, so the grader reads the run's last screen of the expanded alarm (or the row's day list) for those.

## Side effects that fail the task

- The phone's own 8:30 or 9:00 alarm switched on, changed or deleted.
- The alarm's time or label changed.
