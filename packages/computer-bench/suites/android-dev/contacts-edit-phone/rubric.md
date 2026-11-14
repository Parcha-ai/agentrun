# Rubric: Change a contact's phone number in Contacts

## Done means

- "{{who.first}} {{who.last}} {{nonce}}" has the phone number {{p.new}} and no longer has {{p.old}}.

## Also acceptable

- The number shown with the Contacts app's own spacing or a +1 country code.
- The number's label changed along the way.

## Not done

- {{p.new}} added as a second number while {{p.old}} stays.
- A new contact made with {{p.new}} instead of editing this one.
- The edit typed but not saved.

## What the checks cover

- `new-number` and `old-gone` read the contact's phone rows by exact display name and match digits in order; together
  they are exact for this contact. They can't see a duplicate contact under another name; the grader checks the list.

## Side effects that fail the task

- The contact's name changed, or any other contact edited or deleted.
