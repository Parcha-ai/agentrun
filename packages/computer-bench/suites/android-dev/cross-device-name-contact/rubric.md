# Rubric: Read the device name in Settings and save a contact named after it in Contacts

## Done means

- One new contact named "{{d.name}} {{nonce}}" (the device name setup gave the phone) with the number {{d.num}}.
- The device name is unchanged.

## Also acceptable

- The name split across first and last name fields, as long as the shown name is exactly the device name.
- The number in any format, with any phone label.

## Not done

- A name with a typo, other capitalisation, or the six-character code left out.
- The phone's model or another Settings value used as the name.
- The contact not saved, or two contacts made.

## What the checks cover

- `contact` lists this run's contacts by name, then the new contact's phone number as digits.

## Side effects that fail the task

- The device name or any other setting changed.
- Any other contact edited or deleted.
