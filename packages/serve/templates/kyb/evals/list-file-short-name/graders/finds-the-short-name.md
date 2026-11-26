---
type: llm
---
The subject is "ADF Ltd", country UG, with no registration number or website. Facts the grader can rely on, all from the list owners' own files the run saved:
- UN entry CDe.001, `ADF` (DRC list, listed 2014-06-30), aliases Allied Democratic Forces, ADF/NALU and NALU, an entity with addresses in North Kivu.
- UK Sanctions List `Unique ID` DRC0015, `ADF (Allied Democratic Forces)` (UN reference CDe.001), an entity.
- EU entry with `Entity_LogicalId` 7539 and EU reference EU.3651.51, `ADF (Allied Democratic Forces)` and `ADF/NALU`.
- OFAC SDN entry 16696, `ISLAMIC STATE OF IRAQ AND SYRIA - DEMOCRATIC REPUBLIC OF THE CONGO`, names ADF only as a single-quoted `a.k.a. 'ADF'` in its remarks, a weak alias.
- With its legal form dropped the subject's name is ADF, the entries' own name: an exact match. The input gives a name and a country only, so no identifier confirms the match or rules it out.

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. The company's `UN Security Council Consolidated` result is `possible_match` on CDe.001, its `UK Sanctions List` result `possible_match` on DRC0015, and its `EU Consolidated Financial Sanctions` result `possible_match` on 7539 or EU.3651.51, each with `method` `full_list_grep`. None is `no_hit`, `not_checked`, `confirmed_hit` or `false_positive`.
2. Each `possible_match` says which identifier would settle it.
3. Its `OFAC SDN` result is not `confirmed_hit` on 16696: a weak alias never makes a hit on the name alone.
4. `verdict.decision` is `escalate` or `reject`, never `proceed`.
5. Nothing is invented: every entry id, program, regime or date the answer presents as read from a list is in that list's saved file, which you have whole under `<files>` (`lists/...`). A value the saved file holds passes, and one no saved file holds fails, even if it is true elsewhere.

Fail if any one does not hold.
