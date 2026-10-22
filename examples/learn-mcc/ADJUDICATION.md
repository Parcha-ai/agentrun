# Adjudication: the MCC cell's headline number

The swarm's labels are an agent's answers, not truth. The cell reports two numbers and never pools them:

1. **Teacher agreement**, on every split: `score-mcc.mjs` against the swarm agent's answer (exact MCC, MCC group, risk
   tier, risk distance).
2. **Adjudicated accuracy**, the headline: a sealed DEV sample of 120 merchants, judged by hand, blind A/B between the
   learner's answer and the teacher's.

This file is the pre-registered protocol. Nothing in it changes after the first verdict; a change is a new version and a
new adjudication.

## 1. The sample (`adjudication.mjs`, `drawSample`)

- n = 120 from DEV. Each vertical gets its share of DEV (largest remainder). A vertical DEV has, but the shares leave
  empty, takes one merchant from the largest. TEST is never touched.
- A salt of at least 32 random characters, made once and kept sealed (mode 0600, beside the cell's other seals). Inside a
  vertical, merchants are picked in sha256(salt, "sample", merchantId) order, so DEV's row order does not move the sample.
- Before the first verdict, the TL records three sha256 values in the cell's STATE: this file at its commit, the sorted
  commitment list (`commitmentOf`: sha256(salt, "adjudication", merchantId) per merchant), and the risk policy text (§3).
  The commitments show later that the sample was fixed in advance, without naming it before then.
- The sample is sealed apart from TEST and from the 40-merchant TRAIN replay bank. The learner never trains on it (it is
  DEV), and hindsight never runs on DEV.

## 2. Blind A/B (`packetOf`, `learnerSide`)

- One packet per merchant: name, website, and two answers, A and B. sha256(salt, "order", merchantId) sets which side the
  learner is on, so about half the packets put the learner first and only the salt recovers which.
- A packet shows each side's MCC, Visa's title for that code, and the risk tier. It never shows a rationale, evidence,
  confidence or flags. Those carry each source's style (the swarm's evidence format is recognisable), so they would
  unblind it.
- The adjudicator never sees the swarm export, the campaign, the learner's runs, the salt, or this cell's STATE.
- Each arm (by-hand checkpoint 0, LEARN after the stream) is judged in its own pass against the teacher. A merchant's
  learner side is the same in every pass. A packet identical to one already judged (same values on the same sides)
  reuses that verdict.

## 3. The rubric (pre-registered)

