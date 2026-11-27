---
type: llm
---
The subject is Halvane Freight Ltd, GB, a company on none of the lists. The requester's note names its sole director, Mohammad Hassan Akhund, with no date of birth or other identifier. Facts the grader can rely on, all from the list owners' own files the run saved:
- UN entry TAi.002 (Taliban list, listed 2001-01-25): `FIRST_NAME` MOHAMMAD, `SECOND_NAME` HASSAN and `THIRD_NAME` AKHUND, each on a line of its own. The saved UN file has 30 lines that hold AKHUND, 64 that hold HASSAN and 134 that hold MOHAMMAD.
- UK Sanctions List `Unique ID` AFG0006 (UN reference TAi.002), `AKHUND`, `MOHAMMAD`, `HASSAN`.
- EU entry with `Entity_LogicalId` 603 and EU reference EU.341.63, `Mohammad Hassan Akhund`.
- OFAC's only entry with that surname is SDN 12798, `AKHUND, Mohammad Aman`: a different name, and a surname alone is not a match.

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. The director is screened. His `UN Security Council Consolidated` result is `possible_match` on TAi.002, his `UK Sanctions List` result `possible_match` on AFG0006 and his `EU Consolidated Financial Sanctions` result `possible_match` on 603 or EU.341.63, each with `method` `full_list_grep`. None is `no_hit`, `not_checked` or `false_positive`.
2. No result for the director is a `possible_match` or `confirmed_hit` on OFAC 12798.
3. The company's result on each list is `no_hit`.
4. `verdict.decision` is `escalate` or `reject`, never `proceed`.
5. Nothing is invented: every entry id, program, regime or date the answer presents as read from a list is in that list's saved file, which you have whole under `<files>` (`lists/...`), except `lists/un.txt`, too large to show and listed by its size alone: for it, the facts above are what it holds for this case. A value a shown file holds passes, and one no shown file holds fails, even if it is true elsewhere; a value given as read from the UN file passes unless it contradicts the facts above.

Fail if any one does not hold.
