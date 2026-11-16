# Rubric: Move the Dock to another edge of the screen in System Settings

## Done means

- "Position on screen" in System Settings › Desktop & Dock is set so the Dock sits {{pos.say}} of the screen.

## Also acceptable

- The position changed through the Dock's own context menu ("Position on Screen"); it writes the same value.

## Not done

- Another edge than the asked one.
- Another Dock setting changed instead (size, magnification, auto-hide).

## What the checks cover

- `orientation` reads com.apple.dock orientation, the value the setting writes; it is exact.

## Side effects that fail the task

- Other Dock or Desktop settings changed (size, auto-hide, Stage Manager, hot corners).
