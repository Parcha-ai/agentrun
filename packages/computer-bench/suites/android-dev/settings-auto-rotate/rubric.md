# Rubric: Turn auto-rotate on or off in Settings

## Done means

- {{o.say}}: system setting accelerometer_rotation is {{o.want}}.

## Not done

- The setting left as setup put it.
- Only the home screen's own rotation option changed.

## What the checks cover

- `rotation` reads accelerometer_rotation, which the "Auto-rotate screen" switch and the Quick Settings tile write.

## Side effects that fail the task

- Other display settings changed.
