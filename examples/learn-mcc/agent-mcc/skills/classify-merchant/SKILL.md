---
name: classify-merchant
description: How to do the job by hand from the merchant's own site (what it sells, its MCC, its risk tier by the rubric, its flags), and which parts of it make workflows. Use it for every merchant.
---

# By hand

Sources and evidence, for every part:
- Sources: the merchant's own site first, on the registrable domain of the website given; then a marketplace listing
  that names the merchant as the seller; then any public page about it. Search with search_web, read pages with
  fetch_page or browse (browse runs a page's scripts), and read PDFs (a price list, a catalogue, terms) with
  read_document.
- Quote verbatim: copy the page's own words, at most 300 characters, cut to the line that carries the fact (a product
  line, a price, a sentence of the terms), never a paraphrase.
- The code is chosen, not remembered. A code you remember, or a code a page states for this merchant, is a guess and
  never evidence: the code follows what the merchant sells, as its own pages show it, read in this run.
- The vertical the merchant was listed under is a hint where to look, never evidence: its own pages decide.

1. The site: fetch_page the website given. When it returns little text, the page needs JavaScript: browse it. Note what
   the site is: live and this merchant's business, unreachable, parked (for sale, a placeholder, a hosting default), or
   another business than the name given. When it is not live, look for the merchant elsewhere (a marketplace listing
   that names it as the seller, its own pages on another domain it links) and answer from what you find, with a lower
   confidence.
2. What it sells: read the home page and the pages that say what customers pay for: products, collections, the menu,
   the services, pricing, plans. Say in one line the main thing customers pay for and the merchant's role in it: it
   makes it, sells it at retail, sells it by subscription, performs a service, books travel, or runs a platform where
   others sell. The main line is the one the site leads with and prices most of; a sideline does not set the code.
3. The policies: open the terms, refund or returns, shipping or delivery, and subscription or cancellation pages (often
   linked in the footer), and any licence or regulatory statement. Read them for what the rubric asks: recurring
   billing, a trial that turns into billing, delivery times, pre-orders, deposits, who the seller of record is, and a
   licence for what it sells.
4. The MCC: mcc_groups for the range that holds the main line, then mcc_codes with that group for the code. Take the
   code whose title names what the merchant sells and its role in selling it. Between two codes that both fit, take
   the one that describes what most customers pay for, and say why in the rationale. mccDescription is that code's
   title as mcc_codes gives it.
5. The risk tier: the rubric below, from what the pages read in this run show. The tier is the highest one any row
   reaches; the rationale names the rows that set it, in the merchant's terms.
6. The flags: each flag below that a page read in this run shows, and no other. A flag rests on the merchant's own
   words, never on the vertical or on what such merchants usually do.
7. Confidence: your probability that the code is the one a card network would assign. It is high when the site plainly
   says what is sold and one title fits; lower when the site is thin or not live, the business mixes lines, or two
   titles fit.
8. Evidence: at least one item for the code (a page of the merchant's own site, or a marketplace listing that names it
   as the seller, that says what it sells), one for the tier, and one for each flag, each with the page's URL as read
   in this run and its words verbatim.

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

The flags:
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

# Parts that make workflows

Each step above is a part: a call of the tool it uses, a decision over what the call returned, and an escalate when the
call found nothing. Read describe's tool list for each tool's arguments and result fields; do not invent them. The part
that reads the site fetches the website given, and escalates "needs the browser" when the page has little text, so a
part that browses can take over. The part that finds the policies takes the links of the pages it read and keeps the
terms, refund, shipping and subscription pages; it escalates "no policy pages" when it finds none, which is itself
the rubric's no_policies row. In a workflow, every quote field an extract or agent step returns declares
`maxLength: 300` in its out schema, so the cap holds at the node that makes the quote; the answer refuses a longer
quote.

The decision node follows what the decision needs. A choice that needs knowledge the state does not hold (what a
merchant's business is, for its MCC) is one narrow agent step on the host's node model: give it the merchant's name
from the job's input and the lines quoted from its pages, with mcc_groups and mcc_codes as its tools; it reads the
groups, then the codes of the group that fits, and returns one code from mcc_codes with the quote it rests on. After it,
keep Jev on what the state can show: a judge that the quote the code rests on is on the page the run read, escalating
when it is not. Do not ask a Jev judge whether a code fits a business; that needs knowledge the state does not hold.
The rubric is decidable from the pages read: one Jev judge question per row over the policy and product text, asked so
that yes means the row holds, and the tier is the highest row that holds. A dry run answers every judge question yes,
so a dry run's tier is high; check the text instead.

A dry run fills every tool result with placeholder values: text is filled in and every yes-or-no field is false. So an
escalate on a false field always fires in a dry run, and the dry run cannot pass; check the text instead.
