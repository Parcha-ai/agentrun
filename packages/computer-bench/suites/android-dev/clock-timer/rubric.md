# Rubric: Start a countdown timer in Clock

## Done means

- A timer for {{t.say}} is running in the Clock app.

## Also acceptable

- The timer started a few seconds after it was set.
- The timer screen left open.

## Not done

- A timer set but not started, or set for another length (for example {{t.mm}} seconds or hours).
- A stopwatch or an alarm in place of a timer.

## What the checks cover

- `timer-running` reads the Clock app's TIMER_EXPIRED alarm in AlarmManager: it is set, and the time left fits a
  {{t.mm}}-minute timer started during the run. It can't tell a timer a few minutes shorter, started late in the run,
  from the asked one: the length is yours to judge from the run's screens and actions.

## Side effects that fail the task

- An alarm added or changed.
