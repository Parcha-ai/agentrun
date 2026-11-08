# Adverse media

Adverse media is what a regulator, a court or a credible publisher has said about the company, or about the people
who own and run it, that bears on whether to deal with it. Budget: 4 to 8 searches and fetches in all.

## Searches

Keep queries short; run them on the legal name, then on a former or distinctive trading name if there is one.

1. `"<legal name>" fraud OR lawsuit OR fined OR penalty OR investigation`
2. `"<legal name>" sanctions OR "money laundering" OR bribery OR charged`
3. `"<legal name>" <regulator or country> enforcement OR settlement OR "final notice"`
4. Once, for the chief executive and each beneficial owner: `"<person>" "<company name>" fraud OR charged OR fined OR
   disqualified`.

Then the primary sources for the company's country (`SOURCES.md` has the URLs), through `web_search` limited to the
site where the site has no search a plain fetch reads:

- **UK:** FCA final notices and warnings (`fca.org.uk`), the FCA register entry, The Gazette (winding-up petitions,
  liquidation), Find Case Law, the Serious Fraud Office (`sfo.gov.uk`), the CMA, the ICO, the HSE (health and safety
  prosecutions), the Environment Agency, the Insolvency Service (director disqualifications).
- **US:** SEC litigation releases and administrative proceedings, DOJ press releases, the FTC, the CFPB, FINRA, OFAC
  enforcement actions, FinCEN, OSHA and the Department of Labor (labour), the EPA's ECHO (environmental), state
  attorneys general. For a listed company, the 10-K's "Legal Proceedings" item is the company's own account of its
  material cases.

A search result is a lead. Read the page you cite (with `max_chars` about 5000), and prefer the regulator's or court's
own page to an article about it.

## Is it about the subject?

An item counts only when a source ties it to the resolved entity by at least one of: its registration number; its
domain; the same legal name and the same jurisdiction; a named officer or owner acting for this company; the
regulator's own reference for this firm (an FCA firm reference number, an SEC file number, a CIK).

- The same name alone is not enough. An item about another company of the same name is `not_relevant`; set `about` to
  that company ("Acme Ltd, company 01234567, Leeds: a different company") and list it only when a reader could mistake
  it for the subject.
- An item about a related party (an officer, an owner, the parent, a subsidiary) names that party in `about`. It bears
  on the subject when it concerns their conduct at this company, or financial crime, fraud or sanctions anywhere.
- Owner corrections in your learned notes ("this item is about a different Acme") are applied first.

## Dates

- `published`: the date the source itself shows (a regulator's notice date, an article's dateline), never today and
  never a search engine's crawl date. `YYYY-MM-DD`; `YYYY-MM` or `YYYY` only when the source gives no more.
- `event_date`: when the decision, filing or conduct happened, when it differs (an FCA final notice dated 27 September
  and announced on 2 October; a lawsuit filed in 2023 and reported in 2025).
- An item you cannot date from any source is left out, and `limitations` says so.

## Category

One per item; when two fit, take the first that applies in this order.

| Category | For |
|---|---|
| `financial_crime` | money laundering, terrorist financing, sanctions breaches or evasion, bribery and corruption, tax evasion, and a regulator's finding of failed anti-money-laundering or sanctions controls |
| `fraud` | deception for gain: false accounting, investor or consumer fraud, misrepresentation, embezzlement, fraud charges |
| `regulatory` | any other regulator action: fines, consent orders, licence restrictions or withdrawals, warnings (competition, data protection, consumer protection, prudential, licensing) |
| `litigation` | civil suits, arbitration, judgments, creditors' winding-up petitions |
| `labour` | wage and hour, health and safety, forced or child labour, discrimination findings |
| `environmental` | pollution, permit breaches, environmental enforcement |
| `other` | anything else material: product safety, a data breach, a governance scandal |

## Status

`allegation` (reported, nothing filed), `proceedings_open` (charged, sued, under investigation), `settled` (without a
finding), `finding_or_penalty` (a regulator's finding, fine or order; a civil judgment against), `conviction`,
`dismissed_or_acquitted`, `unknown`.

## Relevance

Grade each item and give the reason in `relevance_why`. Weigh it against the company's size: a fine that is routine for
a global listed group can be existential for a ten-person firm.

| Relevance | When |
|---|---|
| `high` | about the subject, and either fraud or financial crime with a finding, penalty, conviction or open proceedings in the last 5 years, or a finding in any category material to this company's size or to this relationship |
| `medium` | about the subject but allegation-only; or fraud or financial crime resolved more than 5 years ago; or a moderate finding in another category; or a key related party's fraud or financial crime |
| `low` | about the subject but routine for its size (ordinary commercial litigation, a competition or privacy case at a large listed company disclosed in its filings, a small fine); or about a related party and peripheral |
| `not_relevant` | not about the subject |

Opinion pieces, product reviews, employer reviews and social media posts are not adverse media unless a regulator or a
court takes them up.
