# Rubric: Add a contact with a mobile number in Contacts

## Done means

- One saved contact named "{{who.first}} {{who.last}} {{nonce}}" exists, with the phone number {{phone.say}}.

## Also acceptable

- The whole name typed into one name field, when the contact's shown name comes out the same.
- The number labelled other than Mobile, or shown with the Contacts app's own spacing or a +1 country code.
- The contact saved to the phone or to a signed-in account.

## Not done

- The contact made twice.
- The name or number with a typo, a digit missing, or the six-character code left out.
- The form filled in but never saved (the editor still open, or backed out with "Discard").

## What the checks cover

- `one-contact` counts contacts with the exact display name; it is exact.
- `number` reads the contact's phone rows and matches the digits in order, so formatting doesn't matter. It can't see
  the number's label, which the grader may judge from the screen.

## Side effects that fail the task

- Any other contact edited, merged or deleted.
