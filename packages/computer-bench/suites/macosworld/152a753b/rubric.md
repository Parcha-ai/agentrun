# Rubric: Work out a trigonometric value in radians with Calculator

## Done means

- Calculator's last result is {{f.say}} with the angle in radians, {{f.want}} to six decimals, worked out in Calculator
  (Scientific mode, radians, π key or 3.14159... typed in full).

## Also acceptable

- A value that differs from {{f.want}} only past the sixth decimal (Calculator's floating point, such as
  0.9999999999999999 for tan(π/4)).
- Calculator left in Scientific mode, open or closed.

## Not done

- The function worked out in degrees mode.
- π rounded to 3.14 by hand, so the result is off in the sixth decimal.
- The answer typed in from memory (such as 0.5 then =) without using the function: the checks can't tell, so the grader
  looks at the agent's steps for this one.

## What the checks cover

- `result` reads the LastResultValue preference Calculator saves for its last result, to six decimals. It can't see
  how the value was reached. The source ran on macOS 15; that Calculator on macOS 26 still saves this key is proven only
  once the oracle passes on the bench Mac.

## Side effects that fail the task

- Other apps opened and changed (a note, a file) to hold the answer.
