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

## 1. The sample (`adjudication.mjs`, `drawSample`)

- n = 120 from DEV. Each vertical gets its share of DEV (largest remainder). A vertical DEV has, but the shares leave
  empty, takes one merchant from the largest. TEST is never touched.
- A salt of at least 32 random characters, made once and kept sealed (mode 0600, beside the cell's other seals).
  Inside a vertical, merchants are picked in sha256(salt, "sample", merchantId) order, so DEV's row order does not move
  the sample.
- Before the first verdict, the TL records four sha256 values in the cell's STATE:
  - this file at its commit;
  - the sorted commitment list (`commitmentOf`: sha256(salt, "adjudication", merchantId) per merchant);
  - SPEC.md's `## The risk rubric` section (`sectionOf`);
  - `data/mcc-codes.json`.

  The commitments show later that the sample was fixed in advance, without naming it before then.
- The sample is sealed apart from TEST and from the 40-merchant TRAIN replay bank. The learner never trains on DEV,
  and hindsight never runs on it.

## 2. Two stages per merchant, blind (`packetOf`, `learnerSide`)

**Stage 1, the site alone.** The adjudicator gets the merchant's name and website (`packet.site`) and nothing else.
It opens the site and records two things:
- its own MCC, with evidence;
- the tier or tiers SPEC.md's risk rubric gives, with evidence. That is one tier, or two adjacent tiers when the
  evidence supports both readings, with the reason given.

It sees no answer while it does this.

**Stage 2, the codes.** Only then does it get `packet.codes`: two MCCs, A and B, each under its title from
`data/mcc-codes.json`. sha256(salt, "order", merchantId) sets which side is the learner's, so about half put the learner
first and only the salt recovers which.

Nothing else from either answer is ever shown: no tier, rationale, evidence, confidence, flags or site status. Those
carry each source's style, and a missing teacher tier would name its side. The adjudicator never sees the swarm export,
the campaign, the learner's runs, the salt, or the cell's STATE.

Each arm (by-hand checkpoint 0, LEARN after the stream) is judged in its own pass. A merchant's stage 1 is done once
and reused by every pass. A packet whose codes are identical to one already judged (same codes on the same sides) reuses
that verdict.

## 3. The rubric (pre-registered)

**MCC: the code a card network would assign from what the merchant sells** (the main thing customers pay for, plus its
role), as its own pages show (SPEC.md). The adjudicator applies Visa's rules for assigning an MCC: Merchant Data
Standards Manual, October 2026, Section 1, "Determining Merchant Category Codes", General Requirements a–e and the high
integrity risk rule after them.

- (a) The primary business is the line with the highest sales. From outside, that is what the site's catalog and
  checkout sell most prominently.
- (b) A "miscellaneous" code (usually ending 99) is used only when no specific code applies. 5999 is wrong where 5499,
  5977 or 5995 fits.
- (c) Each e-commerce site is its own merchant location: judge the site given, not its parent company's other sites.
- (e) An airline, car rental or lodging merchant with its own code uses it; one without uses the generic code (4511,
  7512, 7011).
- High integrity risk lines take their own code even when they are not the primary business. Online gambling "must use
  MCC 7995 for all transactions, even if gambling is not the Merchant's primary business". A site with several lines,
  one of them high integrity risk, takes that line's code for that line, and a code that gives it is acceptable.
- Direct marketing codes:
  - Visa defines 5968 for subscription products sold by direct marketing (it names nutraceuticals). It also says a
    merchant "not participating in direct marketing activities that happen to offer recurring purchase transactions
    should use the MCC that best describes their business instead".
  - 5969 is acceptable only when no more specific code fits.
- 5262 (Marketplaces) is acceptable only for a multi-seller site that sells under one brand. Visa registration cannot
  be checked from outside, so the site's structure decides.
- A page that states the merchant's MCC is never evidence (SPEC.md, "Leaks").

A code is **acceptable** when a network following these rules could assign it to this site. Two different codes can
both be acceptable, for example 5499 and 5912 for a vitamin shop that is also a licensed pharmacy. A code not in
`data/mcc-codes.json` ("not in the code table") is never acceptable.

**Risk tier: SPEC.md's `## The risk rubric`, word for word.** The section is pinned by sha256 (§1), and the adjudicator
gets it verbatim via `sectionOf`. The tier is the highest one any row reaches. A change to the rubric goes through M1:
the skill and SPEC.md change together, and a changed section means a new adjudication.

## 4. The verdict

Per merchant:

```
{ own:  { mcc, evidence },                // stage 1
  risk: { tiers: [..], evidence },        // stage 1: one tier, or two adjacent
  mcc:  { verdict: A | B | both | neither, evidence } }   // stage 2
```

- Where both codes are the same, only both or neither can hold.
- Every part carries evidence: at least one `{ url, quote }`. The quote is verbatim from a page the adjudicator opened,
  either on the merchant's own registrable domain or on a named marketplace listing of it.
- A site that does not load, is parked, or no longer sells what its name says is judged `{ unjudgeable: reason }`. It
  is counted, dropped from both sides, and reported.

`unblind` enforces all of this and refuses anything else.

## 5. Who judges, and how

- Opus 5.5, thinking on, by hand: a person-style session, not a scripted judge. It works one merchant at a time with
  the site open, reading the catalog, product pages, terms, refund, shipping and subscription pages as needed.
- Fresh sessions of at most 20 merchants, so long contexts do not drift. Each session gets §3, §4, the pinned rubric
  section and its packets, stage by stage, and nothing else.
- Sites are opened only through the cell's web tools (fetch_page, browse through Browserbase, search_web for
  marketplace listings), never through a browser on the box. The merchants include adult, gambling and crypto sites.
- Spend is measured per session and reported with the result. The pass needs the TL's envelope before it starts.
- Optional consistency check: a second fresh session re-judges 20 random merchants of the sample, and the report gives
  the agreement. It never replaces a verdict.

## 6. The numbers (`unblind`, lanes/C1/ci.py)

`unblind` gives one row per side. The row is:

```
{ merchantId, vertical, side, mccAdjRight, mccOwnExact, riskAdjRight, riskAdjDistance, adjRight }
```

- **mccAdjRight**: the verdict names that side or says both.
- **mccOwnExact**: the code equals the adjudicator's own code (stricter, reported beside mccAdjRight).
- **riskAdjRight**: the side's tier is an allowed tier. It is null for a side with no tier.
- **adjRight**: both fields right, or null when the tier is null.

The numbers drawn from these rows:
- **Headline**: the learner's adjudicated accuracy on the code (mccAdjRight) and on the tier (riskAdjRight), each
  computed with `ci.py wilson K N`, where N is the merchants judged.
- **Beside it**: the teacher's adjudicated accuracy on the code over the same merchants. This says how good the teacher
  signal is. The teacher's tier gets a number only once it exists.
- **Learner against teacher on the code**, paired on merchant: `ci.py paired teacher.jsonl learner.jsonl mccAdjRight`
  (bootstrap of the difference, McNemar exact). ci.py pairs on ticker or CIK, so it needs `merchantId` added to its key.
- **Per vertical**: counts and rates. A vertical with fewer than 20 merchants judged is printed with its n and marked
  too small to trust.
- **Teacher agreement**: from `summarizeMcc`, under its own name, beside these numbers. The two are never averaged,
  summed or put on one axis.
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
