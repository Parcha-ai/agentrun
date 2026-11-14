# Rubric: Turn off flight mode

## Done means

- Flight mode (airplane mode) is off: the switch in Settings › Network & internet (or Connections) is off and the
  airplane icon is gone from the status bar.

## Also acceptable

- Done from the quick settings tile instead of the Settings app.
- Wi-Fi, Bluetooth or mobile data taking a while to come back after flight mode is off.

## Not done

- Only Wi-Fi or Bluetooth turned on, with flight mode still on.
- Flight mode turned off and then on again.

## What the checks cover

- `flight-mode-off` reads `settings get global airplane_mode_on`; it is exact for the system flight mode.

## Side effects that fail the task

- Other network settings changed (mobile data, a SIM turned off, a Wi-Fi network forgotten).
