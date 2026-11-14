# Rubric: Set the font size and turn on bold text in Settings

## Done means

- The font size is {{x.say}} (font_scale) and bold text is on (font_weight_adjustment 300).
- The display size is unchanged.

## Not done

- The font size one step off, or the display size changed instead of the font size.
- Bold text left off.

## What the checks cover

- `size-and-bold` reads font_scale and font_weight_adjustment together.

## Side effects that fail the task

- Display size, color, contrast or other accessibility settings changed.
