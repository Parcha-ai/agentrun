# learn-mcc: the task

A merchant's card-acceptance profile from its own site: the MCC a card network would assign it from what it sells, a
risk tier by a stated rubric, the flags its pages show, and verbatim evidence for each. The learner's home is
`agent-mcc/` (AGENTS.md says what the answer is; the classify-merchant skill says how to do it by hand); the answer's
schema is `answer.mjs`. This file is the contract the scorer, the data and the harness read: field names and meanings
change here first.

## Input

`{ "name", "website" }` (`JOB_INPUT` in answer.mjs).

| Field | What it is |
|---|---|
| `name` | The merchant's name as the merchant record gives it. |
| `website` | The merchant's website as the record gives it: a URL. |

Nothing else reaches the learner: no MCC, description, risk, rationale, flags, evidence or confidence from any other
classifier, no page text another run collected, and no vertical. The record's vertical is the teacher's discovery
category and goes with the MCC, so it would carry part of the label: it is used only to stratify the split.

## Output: the `answer` tool (`answerMcc(codes)` in answer.mjs)

| Field | Type | Right means | Scored |
|---|---|---|---|
| `mcc` | a 4-digit code in mcc_codes (ISO 18245) | The code a card network would assign from what the merchant sells: the main thing customers pay for, and the merchant's role in selling it, as its own pages show. A sideline does not set it. The adjudicator applies Visa's assignment rules under this sentence (ADJUDICATION.md). | Exact, and the ISO 18245 group, against the teacher; adjudicated on the sealed sample |
| `mccDescription` | text, at most 200 | That code's title as mcc_codes gives it, exactly. | Structural (answerProblems) |
| `riskTier` | `low`, `medium` or `high` | The tier the rubric below gives from the pages read in the run: the highest row that holds. | Exact and ordinal distance, against the teacher; adjudicated |
| `riskRationale` | text, at most 600 | The rubric rows that set the tier, in the merchant's terms. | Not scored |
| `flags` | a list of the flags below, each once | Every flag a page read in the run shows, and no other. | Reported, not in the headline |
| `siteStatus` | `live`, `unreachable`, `parked` or `other_business` | What the website given showed: live and this merchant's business; no answer or an error; parked, for sale or a placeholder; or a different business than the name. | Reported |
| `evidence` | 1 to 10 items `{ claim, url, quote }` | `claim` is `mcc`, `risk` or a flag's name; `url` is the page as read in the run; `quote` is that page's words, verbatim, at most 300 characters. At least one `mcc` item and one `risk` item, and one item per flag given (answerProblems). An `mcc` item cites a page of the merchant's own registrable domain, or of the marketplace listing its website is, that says what it sells. | Grounding (below) |
| `confidence` | a number from 0 to 1 | The probability that `mcc` is the code a card network would assign. | Calibration, reported |

`answerProblems(answer, codes)` returns what the schema cannot say across fields: a title that is not its code's, a
code or tier with no evidence, a flag with no evidence, evidence for a flag not given, a flag given twice. The answer
tool refuses an answer that has any, naming them, so the agent can fix it before it records. The schema keeps to the
keywords every model route takes on the wire; `contains` and `uniqueItems` are left to answerProblems for that reason.

### Grounding (what the harness's receipt reads)

An answer is grounded when an `mcc` evidence item's quote is verbatim on a page the run read with an ok status, and that
page is that item's `url` and is on the registrable domain of the website given, or, when the website given is a
marketplace listing, under that listing. The match: the quote's own surrounding quote marks and closing punctuation are
trimmed; URLs are removed and whitespace is folded on both sides; then the quote must appear in the page's text, case
for case. A quote of fewer than three words, or with an ellipsis, is not verbatim. A page on another domain the merchant
links, or another marketplace's listing, can inform the answer but grounds nothing.

## What right means, and who says so

The teacher (the classifier whose labels came with the merchant records) is an agent, not truth. Two numbers, never
pooled:
1. Teacher agreement, on every split: exact MCC, MCC group (ISO 18245 ranges), risk tier exact and by ordinal distance.
   The teacher's risk comes from its own later stage, on a smaller model, and may follow a different rubric than this
   one: risk agreement is reported as agreement with the teacher, never as accuracy against this rubric.
2. Adjudicated accuracy, the headline: a sealed sample judged by hand, blind between the learner's answer and the
   teacher's, by the rules above: the MCC a card network would assign from what the merchant actually sells, and the
   tier this rubric gives.

