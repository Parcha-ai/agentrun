# Rubric: Delete one of two similar contacts in Contacts

## Done means

- "{{s.del}} {{nonce}}" is gone and "{{s.keep}} {{nonce}}" is still there, unchanged.

## Not done

- {{s.keep}} deleted, alone or with {{s.del}}.
- {{s.del}} renamed or its number removed instead of deleting the contact.

## What the checks cover

- `left` lists this run's contacts by name: exactly {{s.keep}}, not starred.

## Side effects that fail the task

- Any other contact edited or deleted.
