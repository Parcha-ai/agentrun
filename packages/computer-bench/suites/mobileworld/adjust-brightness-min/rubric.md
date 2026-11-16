# Rubric: Set the screen brightness to the minimum

## Done means

- The brightness slider (Settings › Display, or the quick settings panel) is all the way to the left.

## Also acceptable

- Done from the quick settings panel instead of the Settings app.
- Adaptive brightness left off.

## Not done

- The slider near but not at the start.
- Extra dim (or "reduce bright colors"), dark theme or a night light turned on instead of lowering the slider.

## What the checks cover

- `brightness-min` reads `settings get system screen_brightness`, which the slider writes on a 0 to 255 scale on most
  phones; it passes at 0 or 1. A vendor whose lowest position writes more than 1 fails a correct run; that is checked
  once per bench phone by moving the slider by hand.

## Side effects that fail the task

- Other display settings changed (font size, display size, dark theme, extra dim, screen timeout).
