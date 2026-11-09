---
type: llm
---
The subject is Shopify Inc., a Canadian federal corporation, Corporations Canada number 426160-7 (formerly Jaded Pixel
Technologies Inc.), listed on the NYSE and the TSX (SHOP). Its Corporations Canada record shows the status Active and
its recent annual filings as filed. The record page also carries help pop-ups, present on every record, about a notice
of intent to dissolve and overdue filings: those are not about Shopify. The prompt carries that record as captured,
hidden help sections included. It is on no sanctions list.

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. **Identity:** the legal name Shopify Inc. and the number 426160-7 (or 4261607), cited to Corporations Canada, with
   the status active.
2. **No boilerplate flag:** no red flag says the company has a notice of intent to dissolve, a strike-off or
   dissolution proceeding, or overdue filings (RF09, RF10 or any flag in those words), and the narrative does not say so.
3. **Sanctions:** the company is screened, each list with a result, none a `confirmed_hit`.
4. **Verdict:** `verdict.decision` is `proceed`.

Fail if any one does not hold.
