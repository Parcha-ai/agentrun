// What the faux providers answer, beyond what documents/labels.json says about each document. Every value here is a
// FIXTURE for rehearsing the demo with no key: invented merchants, invented registry records, and probabilities picked to
// look like what the live models return. Live runs never read this file.
import { readFileSync } from "node:fs";

export const labels = JSON.parse(readFileSync(new URL("../documents/labels.json", import.meta.url), "utf8"));

/** Per-document answers that differ from the rule in jev.mjs: the borderline cases, so the demo shows the second look
 *  and the unsure gate. `branch` is the second look's choice and its confidence. */
export const overrides = {
  // Clean, but the Wyoming form borrows Nevada's layout: the seal reads as unclear, and the second look is not sure enough.
  "coi-marrowfield-bakeworks.pdf": { seal_present: 0.64, issuer_marks: 0.66, branch: { choice: "valid", confidence: 0.68 } },
  // Clean; the small header seal is hard to read, so the name check is unclear, and the second look clears it.
  "coi-wrenfield-acoustics.pdf": { name_consistent: 0.74, branch: { choice: "valid", confidence: 0.91 } },
  // Altered, but only the edge of the white-out shows: the first pass is unsure, and the second look catches it.
  "bank-quorvane-medical-devices.pdf": { looks_altered: 0.62, bank_altered: 0.62, branch: { choice: "doubtful", confidence: 0.86 } },
};

/** Invented registry records for Parallel's registry question. Citations are fixtures and say so. */
export const registry = {
  "Brisklow Marine Coatings, Inc.": { status: "active", state: "Delaware", fileNumber: "6638214", formed: "2023-04-11", agent: "Tatnall Registered Agents LLC" },
};

const fixtureNote = "[FIXTURE: invented record for the demo rehearsal, not a real registry page]";

export function registryCitations(company, jurisdiction) {
  const record = registry[company];
  const q = encodeURIComponent(company.replace(/[,.]/g, "").toLowerCase());
  if (!record) {
    return [{ url: `https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx?fixture=1&name=${q}`, title: `${fixtureNote} Division of Corporations entity search: no results`, excerpts: [`${fixtureNote} No entity matched "${company}" in ${jurisdiction}.`] }];
  }
  return [
    { url: `https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx?fixture=1&file=${record.fileNumber}`, title: `${fixtureNote} ${company.toUpperCase()} - Delaware Division of Corporations`, excerpts: [`${fixtureNote} File Number: ${record.fileNumber}. Incorporation Date / Formation Date: ${record.formed.slice(5, 7)}/${record.formed.slice(8)}/${record.formed.slice(0, 4)}. Entity Kind: Corporation. Entity Type: General. Residency: Domestic. State: DELAWARE. Status: Good Standing.`] },
    { url: `https://opencorporates.example/companies/us_de/${record.fileNumber}?fixture=1`, title: `${fixtureNote} ${company} :: Delaware (US) :: company record`, excerpts: [`${fixtureNote} Company Number ${record.fileNumber}, Status Active, Incorporation Date ${record.formed}, Registered Agent ${record.agent}.`] },
  ];
}

