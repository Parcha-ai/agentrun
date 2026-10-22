# Adjudication: the MCC cell's headline number

The swarm's labels are an agent's answers, not truth. The cell reports two numbers and never pools them (SPEC.md, "What
right means, and who says so"):

1. **Teacher agreement**, on every split: `score-mcc.mjs` against the teacher block of each merchant row. It covers the
   exact MCC and the MCC group. Risk tier agreement and its ordinal distance count only once the teacher has a tier.
2. **Adjudicated accuracy**, the headline: a sealed DEV sample of 120 merchants, judged by hand.

**Risk while the teacher has none.** The swarm's risk stage has not run, so teacher rows carry no `riskTier`. Until
they do, the pilot and teacher agreement score the MCC only: exact and group. Teacher risk is null, which is never
wrong and is left out of the n. The learner's `riskTier` is judged only here, by the adjudicator against SPEC.md's risk
rubric, from the merchant's own site. When teacher tiers arrive, they are reported as agreement with the teacher only:
the teacher's later stage may follow another rubric (SPEC.md).

This file is the pre-registered protocol. Nothing in it changes after the first verdict; a change is a new version and a
new adjudication.

## 1. The sample, and what is pinned before the first verdict

- The sample is the data lane's sealed draw, not one made here. It is 120 merchants of DEV, stratified by the split's
  `stratum`: the vertical, or "seed" for the seed merchants, which have none. Each stratum gets its share of DEV by
  largest remainder.
  - The rows are sealed (mode 0600), in the truth-row shape, each with the sample's own `order`.
  - There is one salted sha256 commitment per row, by C1's method. The data lane's `--verify` recomputes every one.
  - TEST is never touched.
- The candidates' order comes from a second salt, the order salt: at least 32 random characters, made once and kept
  sealed (mode 0600). It is this protocol's own and is not the data lane's salt.
- Before the first verdict, the TL records five sha256 values in the cell's STATE:
  - this file at its commit;
  - the sample's commitments file, after `--verify` passes;
  - the order salt;
  - SPEC.md's `## The risk rubric` section (`sectionOf`);
  - `data/mcc-codes.json`.

  The commitments show later that the sample and the order were fixed in advance, without naming either before then.
- The sample is sealed apart from TEST and from the 40-merchant TRAIN replay bank. The learner never trains on DEV,
  and hindsight never runs on it.
- The arms of the first round are by hand (checkpoint 0) and LEARN at the end of 1b's stream, both on all 120. An arm is
  judged on the sample merchants it answered (`armAnswers`). A sample merchant the arm has no row for is listed as
  missing and reported; it is never judged for that arm.
- Teacher tiers that arrive later come as appended lines beside the sealed rows; the sealed rows never change. A
  teacher tier is joined into the merchant's `teacher` block before `unblind`, and never reaches a run.

The commands, with M4's scored rows of each arm (`merchantId`, `mccAnswer`, `riskAnswer`):

```
node adjudication.mjs candidates SAMPLE.json ORDER_SALT CANDIDATES.json hand=HAND.jsonl learn=LEARN.jsonl
node adjudication.mjs unblind SAMPLE.json ARM_ROWS.jsonl STAGE1.json STAGE2.json OUT_DIR    # once per arm
                                     # learner.jsonl, teacher.jsonl, unblinded.json (k and n per field)
```

## 2. Two stages per merchant, blind (`adjudicator-tools.mjs`)

One harness run per sample merchant. Its input is the merchant's name and website, and nothing else.

**Stage 1, the site alone.** The adjudicator opens the merchant's site and records, with the `site` tool:
- its own MCC, with evidence;
- the tier SPEC.md's risk rubric gives, with evidence. That is one tier, or two adjacent tiers when the evidence
  supports both readings.

Or, when the site cannot be judged, it records `unjudgeable` with the reason. No candidate code has reached the run at
this point.

**Stage 2, the candidates.** Only then does the `codes` tool answer; before stage 1 is recorded it refuses. It gives
the merchant's candidate codes: the teacher's code and every judged arm's code, each distinct code once, each under its
title from `data/mcc-codes.json`, in an order the order salt fixes. The adjudicator judges every candidate acceptable or
not, with evidence, and answers once with the verdict.

Why a candidate set and not A against B: one run judges every arm against the teacher at once. Two A/B pairs that
share the teacher's code would name it as the code common to both. As a set, no code says whose it is, and a code two
sides share appears once.

Nothing else from any answer reaches the run: no tier, rationale, evidence, confidence, flags or site status. Those
carry each source's style, and a missing teacher tier would set the teacher apart. The adjudicator never sees the swarm
export, the campaign, the learner's runs, the salt, or the cell's STATE.

**An arm judged later** (for example ARM H-MCC on full DEV) reuses each merchant's stage 1. A run for it gets only the
candidates not judged yet, and stage 1 is not asked again. Its report says that those runs knew every shown code was
new.

## 3. The rubric (pre-registered)

**MCC: the code a card network would assign from what the merchant sells** (the main thing customers pay for, plus its
role), as its own pages show (SPEC.md). The adjudicator applies Visa's rules for assigning an MCC: Merchant Data
Standards Manual, October 2026, Section 1, "Determining Merchant Category Codes", General Requirements a–e and the high
integrity risk rule after them. The rules below are the adjudicator skill's `## The MCC rules`, word for word; a test
fails if the two drift apart.

<!-- mcc rules: the adjudicate-merchant skill, word for word -->
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
<!-- mcc rules: end -->

The learner is not offered the brands' own codes (3000-3999, M1's `servedCodes`), so rule (e)'s second sentence keeps
a learner from losing a merchant that has one. `mccOwnExact` compares after mapping a brand code to its general code
(`genericOf`), as teacher agreement does.

