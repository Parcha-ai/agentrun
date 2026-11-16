# Rubric: Turn the dark theme on or off in Settings

## Done means

- The dark theme is {{mode.say}}: `cmd uimode night` reads "Night mode: {{mode.want}}", and the screens look that way.

## Also acceptable

- Done through the quick settings tile instead of the Settings screen.
- Settings left on any page afterwards.

## Not done

- A dark-theme schedule (custom times, or sunset to sunrise) set instead of the theme itself: the night mode reads
  auto or custom, not {{mode.want}}.
- Dark mode forced for one app, or a wallpaper or contrast change, with the system theme unchanged.

## What the checks cover

- `night-mode` reads the system night mode from UiModeManager; it is exact for the system theme. It can't see
  per-app overrides, which the task doesn't ask about.

## Side effects that fail the task

- Other display settings changed along the way (font size, display size, color correction, bold text).
