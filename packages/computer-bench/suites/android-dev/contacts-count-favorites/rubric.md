# Rubric: Count and name the favorite contacts in Contacts

## Done means

- The final answer says there are {{f.count}} favorites and names each of them by first name.
- No contact was changed.

## Also acceptable

- Full names with the six-character code, or without it.
- The count as a digit or a word.

## Not done

- A wrong count, a missing favorite, or a contact that is not a favorite named as one.
- Counting all eight contacts.

## What the checks cover

- `count` finds the count and every favorite's first name in the answer. It can't see an extra name added; the
  grader reads the answer for that.
- `unchanged` counts the run's contacts and the starred ones.

## Side effects that fail the task

- Any contact starred, unstarred, edited or deleted.