**Risk tier: SPEC.md's `## The risk rubric`, word for word.** It is quoted below. A test fails if the quote and SPEC.md
drift apart. The section is pinned by sha256 (§1), and the adjudicator gets it verbatim via `sectionOf`. A change to the
rubric goes through M1: the skill and SPEC.md change together, and a changed section means a new adjudication.

<!-- risk rubric: SPEC.md, word for word -->
```text
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
```

## 4. The verdict

Per merchant, as `record()` of `adjudicator-tools.mjs` writes it:

```
stage1[merchantId] = { own: { mcc, evidence }, risk: { tiers: [..], evidence } }     // or { unjudgeable: reason }
stage2[merchantId] = { codes: { "<code>": { acceptable: true | false, evidence } } }  // every candidate, once
```

- Every judgment carries evidence: one to five `{ url, quote }` items. The quote is verbatim from a page opened in that
  run, on the merchant's own registrable domain (or the marketplace listing its website is). This is the same rule as
  the learner's grounding (SPEC.md), and the host checks it after the run. A run whose evidence does not ground is run
  once more; the count of runs that still do not ground is reported.
- A site that does not load, is parked, or no longer sells what its name says is judged `{ unjudgeable: reason }` and
  gets no candidates. It is counted, dropped from both sides and both fields, and reported. The rubric's "cannot be
  checked" row is the learner's rule for its own run; the adjudicator cannot judge a site it cannot read.

The tools refuse a second stage 1, codes before stage 1, and a verdict that misses, repeats or adds a candidate.
`unblind` refuses a merchant with no stage 1, or a side's code with no stage-2 judgment.

## 5. Who judges, and how (the contract for the runner)

- The home is `adjudicator/`: AGENTS.md, the `adjudicate-merchant` skill (the MCC rules and the risk rubric, word for
  word) and agent.json. The model is Opus 5.5 with thinking on. There are no learn or workflow tools: every merchant is
  judged fresh, in its own run, so no context carries from one merchant to the next.
