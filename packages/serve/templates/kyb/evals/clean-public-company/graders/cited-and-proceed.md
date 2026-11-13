---
type: llm
---
The subject is Apple Inc., SEC CIK 0000320193, incorporated in California, headquartered at One Apple Park Way,
Cupertino, listed on Nasdaq (AAPL). Its domain apple.com was registered on 1987-02-19 (RDAP). It is on no sanctions list.

Read the answer's last fenced `json` block, its `report_markdown` included. Pass only if all of these hold:

1. **Every claim has a source.** Each non-null identity fact, each officer and owner, each sanctions result, each
   adverse media item and each red flag lists at least one source id, every id cited exists in `sources`, and each
   source has a URL and a `read_on` date. The factual sentences of `report_markdown`, a short narrative, carry inline
   citations (`[S1]`). Spot-check at
   least ten claims; one factual claim with no citation fails this.
2. **The sources are primary where it matters.** The identity rests on SEC EDGAR (`data.sec.gov`, `efts.sec.gov` or
   `sec.gov`) or another registry, not only on Apple's own site or a news article; the domain age rests on RDAP or WHOIS.
3. **Sanctions:** the company and at least its chief executive are screened, each with a result for the OFAC SDN, UN,
   EU and UK lists, none a `confirmed_hit`, and each `no_hit` saying its method and citing what was searched.
4. **No merge or invention:** no fact of another "Apple" (Apple Hospitality REIT, Apple Bank, Apple Corps) appears as
   the subject's, and no officer, owner, date or address appears that a cited source does not state.
5. **Verdict:** `verdict.decision` is `proceed`. Routine litigation and competition or regulatory matters of a company
   this size may appear as low-relevance adverse media or `info`/`low` flags; none is graded `high` or `critical`.

Fail if any one does not hold.
