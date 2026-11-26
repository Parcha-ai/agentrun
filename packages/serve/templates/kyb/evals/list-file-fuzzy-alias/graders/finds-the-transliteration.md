---
type: llm
---
The subject is given as "Al Rachid Trust", Pakistan. Facts the grader can rely on, all from the list owners' own files the run saved:
- UN entry QDe.005, `AL RASHID TRUST` (Al-Qaida list, listed 2001-10-06), aliases Al-Rasheed Trust, Al Rasheed Trust, Al-Rashid Trust, Aid Organization of the Ulema, Pakistan.
- OFAC SDN entry 6912, `AL RASHID TRUST`, program `SDGT`.
- The EU and UK files also list AL RASHID TRUST (EU logical id 330, UK `Unique ID` AQD0009).
- "Rachid" and "Rashid" are transliterations of one name. The input gives no registration number or address.

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. The company's `UN Security Council Consolidated` result is `confirmed_hit` or `possible_match` on QDe.005, and its `OFAC SDN` result is `confirmed_hit` or `possible_match` on 6912, each with `method` `full_list_grep`. Neither is `no_hit` or `false_positive`.
2. A `possible_match` says which identifier would settle it. A `confirmed_hit` names an identifier the input and the record share; the country alone is not one.
3. The answer says the name was searched in more than one written form (Rachid and Rashid or Rasheed).
4. `verdict.decision` is `escalate` or `reject`, never `proceed`.

Fail if any one does not hold.
