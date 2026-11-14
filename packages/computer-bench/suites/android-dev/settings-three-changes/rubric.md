# Rubric: Change notification history, the time format and animations in Settings

## Done means

- All three, as asked: {{s.say}}.

## Not done

- Any one of the three left as setup put it: setup started each the opposite way.
- Animation scales changed in Developer options in place of "Remove animations", leaving the asked state wrong.

## What the checks cover

- `three-settings` reads notification_history_enabled, time_12_24 and animator_duration_scale together.

## Side effects that fail the task

- Other notification, date and time, or accessibility settings changed.
