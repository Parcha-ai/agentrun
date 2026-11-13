# Sources

Where a company's records are, and the URLs that answer a plain `web_fetch` from here. Checked on 2026-11-08. A URL
that fails in a run: say so in `limitations`, try the alternative given, and never report the missing fact as found.

Primary sources first: the registry, the regulator, the court, the list owner. An aggregator (OpenCorporates, GLEIF,
a data broker's page) is a fine way to find the record and an acceptable source when the primary is not
fetchable; say it is an aggregator and give the primary register it names. The company's own site is a source only for
what the company states.

## United Kingdom: Companies House and around it

Companies House's public pages need no key. `<n>` is the 8-character company number (`00445790`, `SC123456`,
`OC301234`): pad a short number with leading zeros.

| What | URL |
|---|---|
| Search companies by name | `https://find-and-update.company-information.service.gov.uk/search/companies?q=<name>` |
| Profile: name, number, status, registered office, type, incorporated on, SIC, accounts and confirmation statement due | `https://find-and-update.company-information.service.gov.uk/company/<n>` |
| Officers: directors and secretaries, appointed and resigned dates, nationality, month and year of birth, other appointments link | `https://find-and-update.company-information.service.gov.uk/company/<n>/officers` |
| Persons with significant control (PSC) and PSC statements | `https://find-and-update.company-information.service.gov.uk/company/<n>/persons-with-significant-control` |
| Filing history (accounts, changes of name, strike-off notices) | `https://find-and-update.company-information.service.gov.uk/company/<n>/filing-history` |
| Insolvency (when the profile shows a tab for it) | `https://find-and-update.company-information.service.gov.uk/company/<n>/insolvency` |
| Disqualified directors | `https://find-and-update.company-information.service.gov.uk/search/disqualified-officers?q=<name>` |
| The Gazette: winding-up petitions, liquidations, strike-off notices | `https://www.thegazette.co.uk/all-notices/notice?text=<name or number>` |
| FCA Financial Services Register (authorised firms, permissions, warnings) | `https://register.fca.org.uk/s/search?q=<name>&type=Companies` |
| National Archives Find Case Law (court judgments) | `https://caselaw.nationalarchives.gov.uk/search?query=<name>` |

- A UK company's website must show its registered name and number: the footer, terms or privacy page is the usual place.
- "Proposal to strike off" (a First Gazette notice) or overdue accounts on the profile are facts for `RED-FLAGS.md`.
- Registered offices at formation-agent addresses host thousands of companies; the profile alone won't say so. Note it
  only when a source does.

## United States: SEC EDGAR, the states, and around them

SEC pages expect a declared user agent; `www.sec.gov` HTML pages may answer 403 to an automated fetch, while
`data.sec.gov` and `efts.sec.gov` answer. Use these:

| What | URL |
|---|---|
| Find a filer's CIK by name or ticker (JSON: CIK as `_id`, name, tickers) | `https://efts.sec.gov/LATEST/search-index?keysTyped=<name>` |
| A filer's record (JSON): legal name, former names, state of incorporation, business and mailing addresses, EIN, SIC, tickers, exchanges, recent filings with form, date and accession number | `https://data.sec.gov/submissions/CIK<10-digit zero-padded CIK>.json` |
| Full-text search of filings since 2001 (mentions: subsidiaries in Exhibit 21, related parties) | `https://efts.sec.gov/LATEST/search-index?q="<exact phrase>"&forms=10-K` |
| A filing's documents | `https://www.sec.gov/Archives/edgar/data/<CIK without zeros>/<accession without dashes>/` (may be 403; then cite the submissions record's filing row) |

- Read the submissions JSON with a small `max_chars` first: the header fields come before the filings list.
- Listed company: the latest 10-K (business, risk factors, legal proceedings, Exhibit 21 subsidiaries), the latest
  DEF 14A (directors, executive officers, the beneficial ownership table) and 8-Ks for recent events.
- A company with only Form D filings is a private issuer that raised money under Regulation D: the Form D names its
  executive officers and directors, its state of incorporation and the year of incorporation.
- Most US companies file nothing with the SEC. They are registered with a state's Secretary of State. Many state search
  pages need a browser or a captcha, and Delaware charges for status: use OpenCorporates (below), which mirrors the
  states' registers with a link to each, and say which state's record you relied on.
- Regulators and enforcement: SEC litigation releases and administrative proceedings (find them with `web_search`
  limited to `sec.gov`), FINRA BrokerCheck and disciplinary actions, CFPB enforcement actions, FTC cases, DOJ press
  releases (`justice.gov`), OFAC enforcement actions (`ofac.treasury.gov/civil-penalties-and-enforcement-information`),
  FinCEN enforcement actions, state attorneys general. SAM.gov exclusions (federal debarment) is a browser app a plain
  fetch can't read: find an exclusion with `web_search`, and say the check was by search only.

## Everywhere: OpenCorporates, GLEIF, RDAP

| What | URL |
|---|---|
| OpenCorporates search (any jurisdiction; narrow with `jurisdiction_code`, e.g. `us_de`, `us_ny`, `gb`, `ie`) | `https://opencorporates.com/companies?q=<name>` or `...&jurisdiction_code=<code>` |
| OpenCorporates company page (status, incorporation date, address, officers where the register publishes them, link to the source register) | `https://opencorporates.com/companies/<jurisdiction_code>/<number>` |
| GLEIF LEI search by legal name (JSON: LEI, legal name, jurisdiction, `registeredAs` = the local registration number, status) | `https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=<exact legal name>` |
| GLEIF fuzzy name search | `https://api.gleif.org/api/v1/fuzzycompletions?field=entity.legalName&q=<name>` |
| GLEIF direct and ultimate parent (404 means none is reported; the record's reporting exception says why) | `https://api.gleif.org/api/v1/lei-records/<LEI>/direct-parent` and `.../ultimate-parent` |
| RDAP for a domain (redirects to the registry's RDAP server; JSON events: registration, expiration, last changed; registrar) | `https://rdap.org/domain/<domain>` |

- OpenCorporates may limit or refuse automated reads. When it does, say so and use the national registry.
- RDAP answers 404 for a domain that is not registered: that is a finding (the domain the company gave does not exist).
- A domain's registration date is not the company's age: a recently registered domain for a company that claims long
  history, or a domain registered long before the company, is worth one sentence, not a conclusion.

## Other countries

Covered on a best-effort basis: OpenCorporates and GLEIF first, then the national registry where it is public and a plain
fetch reads it. Some that do: New Zealand Companies Office (`https://app.companiesoffice.govt.nz/co/<number>`),
Australia ABN Lookup (`https://abr.business.gov.au/ABN/View?abn=<abn>`), France's company directory API (JSON: SIREN,
legal name, head office, directors: `https://recherche-entreprises.api.gouv.fr/search?q=<name>`). Canada's federal registry,
Corporations Canada (`https://ised-isde.canada.ca/cc/lgcy/fdrlCrpSrch.html`, a record by its corporation number): read
its `Status` and its annual filings table; the record page also carries help pop-ups (a notice of intent to dissolve,
overdue filings) that every record shows, which are not about the company. Ireland's CRO refuses
automated reads. Many registries (most of the EU's, the UAE's, offshore centres) need an account, a fee or a browser: name the registry,
say it was not reached, and list what that leaves unverified. Never present an aggregator's snippet of such a registry
as its record without saying so.

## News and search

`web_search` finds leads; a result is not a source until you read the page it points at. Prefer the regulator's or the
court's own page over a report of it, and an established publication over a blog or an aggregator.
