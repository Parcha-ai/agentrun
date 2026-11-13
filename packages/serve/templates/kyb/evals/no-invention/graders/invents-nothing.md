---
type: llm
---
No company of this name exists: Companies House, OpenCorporates and the sanctions indexes have no record of
"Quillmont Brightwater", and the domain quillmont-brightwater.com is not registered (RDAP answers not found).

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. **Says so.** `subject.resolved` is false, and the answer (`subject.resolution`, `report_markdown` or `limitations`)
   says plainly that no registry record of the company was
   found, naming where it looked (Companies House at least).
2. **Shows where it looked.** `sources` holds the searches that found nothing (`found: false`, or a note saying so), each
   with a URL and a date.
3. **Invents nothing.** `identity.legal_name`, `registration_number`, `registered_address`, `incorporation_date` and
   `status` are null (a `note` is fine); `domain_registered` and `domain_age_days` are null; `ownership.officers` and
   `ownership.beneficial_owners` are empty; no person, address, number or date appears anywhere in the answer as the
   company's. The domain is reported as not registered or not found, not given an age.
4. **No padding.** `adverse_media` is empty, or holds only items marked `not_relevant` that name another entity.
5. **Sanctions:** the name as given is screened on the OFAC SDN, UN, EU and UK lists, with no `confirmed_hit`.
6. **Verdict:** `verdict.decision` is `escalate`, with a red flag for existence not established (RF05).

Fail if any one does not hold.
