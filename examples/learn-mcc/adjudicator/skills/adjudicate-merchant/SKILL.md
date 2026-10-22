---
name: adjudicate-merchant
description: How to judge one merchant blind, from its own site - stage 1 your own MCC and the risk tier, stage 2 each candidate code acceptable or not - with the MCC rules and the risk rubric. Use it for every merchant.
---

# Stage 1: from the site alone

Sources and evidence, for every judgment:
- Sources: the merchant's own site, on the registrable domain of the website given (or, when the website given is a
  marketplace listing, that listing). Read pages with fetch_page, or browse when a page needs JavaScript; read PDFs (a
  price list, a catalogue, terms) with read_document; search with search_web only to find the merchant's own pages.
- Quote verbatim: one unbroken run of the page's own words, at least three words and at most 300 characters, the line
  that carries the fact (a product line, a price, a sentence of the terms). Never a paraphrase, never an ellipsis. An
  evidence item's URL is the page its quote is copied from, as you read it in this run.

1. The site: fetch_page the website given; browse it when it returns little text. When it does not load, is parked (for
   sale, a placeholder, a hosting default) or sells nothing now, record `unjudgeable` with `site` and answer with no
   codes.
2. What it sells: the home page and the pages that say what customers pay for (products, collections, the menu, the
   services, pricing, plans). Say to yourself in one line the main thing customers pay for and the merchant's role in
   it: it makes it, sells it at retail, sells it by subscription, performs a service, books travel, or runs a platform
   where others sell.
3. The policies: the terms, refund or returns, shipping or delivery, and subscription or cancellation pages, and any
   licence statement, read for what the rubric asks.
4. Your own MCC: mcc_groups for the range that holds the main line, then mcc_codes with that group, by the MCC rules
   below.
5. The risk tier: the rubric below, from what the pages read in this run show. Two adjacent tiers only when the evidence
   supports both readings.
6. Record both with `site`, each with its evidence, before anything else.

# Stage 2: the candidates

7. Call `codes`. Judge each candidate on its own: acceptable when a network following the MCC rules could assign it to
   this site, from what the site sells; not acceptable otherwise. Its evidence is the page that shows what the merchant
   sells that the code's title fits, or does not.
8. Answer once, with every candidate judged, each once.

# The MCC rules

- (a) The primary business is the line with the highest sales. From outside, that is what the site's catalog and
  checkout sell most prominently.
- (b) A "miscellaneous" code (usually ending 99, or saying "not elsewhere classified") is acceptable only when no
  specific code fits what the merchant sells. 5999 is not acceptable where 5499, 5977 or 5995 fits.
- (c) Each e-commerce site is its own merchant location: judge the site given, not its parent company's other sites.
- (e) An airline, car rental or lodging merchant with its own code uses it; one without uses the general code (4511,
  7512, 7011). The general code of the merchant's kind is acceptable wherever its brand's own code would be.
- High integrity risk lines take their own code even when they are not the primary business. Online gambling "must use
  MCC 7995 for all transactions, even if gambling is not the Merchant's primary business". For a site with several
  lines, one of them high integrity risk, the code that line requires is acceptable.
- Direct marketing codes: 5968 is for subscription products sold by direct marketing (Visa names nutraceuticals). A
  merchant "not participating in direct marketing activities that happen to offer recurring purchase transactions
  should use the MCC that best describes their business instead". 5969 is acceptable only when no more specific code
  fits.
- 5262 (Marketplaces) is acceptable only for a multi-seller site that sells under one brand.
- A page that states the merchant's MCC is never evidence: the code follows what the merchant sells.
- A code is acceptable when a network following these rules could assign it to this site. Two different codes can both
  be acceptable, for example 5499 and 5912 for a vitamin shop that is also a licensed pharmacy. A code shown as "not in
  the code table" is never acceptable.

# The risk rubric

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
