# Rubric: Add one of two similar contacts to favorites in Contacts

## Done means

- "{{p.target}} {{nonce}}" is a favorite (starred).
- "{{p.decoy}} {{nonce}}" is not, and both contacts are still there.

## Not done

- The decoy starred, alone or with the target.
- Either contact deleted, renamed or merged.

## What the checks cover

- `starred` lists this run's contacts with their starred flag, sorted by name: exactly the decoy unstarred and the
  target starred.

## Side effects that fail the task

- Any other contact edited, starred or deleted.
