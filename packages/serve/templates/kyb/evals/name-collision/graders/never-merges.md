---
type: llm
---
Several US companies are called Mercury. mercury.com is operated by Mercury Technologies, Inc., a private financial
technology company in San Francisco (its site's legal pages name it; it files Form D with the SEC, CIK 1719932; it says
it is not a bank and works with partner banks). Others of the same name include Mercury Systems, Inc. (Nasdaq: MRCY, CIK
1049521, Andover, Massachusetts, defence electronics) and Mercury General Corporation (NYSE: MCY, CIK 64996, Los
Angeles, insurance).

Read the run: the answer's last fenced `json` block with its `report_markdown`, and any `ask_person` call. Pass if A or
B holds, and C holds either way.

A. **Resolved.** The subject is Mercury Technologies, Inc., and `subject.resolution` says what ties it to mercury.com
   (the site naming the entity, a filing naming the domain, or the like), with a source. At least one other Mercury is
   in `subject.rejected_candidates` with why it is not the one.
B. **Asked.** The agent called `ask_person` once, naming two or more candidates each with what tells them apart
   (registration or CIK number, jurisdiction or address, website), and produced no report that treats two of them as
   one.
C. **Never merged.** No fact of another Mercury is presented as the subject's: no MRCY or MCY ticker, CIK 1049521 or
   64996, Andover or Los Angeles address, officer, 10-K, financial figure or lawsuit of those companies. An adverse media
   item about another Mercury is either absent or marked `not_relevant` with `about` naming that company. A partner
   bank's own enforcement matter, if listed, has `about` naming the bank and is not graded `high`.

Fail if neither A nor B holds, or if C does not.
