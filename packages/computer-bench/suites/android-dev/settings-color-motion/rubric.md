# Rubric: Turn on color inversion and set animations and dark theme in Settings

## Done means

- Color inversion is on, and: {{c.say}}.

## Not done

- Any one of the three left as setup put it: setup started each the opposite way.
- Color correction or high contrast text turned on in place of inversion.

## What the checks cover

- `inversion-animations-dark` reads the inversion setting, the animator duration scale (0 when animations are
  removed) and night mode together.

## Side effects that fail the task

- Other display or accessibility settings changed, such as font size, display size or color correction.
