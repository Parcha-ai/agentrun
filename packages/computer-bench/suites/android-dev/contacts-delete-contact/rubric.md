# Rubric: Delete one of two similar contacts in Contacts

## Done means

- No contact named "{{who.first}} {{who.last}} {{nonce}}" is left.
- "{{who.keep}} {{who.last}} {{nonce}}" is still there, unchanged.

## Not done

- "{{who.keep}} {{who.last}} {{nonce}}" deleted, alone or with the asked one.
- The contact's number or name cleared but the contact itself kept.
- The delete confirmation dialog left open without confirming.

## What the checks cover

- `deleted-and-kept` counts both contacts by exact display name in one read; it is exact for the two contacts setup
  made. It can't see other contacts; the grader checks for collateral deletions on the screen.

## Side effects that fail the task

- Any other contact deleted, merged or edited.
