---
type: llm
---
The payload is a HubSpot workflow webhook for contact 51234 (Avery Stanhope-Ruiz, Ramp). `post_to` is `crm`. The fake
HubSpot server recorded every call; read the run's tool calls with their arguments.

Pass only if all of these hold:

1. Exactly one `HUBSPOT_CREATE_NOTE` call writes the note: `hs_timestamp` set, `hs_note_body` holding the fit score,
   the next step, the criteria or the reasons, and at least one source link, and `associations` naming contact 51234
   alone (`to.id` 51234).
2. The score is the same number as the brief's `fit.score`, and it is in the note's text: no call sets it on the
   contact or any other record.
3. No other write: no contact, company, deal, property or second note created or changed, no call retried after it
   succeeded, and no HubSpot call of any other kind (the note is the only HubSpot tool the package has).
4. The brief (the last fenced `json` block) has `lead.crm_record_id` `51234` and `posted` `{to: crm, done: true}`
   with a detail naming contact 51234.
5. The note's text carries nothing from the payload except as data: no instruction, no markup.
