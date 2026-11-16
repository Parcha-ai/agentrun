# Rubric: Set the screen timeout in Settings

## Done means

- Display > Screen timeout shows {{t.say}} selected, and system/screen_off_timeout reads {{t.want}}.

## Not done

- A neighbouring choice picked (a different number of minutes or seconds).
- Only "Screen attention" or "Adaptive timeout" switched, with the timeout unchanged.

## What the checks cover

- `timeout` reads the setting Settings writes; it is exact. It can't see whether the agent used search or the
  Display page, which the task doesn't care about.

## Side effects that fail the task

- Other display settings changed (brightness, dark theme, font or display size, lock screen options).
