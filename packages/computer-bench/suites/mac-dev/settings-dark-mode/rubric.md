# Rubric: Set the Mac's appearance to Light or Dark in System Settings

## Done means

- System Settings › Appearance has {{mode.say}} chosen, and windows and the menu bar show it.

## Also acceptable

- The appearance changed from Control Center or another route to the same setting.

## Not done

- Auto chosen, even when it happens to show {{mode.say}} at this hour.
- Only the accent or highlight colour, or a wallpaper, changed.

## What the checks cover

- `appearance` reads dark mode from System Events, which follows the system appearance; it is exact.
- `not-auto` reads the global Auto key; it fails when Auto is chosen.

## Side effects that fail the task

- Other Appearance settings changed (accent colour, sidebar icon size, scroll bars).
