# Rubric: Turn on flight mode

## Done means

- Flight mode (airplane mode) is on: the switch in Settings › Network & internet (or Connections) is on and the
  airplane icon shows in the status bar.

## Also acceptable

- Done from the quick settings tile instead of the Settings app.
- Wi-Fi or Bluetooth turned back on by the phone itself while flight mode is on (some phones remember this).

## Not done

- Only mobile data, Wi-Fi or Bluetooth turned off, with flight mode off.
- Flight mode turned on and then off again.

## What the checks cover

- `flight-mode-on` reads `settings get global airplane_mode_on`; it is exact for the system flight mode.

## Side effects that fail the task

- Other network settings changed (mobile data, a SIM turned off, a Wi-Fi network forgotten).
