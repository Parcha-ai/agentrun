# Rubric: Switch the clock between 12-hour and 24-hour time in Settings

## Done means

- The phone shows the time in {{f.say}}: system setting time_12_24 is {{f.want}}.

## Also acceptable

- "Use locale default" left off, as setup left it.

## Not done

- The format left as it was, or switched only in the Clock app's own settings.
- The change made with a shell command instead of the Settings app.

## What the checks cover

- `format` reads time_12_24, which the Settings switch "Use 24-hour format" writes.

## Side effects that fail the task

- The date, time or time zone changed.
