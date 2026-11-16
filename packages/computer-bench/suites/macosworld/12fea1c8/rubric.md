# Rubric: Solve a catch-up word problem in Calculator

## Done means

- Calculator's last result is the catch-up time in hours, {{c.gap}} / ({{c.b}} - {{c.a}}) = {{c.want}}, worked out in
  Calculator and ended with = (or Return).

## Also acceptable

- Any Calculator mode (Basic, Scientific), and any order of keys that gives the answer.
- Other sums done first, as long as the last one Calculator worked out gives the answer.
- Calculator left open or closed.

## Not done

- The answer said in words or typed somewhere else while Calculator's last result is another number.
- The answer in minutes, or a rounded value that is not the exact answer.
- A sum typed but not finished with =, so Calculator has no new result.

## What the checks cover

- `result` reads the LastResultValue preference Calculator saves at each =, to six decimals. It can't see a number that
  is only on the display without =. The source ran on macOS 15; that Calculator on macOS 26 still saves this key is
  proven only once the oracle passes on the bench Mac.

## Side effects that fail the task

- Other apps opened and changed (a note, a file) to hold the answer.
