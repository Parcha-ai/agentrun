# Rubric: Read a contact's work number among several in Contacts

## Done means

- The final answer gives {{m.work}}, the work number of "{{c.target}} {{nonce}}".
- No contact was changed.

## Also acceptable

- Any common format: (628) 555-0193, 628-555-0193, +1 628 555 0193 and the like.

## Not done

- The target's mobile ({{m.mobile}}) or home ({{m.home}}) number, or the decoy's work number ({{m.decoywork}}).
- Several numbers given without saying which is the work one.

## What the checks cover

- `number` finds the work number's digits in the answer, in any common format.
- `unchanged` reads the target's three numbers and their types.

## Side effects that fail the task

- Any contact edited, starred or deleted, or a call placed.