- The tools are the cell's web tools with the cell's guards (search_web, browse through Browserbase, fetch_page,
  read_document; the refused hosts include the sites that list merchants' codes), plus `mcc_groups` and `mcc_codes`
  over the full code table, not `servedCodes`. Never a browser on the box: the merchants include adult, gambling and
  crypto sites.
- `adjudicatorRun({ candidates, groups })` gives one merchant's `site` and `codes` host tools, the answer tool, its
  `problems(verdict)` (empty when the verdict can be recorded) and `record(verdict)`. The runner:
  - builds the candidates once per round with `adjudication.mjs candidates`;
  - runs one job per sample merchant with input `{ name, website }`;
  - writes `record(verdict)` into stage1.json and stage2.json;
  - records each run like any other (recording, cost, reads).
- Spend: $3 a run at most (agent.json), and $400 for the first round, 120 merchants. A $0 scripted rehearsal on 5
  sample merchants runs before any spend. Spend is measured per run and reported with the result.
- Optional consistency check: a second run re-judges 20 random merchants of the sample, and the report gives the
  agreement. It never replaces a verdict.

## 6. The numbers (`unblind`, lanes/C1/ci.py)

`unblind` gives one row per side. The row is:

```
{ merchantId, vertical, side, mccAdjRight, mccOwnExact, riskAdjRight, riskAdjDistance, adjRight }
```

- **mccAdjRight**: that side's code was judged acceptable. A side with no code is wrong.
- **mccOwnExact**: the code equals the adjudicator's own code (stricter, reported beside mccAdjRight).
- **riskAdjRight**: the side's tier is an allowed tier. It is null for a side with no tier.
- **adjRight**: both fields right, or null when the tier is null.

The numbers drawn from these rows:
- **Headline**: the learner's adjudicated accuracy on the code (mccAdjRight) and on the tier (riskAdjRight), each
  computed with `ci.py wilson K N`, where N is the merchants judged.
- **Beside it**: the teacher's adjudicated accuracy on the code over the same merchants. This says how good the teacher
  signal is. The teacher's tier gets a number only once it exists.
- **Learner against teacher on the code**, paired on merchant: `ci.py paired teacher.jsonl learner.jsonl mccAdjRight`
  (bootstrap of the difference, McNemar exact). ci.py pairs on `merchantId` when a row has no ticker or CIK, and counts
  a merchant only one side has as unpaired.
- **Per vertical**: counts and rates. A vertical with fewer than 20 merchants judged is printed with its n and marked
  too small to trust.
- **Teacher agreement**: from `summarizeMcc`, under its own name, beside these numbers. Its headline field is the
  exact MCC, with a T&E brand code mapped to its generic code on both sides; `brandMapped`, the rows that mapping
  touched, is printed under the table. The MCC group is secondary and is always printed with the group share table.
  The two numbers are never averaged, summed or put on one axis.
- **MCC group agreement is weak by construction.** ISO 18245's 5700–7299 range holds restaurants, pharmacies, direct
  marketing, adult content, crypto, lodging and dating, so most of this cell's merchants share one group. To show it,
  `summarizeMcc` prints each group's share of the teacher's codes.

## Sources

- Visa Merchant Data Standards Manual, October 2026 (VISA PUBLIC):
  https://usa.visa.com/dam/VCOM/download/merchants/visa-merchant-data-standards-manual.pdf. Its sha256 is in
  `data/mcc-sources.json`.
- The MCC range groups: Citi Treasury and Trade Solutions, "Merchant Category Codes",
  https://citi.com/tts/solutions/commercial-cards/assets/docs/govt/Merchant-Category-Codes.pdf. ISO 18245 itself is sold
  by ISO.
- `data/mcc-groups.json` (the ranges) and `data/mcc-codes.json` (code to title) are built from both documents by
  `build-mcc-groups.mjs`. The mcc_groups and mcc_codes tools serve these files, and the scorer reads the same ones.
