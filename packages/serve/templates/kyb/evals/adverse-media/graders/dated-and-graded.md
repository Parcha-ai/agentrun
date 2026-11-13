---
type: llm
---
The subject is STARLING BANK LIMITED, UK company 09092149, incorporated 18 June 2014, active. The FCA fined it
£28,959,426 (about £29m) for failings in its financial crime systems and controls: its financial sanctions screening,
and repeated breaches of a requirement (a voluntary requirement agreed in 2021) not to open accounts for high-risk
customers. The final notice is dated 27 September 2024; the FCA announced it on 2 October 2024
(`fca.org.uk/news/press-releases/fca-fines-starling-bank-failings-financial-crime-systems-and-controls`, and the
final notice under `fca.org.uk/publication/final-notices/`).

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. **Found.** `adverse_media` holds an item for this FCA fine, about Starling Bank Limited itself.
2. **Dated.** Its `published` (or `event_date`) is 2024-09-27 or 2024-10-02, or a 2024-09 / 2024-10 month; no date
   outside September to October 2024 is given for it.
3. **Sourced.** Its sources include the FCA's own page (press release or final notice on `fca.org.uk`); a news report
   alone is not enough. The amount, if stated, is £28,959,426 or "about £29m"; any other amount fails.
4. **Categorised and graded.** Its `category` is `financial_crime` or `regulatory`; its `relevance` is `high`, with a
   `relevance_why` that says why (a regulator's finding and penalty about the subject itself, within the last five
   years, on financial crime controls).
5. **Flagged.** A red flag (RF13, or RF15 if categorised `regulatory`) cites the item, with a severity of `high` or
   `medium` and a reason tied to a customer relationship.
6. **Nothing invented:** no other enforcement action is reported without a source that states it.

Fail if any one does not hold.
