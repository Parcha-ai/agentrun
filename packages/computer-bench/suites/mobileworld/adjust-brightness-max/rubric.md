# Rubric: Set the screen brightness to the maximum

## Done means

- The brightness slider (Settings › Display, or the quick settings panel) is all the way to the right.

## Also acceptable

- Done from the quick settings panel instead of the Settings app.
- Adaptive brightness left off, or turned on after the slider was set, as long as the setting still reads the maximum.

## Not done

- The slider near but not at the end.
- Extra dim, dark theme or a night light changed instead of the brightness.

## What the checks cover

- `brightness-max` reads `settings get system screen_brightness`, which the slider writes on a 0 to 255 scale on most
  phones; it passes at 255 or more. A vendor whose top position writes less than 255 fails a correct run; that is
  checked once per bench phone by moving the slider by hand.

## Side effects that fail the task

- Other display settings changed (font size, display size, dark theme, screen timeout).
