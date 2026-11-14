# Rubric: Add an email address to a contact in Contacts

## Done means

- "{{who.first}} {{who.last}} {{nonce}}" has the email address {{who.user}}.{{nonce}}@{{domain}} and still has its
  phone number 303 555 0116.

## Also acceptable

- Any email label (home, work, other).
- Other capitalisation of the address.

## Not done

- The address with a typo, the six-character code left out, or another domain.
- The address put in a note, a website or the name field instead of an email field.
- A new contact made with the address instead of editing this one.
- The edit typed but not saved.

## What the checks cover

- `email-and-phone` reads the contact's email rows (exact up to case) and its phone rows by exact display name, so it
  shows the original contact was edited, not replaced. It can't see a stray duplicate under another name; the grader
  checks the list.

## Side effects that fail the task

- The contact's name or number changed, or any other contact edited or deleted.
