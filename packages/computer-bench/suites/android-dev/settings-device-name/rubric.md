# Rubric: Read the phone's device name from Settings

## Done means

- The final answer gives the device name "{{label}} {{nonce}}", read from Settings (About phone, or wherever this
  phone's Settings shows the device name).

## Also acceptable

- The name in quotes or inside a sentence ("The device name is {{label}} {{nonce}}.").
- Other capitalisation.

## Not done

- The model name (such as "Pixel 8") or the Bluetooth name given instead of the device name.
- The name with the six-character code left out or mistyped.
- An answer that lists several candidate names.

## What the checks cover

- `named` reads the final answer; it is exact up to case. It can't see how the agent got there; the trajectory shows
  whether it read Settings.

## Side effects that fail the task

- The device name (or any other setting) changed: the task only reads.