The scorer, the group table and the adjudication protocol are their own lane's; the rubric they apply is this one,
word for word.

## The risk rubric

The risk rubric. The tier is the highest one any row reaches:
- high, when the merchant's pages show any of these:
  - adult content or services, or dating or escort services;
  - gambling, betting, lotteries, sweepstakes or other games of chance played for money;
  - crypto-assets bought, sold, exchanged or held for customers; money transfer, stored value, prepaid cards, or
    payment services for others;
  - lending, credit repair, debt relief or collection, or investment or trading signals sold to consumers;
  - prescription drugs, CBD, cannabis or hemp THC, kratom, or other drugs sold without a prescription;
  - tobacco, e-cigarettes or vapes; firearms, ammunition or weapon parts;
  - a free or discounted trial that turns into recurring billing;
  - travel booked to be taken later: flights, tours, cruises, timeshares, or travel agency bookings;
- medium, when no high row holds and the pages show any of these:
  - recurring billing or a subscription, disclosed, with no trial that turns into billing;
  - supplements, weight-loss, anti-aging or other nutraceuticals sold outright;
  - alcohol;
  - goods that typically cost over 1,000 US dollars an order; goods made to order, pre-ordered, or delivered more than
    30 days after payment; event tickets or deposits;
  - digital goods, software licences, online courses or gift cards;
  - a marketplace or platform where others sell to the buyer;
  - a site that cannot be checked: unreachable, parked, or showing a different business;
  - no terms or refund policy found on the site;
- low, when no other row holds: goods or services delivered at or near payment, with terms and a refund policy on the
  site.

## The flags

- adult: adult content or services, or dating or escort services.
- gambling: gambling, betting, lotteries, sweepstakes or games of chance played for money.
- crypto: crypto-assets bought, sold, exchanged or held for customers.
- money_services: money transfer, stored value, prepaid cards, or payment services for others.
- financial_services: lending, credit repair, debt relief or collection, or investment or trading signals.
- regulated_goods: prescription drugs, CBD, cannabis or hemp THC, kratom, tobacco, e-cigarettes or vapes, firearms,
  ammunition or weapon parts, or alcohol.
- nutraceuticals: supplements, weight-loss, anti-aging or similar products.
- subscription: recurring billing or a subscription.
- free_trial: a free or discounted trial that turns into recurring billing.
- travel: travel booked to be taken later.
- future_delivery: goods made to order, pre-ordered or delivered more than 30 days after payment, event tickets, or
  deposits.
- high_ticket: goods that typically cost over 1,000 US dollars an order.
- digital_goods: digital goods, software licences, online courses or gift cards.
- marketplace: a marketplace or platform where others sell to the buyer.
- site_unverified: the website given is unreachable, parked, or shows a different business.
- no_policies: no terms or refund policy found on the site.

## Tools

| Tool | Takes | Returns |
|---|---|---|
| `search_web`, `browse`, `fetch_page`, `read_document` | as in learn-classify v4, with the same guards | as there |
| `mcc_groups` | `{}` | `{ groups: [{ code, name }] }`: `servedGroups` of the ISO 18245 ranges, `code` as `"NNNN-NNNN"`, in code order |
| `mcc_codes` | `{ group? }`, a range from mcc_groups | `{ codes: [{ code, name }] }`: `servedCodes`, all or that range's (membership by the scorer's `groupOf`), each under its title |
| `answer` | the answer above | `Recorded <mcc>.`, or the problems answerProblems found |
| `learn`, `agentrun` | as in learn-classify v4 | as there |

The MCC table (`data/mcc-codes.json`, code to title) and the group table (`data/mcc-groups.json`, ranges) are the
scorer's lane's, with their sources cited. `answerMcc(codes)` takes the code table and offers `servedCodes` of it: every
code but the airline, car rental and lodging codes of named brands (3000-3999), whose merchants take their kind's
generic code (4511, 7512, 7011), the same group to the scorer. `mccDescription` is held to the table's titles.

## Leaks

The home (`agent-mcc/`) names no merchant from the campaign, quotes no page a classifier collected, and carries no label.
Its examples are invented. A page that states a merchant's MCC is never evidence: the code follows what the merchant
sells, and the tools refuse the sites that list merchants' codes (the harness keeps that list).
