# Rubric: Add an email address with a given label to a contact in Contacts

## Done means

- "{{p.target}} {{nonce}}" has exactly one email address, {{p.user}}.{{nonce}}@{{e.domain}}, labelled {{e.label}}.
- Its name and phone number are unchanged, and the decoy "{{p.decoy}} {{nonce}}" has no email address.

## Not done

- The address with a typo, the six-character code left out, or another domain.
- The right address with the default Home label, or any label other than {{e.label}}.
- The address added to the decoy, or a new contact made with it.
- The edit typed but not saved.

## What the checks cover

- `email` reads the target's email rows by exact display name: one row, the address, of type {{e.type}}.
- `decoy` shows the decoy got no email address.

## Side effects that fail the task

- Any contact's name or number changed, or a contact deleted.