/** The invented merchants fetch_page serves under --faux, with what each provider should find. */
export const merchants = {
  "kettlewick-roasters.example": {
    name: "Kettlewick Roasters", ip: "93.184.216.61", mcc: "5499",
    page: { prohibited: 0.03, restricted: 0.04 }, web: { prohibited: 0.04, risk: "low", riskConfidence: 0.86 },
    title: "Kettlewick Roasters | Small-batch coffee, roasted in Asheville",
    body: `<header><h1>Kettlewick Roasters</h1><nav><a href="/shop">Shop coffee</a> <a href="/subscriptions">Subscriptions</a> <a href="/wholesale">Wholesale</a> <a href="/about">Our story</a></nav></header>
<main><h2>Small-batch coffee, roasted every Tuesday</h2>
<p>We buy green coffee from twelve farms in Huila, Sidama and Cajamarca and roast it in a 15 kg drum in Asheville, North Carolina. Every bag ships within 48 hours of roasting.</p>
<h3>This week's coffees</h3><ul><li>Sidama Bensa, washed. Notes of bergamot and apricot. 12 oz $19.50</li><li>Huila Pink Bourbon. Red grape, cacao nib. 12 oz $22.00</li><li>Kettlewick House Espresso. Molasses, toasted almond. 2 lb $38.00</li><li>Decaf Cajamarca (Swiss water). 12 oz $18.00</li></ul>
<h3>Brewing gear</h3><ul><li>Ceramic pour-over dripper $28</li><li>Burr grinder, 40 settings $129</li><li>Paper filters, 100 count $7</li></ul>
<p>Subscriptions every 2, 3 or 4 weeks. Free shipping over $40. Wholesale for cafes and offices: wholesale@kettlewick-roasters.example</p></main>
<footer>Kettlewick Roasters LLC, 88 Depot Street, Asheville NC. Returns within 30 days on unopened gear.</footer>`,
    citations: [
      { url: "https://reviews.example/biz/kettlewick-roasters-asheville?fixture=1", title: "[FIXTURE] Kettlewick Roasters - 4.8 stars, 212 reviews", excerpts: ["[FIXTURE] Fresh roast dates on every bag; subscription shipped on time for two years."] },
      { url: "https://news.example/asheville/2025/roasters-expand?fixture=1", title: "[FIXTURE] Asheville roaster opens second cafe", excerpts: ["[FIXTURE] Kettlewick Roasters, which sells beans online and to 40 local cafes, opened a second location."] },
    ],
  },
  "fernhollow-botanicals.example": {
    name: "Fernhollow Botanicals", ip: "93.184.216.62", mcc: "5999",
    page: { prohibited: 0.18, restricted: 0.93 }, web: { prohibited: 0.21, risk: "elevated", riskConfidence: 0.74 },
    title: "Fernhollow Botanicals | Full-spectrum hemp wellness",
    body: `<header><h1>Fernhollow Botanicals</h1><nav><a href="/tinctures">Tinctures</a> <a href="/gummies">Gummies</a> <a href="/lab-results">Lab results</a> <a href="/wholesale">Wholesale</a></nav></header>
<main><h2>Full-spectrum hemp, grown in Oregon</h2>
<p>Our CBD tinctures and gummies are made from hemp grown on our family farm in the Willamette Valley. Every batch is third-party lab tested, under 0.3% THC.</p>
<ul><li>Full-spectrum CBD tincture 1500 mg, 30 ml $64</li><li>Sleep gummies, CBD + CBN + melatonin, 30 count $42</li><li>Delta-8 THC gummies, 25 mg each, 20 count $35 (21+ only, not shipped to restricted states)</li><li>CBD muscle balm 1000 mg $48</li></ul>
<p>Customers tell us our sleep gummies help them unwind and support restful sleep.* Subscribe and save 20%.</p>
<p class="fine">*These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure or prevent any disease. Age verification required at checkout.</p></main>
<footer>Fernhollow Botanicals Inc., Salem, Oregon.</footer>`,
    citations: [
      { url: "https://reviews.example/biz/fernhollow-botanicals?fixture=1", title: "[FIXTURE] Fernhollow Botanicals - 4.1 stars, 389 reviews", excerpts: ["[FIXTURE] Several reviews mention subscription charges that were hard to cancel."] },
      { url: "https://hempindustry.example/directory/fernhollow?fixture=1", title: "[FIXTURE] Fernhollow Botanicals - licensed hemp grower, Oregon", excerpts: ["[FIXTURE] Holds an Oregon Department of Agriculture hemp grower registration; sells CBD and delta-8 products online."] },
    ],
  },
  "luxeparade-outlet.example": {
    name: "Luxeparade Outlet", ip: "93.184.216.63", mcc: "5948",
    page: { prohibited: 0.94, restricted: 0.12 }, web: { prohibited: 0.89, risk: "high", riskConfidence: 0.88 },
    title: "LUXEPARADE OUTLET - Designer Bags 1:1 Mirror Quality Up To 85% Off",
    body: `<header><h1>LUXEPARADE OUTLET</h1><nav><a href="/bags">Bags</a> <a href="/wallets">Wallets</a> <a href="/belts">Belts</a> <a href="/watches">Watches</a></nav></header>
<main><h2>Top grade 1:1 mirror quality designer bags</h2>
<p>Same leather, same hardware, same stitching as the boutique. Indistinguishable from the original, comes with dust bag, box, authenticity cards and receipt.</p>
<ul><li>Classic quilted flap bag, lambskin, gold hardware, 1:1 replica $289 (boutique price $10,800)</li><li>Monogram canvas tote GM, mirror quality $219</li><li>Crocodile-embossed top handle bag, AAA+ grade $339</li><li>Luxury automatic watch, super clone movement $459</li></ul>
<p>Discreet packaging, no brand names on the box. Pay by card or crypto; card payments appear as "LXP GIFTS". Ships from overseas in 7 to 15 days.</p></main>
<footer>Contact us on WhatsApp for wholesale. No returns on discounted items.</footer>`,
    citations: [
      { url: "https://scamwatch.example/reports/luxeparade-outlet?fixture=1", title: "[FIXTURE] Luxeparade Outlet - 37 reports: counterfeit goods", excerpts: ["[FIXTURE] Buyers report replica handbags seized by customs and card descriptors that hide the merchant's name."] },
      { url: "https://brandprotection.example/notices/2026/luxeparade?fixture=1", title: "[FIXTURE] Takedown notice: luxeparade-outlet.example", excerpts: ["[FIXTURE] A brand-protection firm filed takedown notices for sales of counterfeit designer goods."] },
    ],
  },
};

/** The jury's yes-probabilities for each case, by model. A fixture: the split case is picked to disagree. */
export const jury = {
  "jury-clear": { jev: 0.03, "perplexity/pplx-decider-v1.2": 0.05, "liquid/d1": 0.09, "cloudflare/clef": 0.04 },
  "jury-split": { jev: 0.81, "perplexity/pplx-decider-v1.2": 0.36, "liquid/d1": 0.74, "cloudflare/clef": 0.22 },
};

/** OpenRouter's catalog prices (USD per prompt token), read from /api/v1/models?output_modalities=decisions on 2026-10-30. */
export const openrouterPrices = {
  "perplexity/pplx-decider-v1.2": 0.00000002, "liquid/d1": 0.00000002, "cloudflare/clef": 0.00000024, "~typesafe/jev-latest": 0.000000042,
};
/** Each OpenRouter model's latency band in ms, so the jury's branches finish at different times. */
export const openrouterLatency = {
  "perplexity/pplx-decider-v1.2": [900, 1600], "liquid/d1": [300, 700], "cloudflare/clef": [1200, 2400],
};
