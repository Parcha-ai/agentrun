# Rubric: Turn Dock auto-hiding on or off in System Settings

## Done means

- "Automatically hide and show the Dock" is {{mode.say}} in System Settings › Desktop & Dock.

## Also acceptable

- The setting changed through the Dock's own context menu ("Turn Hiding On/Off"); it writes the same value.

## Not done

- Another Dock switch changed instead (magnification, minimise effect, recent apps), leaving auto-hide as it was.
- The switch toggled twice, ending where it started.

## What the checks cover

- `autohide` reads com.apple.dock autohide, the value the switch writes; it is exact.

## Side effects that fail the task

- Other Dock or Desktop settings changed (size, position, Stage Manager, hot corners).