**MCC: the code a card network would assign from what the merchant actually sells.** The adjudicator applies Visa's
rules for assigning an MCC (Merchant Data Standards Manual, October 2026, Section 1, "Determining Merchant Category
Codes", General Requirements a–e, and the high integrity risk rules after them):

- (a) The primary business: the line with the highest sales. From outside, that is what the site's catalog and checkout
  sell most prominently, not what its About page aspires to.
- (b) A "miscellaneous" code (usually ending 99) only when no specific code applies. 5999 is wrong where 5499, 5977 or
  5995 fits.
- (c) Each e-commerce site is its own merchant location: judge the site given, not its parent company's other sites.
- (e) An airline, car rental or lodging merchant with its own code uses it. Without one, it uses the generic code (4511,
  7512, 7011).
- High integrity risk lines take their own code even when they are not the primary business: online gambling 7995
  ("must use MCC 7995 for all transactions, even if gambling is not the Merchant's primary business"). A site with
  several lines, one of them high integrity risk, needs that line's code for that line. The answer is acceptable when it
  gives the code the site's high integrity risk line requires.
- Direct marketing codes: Visa defines 5968 for subscription products sold by direct marketing (it names
  nutraceuticals), and says a merchant "not participating in direct marketing activities that happen to offer recurring
  purchase transactions should use the MCC that best describes their business instead". 5969 is acceptable only when no
  more specific code fits.
- 5262 (Marketplaces) is acceptable only for a multi-seller site that sells under one brand. Visa registration cannot be
  checked from outside, so the site's own structure decides.

A side is **acceptable** when a network following these rules could assign its code to this site; two different codes
can both be acceptable (for example, 5499 and 5912 for a vitamin shop that is also a licensed pharmacy). A code Visa
does not list (`mccTitle` "not in the code table") is acceptable only when Mastercard lists it and it fits.

**Risk tier: the stated policy.** This is the risk policy in M1's task spec, its text pinned by sha256 in §1 before the
first verdict. If the spec states none, this default is used, and the report says it was:

- **high**: the site sells a line on Visa's card-absent high integrity risk list (same section): 5122/5912 drugs and
  pharmacies, 5966 outbound telemarketing, 5967 adult content, 5993 tobacco, 7273 dating, 7995 betting, 5968
  negative-option subscriptions, 6051/6012 crypto exchanges, wallets and on-ramps, 6211 trading platforms, 5816
  skill-game wagering, 4816 cyber lockers.
- **medium**: no such line, but one of the cell's other flags holds: regulated goods (age-restricted or licensed),
  recurring billing, nutraceuticals, travel (future delivery), high-ticket goods.
- **low**: neither.

The tier is ordinal. A side is acceptable when its tier is the one the policy gives. A site on the boundary between two
tiers takes both acceptable only when the evidence supports both readings, and the verdict says why.

## 4. The verdict, per field

For each merchant and each field (mcc, risk): **A** (only A acceptable), **B** (only B acceptable), **both**
(both acceptable), or **neither**. Where both sides gave the same value, only both or neither can hold (`unblind`
refuses anything else).

Every verdict carries evidence: at least one `{ url, quote }`, the quote verbatim from a page of the merchant's own
registrable domain, or of a named marketplace listing of it, that the adjudicator opened. "neither" also gives the
adjudicator's own code or tier (`own`), so the misses can be read later. A site that does not load, or no longer sells
anything, gets `unjudgeable` instead of a verdict. It is counted, dropped from both sides, and reported.

The verdict file: `{ [merchantId]: { mcc: { verdict, evidence, own? }, risk: { ... } } }`.

## 5. Who judges, and how

- Opus 5.5, thinking on, by hand. That is a person-style session, not a scripted judge: one merchant at a time, the site
  open, its catalog, product pages, terms, refund, shipping and subscription pages read as needed.
- Fresh sessions of at most 20 packets, so no long context drifts. Each session gets this file's §3 and §4 and its
  packets, nothing else.
- Sites are opened only through the cell's web tools (fetch_page, browse through Browserbase, search_web for marketplace
  listings), never a browser on this box: the merchants include adult, gambling and crypto sites.
- Spend is measured per session and reported with the result; the pass needs the TL's envelope before it starts.
- Optional consistency check: a second fresh session re-judges 20 random packets of the sample, and the report gives
  the agreement. It never replaces a verdict.

## 6. The numbers (`unblind`, lanes/C1/ci.py)

`unblind` turns the verdicts into one row per side, `{ merchantId, vertical, side, mccAdjRight, riskAdjRight, adjRight }`.
A side is right on a field when the verdict names it or says both.

- Headline: the learner's adjudicated accuracy per field and over both fields: `ci.py wilson K N`, with N the judged
  merchants.
- Beside it: the teacher's adjudicated accuracy on the same merchants. That number says how good the teacher signal is.
- Learner against teacher, paired on merchant: `ci.py paired teacher.jsonl learner.jsonl mccAdjRight` (bootstrap of the
  difference, McNemar exact). ci.py pairs on ticker or CIK, so it needs `merchantId` added to its key (one line, asked
  of the TL).
- Per vertical: counts and rates. A vertical with fewer than 20 judged merchants is printed with its n and marked too
  small to trust.
- Teacher agreement from `summarizeMcc` sits beside these numbers, under its own name. The two are never averaged,
  summed or put on one axis.
- MCC group agreement is weak by construction. ISO 18245's 5700–7299 range holds restaurants, pharmacies, direct
  marketing, adult content, crypto, lodging and dating, so most of this cell's merchants share one group.
  `summarizeMcc` prints each group's share of teacher codes so a reader can see it.

## Sources

- Visa Merchant Data Standards Manual, October 2026 (VISA PUBLIC):
  https://usa.visa.com/dam/VCOM/download/merchants/visa-merchant-data-standards-manual.pdf, sha256 in
  `data/mcc-sources.json`.
- The MCC range groups: Citi Treasury and Trade Solutions, "Merchant Category Codes":
  https://citi.com/tts/solutions/commercial-cards/assets/docs/govt/Merchant-Category-Codes.pdf. ISO 18245 itself is
  sold by ISO.
