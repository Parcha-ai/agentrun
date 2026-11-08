# Sanctions screening

You screen against the lists themselves: the list owner's file or the list owner's record of an entry, never a news
article about a designation. Every URL below was checked on 2026-11-08.

## The lists

| List (`list` in the JSON) | Owner | Files (free, no key) | One entry's record | Entry id to cite | Version |
|---|---|---|---|---|---|
| `OFAC SDN` | US Treasury, OFAC | `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV`, with `ALT.CSV` (aliases) and `ADD.CSV` (addresses) beside it; `SDN.XML`, `SDN_ENHANCED.XML`. The old `https://www.treasury.gov/ofac/downloads/sdn.csv` redirects to the same file. SDN.CSV is about 5.8 MB. | `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=<ent_num>` (name, type, list, programs, aliases, addresses, identifiers) | `ent_num` (e.g. 26466) | the publication date: the redirect's path holds it (`.../2026-11-05/...`), and `https://ofac.treasury.gov/recent-actions` lists each update |
| `OFAC Consolidated (non-SDN)` | US Treasury, OFAC | `.../exports/CONS_PRIM.CSV` (about 270 KB), `CONS_ALT.CSV`, `CONS_ADD.CSV`, same base URL. Holds the SSI, FSE, NS-MBS, CAPTA, NS-PLC and other non-SDN lists. | the same `Details.aspx?id=<ent_num>` page | `ent_num` | as for the SDN |
| `UN Security Council Consolidated` | UN Security Council | `https://scsanctions.un.org/resources/xml/en/consolidated.xml` (about 2.2 MB; its root's `dateGenerated` is the version) | none a plain fetch reads; committee pages on `main.un.org/securitycouncil` found by search; the UK and EU lists carry the UN reference too | the reference number (`QDi.001`, `CDe.001`, `TAe.010`) | `dateGenerated` |
| `EU Consolidated Financial Sanctions` | European Commission (FSF) | `https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw` (CSV 1.1) and `.../xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw` (XML 1.1). The RSS feed `https://webgate.ec.europa.eu/fsd/fsf/public/rss` names the current files and their publication time. On 2026-11-08 the file URLs answered HTTP 500 to a plain fetch while the feed answered. | the Council Regulation or Decision that lists the entry, on EUR-Lex (`eur-lex.europa.eu`), found by search | the EU reference (`EU.1234.56`) or the regulation and annex entry | the feed's publication time, or the regulation's date |
| `UK Sanctions List` | UK FCDO | `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv` (about 50 MB), also `.xml`, `.html`, `.ods`, `.txt`, `.pdf`; publication page `https://www.gov.uk/government/publications/the-uk-sanctions-list`. Since 28 January 2026 this is the only UK list: the OFSI Consolidated List closed and is no longer updated. | the search service `https://search-uk-sanctions-list.service.gov.uk/` is a browser app a plain fetch can't read; gov.uk financial sanctions notices found by search | `Unique ID` (`RUS0001`, `AFG0001`); older entries also carry an `OFSI Group ID` | the CSV's first line, `Report Date: 03-Nov-2026` |

Every list is screened in every run. A list that no method below reached is `not_checked` for each subject, with the
reason in `limitations`; for the company or an owner that is RF21, and the verdict is at best `proceed_with_conditions`
with the condition "re-screen against <list>".

## File formats

You will meet these when rows of a list are in the message, or when you read a record.

- **OFAC `SDN.CSV` and `CONS_PRIM.CSV`**: no header row; `-0-` means empty. Columns: `ent_num`, `SDN_Name`, `SDN_Type`
  (`individual`, `vessel`, `aircraft`; `-0-` is an entity), `Program` (several joined by `] [`), `Title`, `Call_Sign`,
  `Vess_type`, `Tonnage`, `GRT`, `Vess_flag`, `Vess_owner`, `Remarks`. The remarks hold the identifiers: `Website`,
  `Company Number`, `Registration Number`, `Tax ID No.`, `DOB`, `POB`, `nationality`, `Passport`, `Linked To:` (the
  parties OFAC ties it to), secondary sanctions notes, and weak aliases written `a.k.a. 'NAME'` in single quotes.
- **OFAC `ALT.CSV`**: `ent_num`, `alt_num`, `alt_type` (`aka`, `fka` formerly known as, `nka` now known as),
  `alt_name`, `alt_remarks`. These are the strong aliases.
- **OFAC `ADD.CSV`**: `ent_num`, `add_num`, `address`, `city_state_postal`, `country`, `add_remarks`.
- **UK CSV**: a `Report Date` line, then a header: `Last Updated`, `Unique ID`, `OFSI Group ID`, `UN Reference Number`,
  `Name 6` (the surname or the entity's name), `Name 1` to `Name 5`, `Name type` (`Primary Name` or an alias),
  `Alias strength`, `Regime Name`, `Designation Type`, `Designation source`, `Sanctions Imposed`, `Other Information`,
  `UK Statement of Reasons`, address fields, `Website`, `Date Designated`, `D.O.B`, `Nationality(/ies)`, identifiers,
  `Type of entity`, `Parent company`, `Business registration number (s)`, ...
- **UN XML**: `INDIVIDUAL` and `ENTITY` elements with `REFERENCE_NUMBER`, `UN_LIST_TYPE`, `LISTED_ON`, a person's
  `FIRST_NAME` to `FOURTH_NAME` (an entity's name is its `FIRST_NAME`), `COMMENTS1`, aliases (`INDIVIDUAL_ALIAS`,
  `ENTITY_ALIAS`) each with a `QUALITY` (`Good`, `Low`), dates and places of birth, nationality, documents, addresses.

## How you screen, in order

Use the first method that reaches a list; record it as `method`.

1. **`list_rows_in_input`.** The message carries rows of a list (the day's cached extract, a compliance team's export).
   Match against them with the rules below and cite them as an `input:` source with the file and date the message
   gives. They cover only what they hold: when the message says the rows are the list's candidates for the names you
   screen, a name with no matching row is `no_hit`; otherwise, also run method 3 for that list.
2. **`screening_tool`.** You have a tool that screens names against the lists (an MCP server's or a paid data
   endpoint's): use it, and record the list versions it reports. Its answer still goes through the match rules: a tool's
   score is a lead, the identifiers decide.
3. **`index_then_source_record`.** You can't read a whole list here (the largest is 50 MB, and a page you read is paid
   for on every later turn), so find candidates in an index and confirm each one at the list owner's record:
   - **Index:** the list owners themselves, never a third-party aggregator (an owner may add a screening tool, method
     2). Run one `web_search` per subject for the name with "sanctions" or "designated", limited to the owners' sites
     (`site:ofac.treasury.gov`, `site:home.treasury.gov`, `site:sanctionssearch.ofac.treas.gov`, `site:gov.uk`,
     `site:un.org`, `site:eur-lex.europa.eu`), and fetch an owner's own search or notice page when a result points to
     one. Each candidate found must carry the list owner's own id (`ent_num` for OFAC, the `Unique ID` for the UK, the
     reference number for the UN, the regulation and entry for the EU) before it counts.
   - **Record:** OFAC: fetch `Details.aspx?id=<ent_num>` and cite it. UK: the entry's `Unique ID` with the gov.uk
     notice or list page that shows it. UN: the reference number with the committee's page or the UN XML as the list
     source. EU: the regulation's annex on EUR-Lex with the entry. When the owner's record can't be reached, the method
     is `index_only` and the result says so.
   - **No candidate** under the match rules in the owners' sites: `no_hit`, citing each search as a source with
     `found: false`, and one line in `limitations`: a search of the owners' sites is not a read of the list itself, so
     a recent or a transliterated entry can be missed; rows of the list in the input (method 1) or a screening tool
     (method 2) close that gap.
4. **`full_list_read`.** Only for a file small enough to read whole in a few parts, and only when nothing above
   reached that list. In practice that is OFAC's `CONS_PRIM.CSV` (about 270 KB, around 70,000 tokens): read it only for
   a subject the index could not settle.
5. **`not_checked`.** Nothing above reached the list. Say why. Never write `no_hit` for a list you did not reach.

**Off by default: an aggregator index.** OpenSanctions (`https://www.opensanctions.org/search/?q=<name>`) indexes all
these lists in one search, with each entry's list-owner id. Its commercial use needs a licence, and that decision is
pending, so this package does not use it. An owner who holds the licence adds it as a screening tool (method 2, an MCP
server or a data endpoint), never as a page to fetch here. Even then it is an index: the list owner's own record is
the evidence.

Never fetch the same file or record twice in a run: a page fetched once stays readable in parts.

## Names to screen

- The company: its legal name, every former name and trading name you found, and the name as the message gave it if it
  differs. Report one subject per entity, with the names you ran in `note`.
- People: as `SKILL.md` step 4 says (owners, parents, directors, chief executive, chief financial officer, secretary),
  at most 10. Use the registry's form of the name (Companies House lists `SURNAME, Forenames`).
- Corporate owners and parents: screened as entities.

## Match rules

**Normalise both names before comparing:** case; accents and diacritics (Société = Societe); punctuation and spacing;
`&` = `and`; drop a leading `The`; drop the legal form (Ltd, Limited, LLC, L.L.C., Inc, Incorporated, Corp, Corporation,
PLC, LLP, LP, GmbH, AG, S.A., S.A.S., S.R.L., B.V., N.V., JSC, OOO, PJSC, Co., Company). Keep distinctive words such as
Holding, Group, International, Trading, Bank: they are compared, but they don't make a match on their own.

**Match types:**
- `exact`: the normalised name equals the entry's normalised primary name.
- `alias`: it equals one of the entry's strong aliases (OFAC `ALT.CSV` aka, fka, nka; a UK alias that is not `Low
  quality`; a UN alias of `Good` quality; an EU alias). A weak alias (OFAC's single-quoted `a.k.a.` in the remarks, a UK
  `Low quality` alias, a UN `Low` alias) never makes a hit on the name alone: it needs an identifier that agrees.
- `fuzzy`: the names differ only by word order, transliteration (Mohammed, Muhammad, Mohamed; Aleksandr, Alexander;
  Zhang Wei, Wei Zhang), one or two characters in a long name, a missing or extra non-distinctive word (Group, Holding,
  Trading, International), given names reduced to initials, or a translated generic word (Bank, Banco, Banque).
- **Not a match:** sharing only generic words ("Global Trading International"), a surname alone, or one distinctive word
  inside a longer, different distinctive name.

**Decide with identifiers.** A name match is a candidate; identifiers decide it.
- Entity: registration or company number, tax id, country of incorporation, registered address, website or domain,
  SWIFT/BIC, IMO number, the parties the list links it to, date of establishment.
- Person: date or year of birth, place of birth, nationality, passport or national id, address country, the company the
  list links them to (OFAC's `Linked To:`), a role that matches.

**Results:**
- `confirmed_hit`: the name matches (any type), at least one strong identifier agrees (a registration number, a website,
  a date of birth, a linked company that is the subject), and none conflicts. Cite the entry id, the list, the program,
  and the identifier that agrees, in `evidence`.
- `possible_match`: the name matches and there is no identifier to compare either way. It is not cleared: it is RF02
  (the company, a parent, an owner or a controller) or RF04 (a director or officer).
  Say which identifier would settle it ("date of birth of the director, which Companies House gives as March 1968").
- `false_positive`: the name matches and a reliable identifier conflicts: a different registration number or country of
  incorporation, a date of birth years apart, an individual against an entity, a different nationality and place of
  birth together. Say which identifier rules it out, and cite where each side comes from. A single soft difference (a
  city, a spelling of an address) with no strong identifier on either side is a `possible_match`, not a false positive.
- `no_hit`: no candidate under these rules, by the method recorded.

**Also:**
- Several entries can share a name (OFAC lists two `SMILE PROPERTY & TRAVEL LTD` entries, 26466 with a UK company
  number and 26603 with a US tax id): judge each one.
- An entry removed from a list is history, not a hit: report it as information with its removal date.
- Give each program as the list writes it, and what it means from the owner's own program key where you read it
  (`SDNTK`: Foreign Narcotics Kingpin Designation Act; `SDGT`: Specially Designated Global Terrorist; `IFSR`: Iranian
  Financial Sanctions Regulations). Remarks such as "Secondary sanctions risk" go in `evidence`.
- The non-SDN OFAC lists restrict some dealings rather than block everything (sectoral sanctions, for example): say what
  the list restricts; it is RF03 in `RED-FLAGS.md`.
- Ownership: OFAC blocks any entity owned 50% or more, directly or indirectly, in total, by blocked persons, listed or
  not. The EU and UK freeze entities owned (more than 50%) or controlled by a designated person. A designated owner or
  controller makes the company itself a hit for verdict purposes: RF01.
