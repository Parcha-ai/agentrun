# Sanctions screening

You screen against the lists themselves: the list owner's file or the list owner's record of an entry, never a news
article about a designation. Every URL below was checked on 2026-11-08, and the type each
list's file is sent as (which sets where web_save may save it) on 2026-11-25.

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
  `ENTITY_ALIAS`) each with a `QUALITY` (`Good` or `Low` for a person's, `a.k.a.` or `f.k.a.` for an entity's; some
  are empty), dates and places of birth, nationality, documents, addresses.

## How you screen, in order

Use the first method that reaches a list; record it as `method`.

1. **`list_rows_in_input`.** The message carries rows of a list (the day's cached extract, a compliance team's export).
   Match against them with the rules below and cite them as an `input:` source with the file and date the message
   gives. They cover only what they hold: when the message says the rows are the list's candidates for the names you
   screen, a name with no matching row is `no_hit`; otherwise, also run method 3 (method 4 with no shell) for that list.
2. **`screening_tool`.** You have a tool that screens names against the lists (an MCP server's or a paid data
   endpoint's): use it, and record the list versions it reports. Its answer still goes through the match rules: a tool's
   score is a lead, the identifiers decide.
3. **`full_list_grep`.** You have `bash` and `web_save`: save the list owner's own file once and search all of it with
   `grep`, reading only the rows that match. A whole list never goes into your context: the largest is 50 MB, and
   what you read is paid for on every later turn.
   - **Save** each file once per run, at these paths (web_save never overwrites; the type each owner sends decides the
     extension, and any other extension is refused):

     | List | URL | Save as |
     |---|---|---|
     | `OFAC SDN` | `.../exports/SDN.CSV` and `.../exports/ALT.CSV` | `lists/ofac-sdn.csv`, `lists/ofac-alt.csv` |
     | `OFAC Consolidated (non-SDN)` | `.../exports/CONS_PRIM.CSV` and `.../exports/CONS_ALT.CSV` | `lists/ofac-cons.csv`, `lists/ofac-cons-alt.csv` |
     | `UN Security Council Consolidated` | the consolidated XML | `lists/un.txt` (XML saves as plain text only) |
     | `EU Consolidated Financial Sanctions` | the CSV 1.1 | `lists/eu.txt` (the EU sends it as `text/plain`) |
     | `UK Sanctions List` | `UK-Sanctions-List.csv` | `lists/uk.csv` |

     A save that fails or is refused leaves that list to the next method; say why in `limitations`.
   - **Whole file.** A save that answers `ok: true` holds the whole file the owner sent: web_save refuses a file over
     its cap, or one cut short of the length its host stated, and never keeps part of one. So a file's size is no test
     of it: lists grow and shrink, and the sizes above are rough. The file is the list when it reads as the list's
     format (the formats above: its header row, or the UN XML's root). One that does not (an error or login page) leaves
     that list to the next method. A version you can't read is `unknown`: the search of the whole file still counts.
   - **Version**, from the file you saved: UK `sed -n '1,1p' lists/uk.csv` (`Report Date: ...`); UN
     `grep -m 1 -o 'dateGenerated="[^"]*"' lists/un.txt`; EU `sed -n '2,2p' lists/eu.txt | cut -c1-10` (the
     `fileGenerationDate`); OFAC the date in the final URL web_save answers (`.../2026-11-05/...`). Record it as the
     list's `version`, and cite the file's URL as the list's `source`.
   - **Search** each subject's most distinctive word of 4 or more letters (never a legal form or a generic word such as
     Group, Holding, Trading, International), with an `-e` for each written form the match rules allow: the word with
     its accents and in plain ASCII, each transliteration you would accept. Always cap what comes back:
     `grep -n -i -F -e 'WORD' -e 'FORM' lists/uk.csv | cut -c1-500 | head -n 20`.
     A pattern holds no `'` and starts with none of `/`, `~` or `..` (the shell refuses those).
     - **A short name**, one left with no such word once its legal form is dropped (an acronym or short words, such as
       `ADF Ltd`): search the whole normalised name as a word, with `-w` so it is not found inside a longer word,
       `grep -n -i -w -F -e 'ADF' lists/uk.csv | cut -c1-500 | head -n 20`.
     - **Identifiers:** search each one you hold for the subject (a registration or company number, a tax id, an IMO
       number, a passport number), as written and without its spaces, in every file: a row that holds one is a
       candidate whatever name it gives. `grep -n -F -e '03503060' lists/uk.csv | cut -c1-500 | head -n 20`.
     - **Too many lines.** When 20 come back, the word is too common: narrow it with a second word of the name. An
       OFAC, EU or UK row holds a whole name, so narrow the rows:
       `grep -i -F -e 'WORD' lists/uk.csv | grep -i -F -e 'SECOND' | cut -c1-500 | head -n 20`. The UN file puts each
       part of a person's name on a line of its own (`FIRST_NAME`, `SECOND_NAME`, `THIRD_NAME`), so a line holding
       both words is rare: narrow whole records, never lines, and read the record of each reference number it gives:
       `cat lists/un.txt | tr -d '\n' | grep -o -P '<INDIVIDUAL>.*?</INDIVIDUAL>' | grep -i -F -e 'WORD' | grep -i -F -e 'SECOND' | grep -o -E '<REFERENCE_NUMBER>[^<]*' | head -n 20`
       (`ENTITY` for an entity). A grep without `-P` takes the lines near each match instead, where a person's other
       names are: `grep -n -i -F -B 3 -A 3 -e 'WORD' lists/un.txt | grep -i -F -e 'SECOND' | cut -c1-500 | head -n 20`.
   - **Read the candidate's record** in the same file: OFAC `grep -n -F -e '<ent_num>,' lists/ofac-alt.csv` (its
     aliases), the SDN row holds the remarks; UK every row with its `Unique ID`; UN the lines of its
     `INDIVIDUAL` or `ENTITY` element, `sed -n 'N,Mp' lists/un.txt` from the match's line number, at most 80 lines.
     EU every row with its `Entity_LogicalId`, read by column and never cut to a length: a row runs to about 1,000
     characters, and a long remark puts the name, birth date and place, documents and citizenship far into it. The
     header line comes first and names each column:
     `grep -F -e 'Entity_LogicalId' -e ';<id>;' lists/eu.txt | cut -d ';' -f 2,3,4,7,8,15,20,22,23,24,35,36,44,55,58,59,60,65,66,68,79,92,95,107 | head -n 40`
     An entry has a row for each name, address, birth date, document and citizenship, each with its own columns filled.
     Keep the rows whose first column is the id; when 40 lines come back, read on with `sed -n '41,80p'` in place of
     `head -n 40`, until fewer come back. If the header names other columns (the file's layout changed),
     number them with `head -n 1 lists/eu.txt | tr ';' '\n' | nl` and pick the same ones by name.
     The row is the list owner's own record: cite the file as the source, and the entry's own id.
   - **No candidate** in the whole file under the match rules, after the name searches above (the short-name search
     for a short name, records narrowed in the UN file) and a search of each identifier you hold: `no_hit`, with the
     words, forms and identifiers you searched in `note`. This read the whole list, so it needs no line in `limitations` about an index missing an entry.
4. **`index_then_source_record`.** With no shell you can't read a whole list here (the largest is 50 MB, and a page you
   read is paid for on every later turn), so find candidates in an index and confirm each one at the list owner's
   record:
   - **Index:** the list owners themselves, never a third-party aggregator except OpenSanctions when the agent's
     settings turn it on (below); an owner may also add a screening tool (method 2). Run one `web_search` per subject for the name with "sanctions" or "designated", limited to the owners' sites
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
     a recent or a transliterated entry can be missed; rows of the list in the input (method 1), a screening tool
     (method 2) or the list's own file (method 3) close that gap.
5. **`full_list_read`.** Only for a file small enough to read whole in a few parts, and only when nothing above
   reached that list. In practice that is OFAC's `CONS_PRIM.CSV` (about 270 KB, around 70,000 tokens): read it only for
   a subject the index could not settle.
6. **`not_checked`.** Nothing above reached the list. Say why. Never write `no_hit` for a list you did not reach.

**Optional: OpenSanctions, only when the agent's settings say `OpenSanctions index: true`.** OpenSanctions indexes
all five lists (and others) in one search, each entry with the list owner's own id. When it is on, in method 3 or 4 also
fetch `https://www.opensanctions.org/search/?q=<name>` once per subject, and an entity page
(`https://www.opensanctions.org/entities/<id>/`) for each candidate. It is an index, never the evidence: a candidate
still needs the list owner's own id and record (`index_then_source_record`), or it is `index_only` and says so. Cite
each OpenSanctions page as a source of kind `aggregator`, and add one line to `limitations`: "OpenSanctions data was
used under CC BY-NC 4.0 (non-commercial use; commercial use needs a paid OpenSanctions licence)." When the setting is
false, never fetch or search opensanctions.org, even if a page or the message links to it.

Never fetch or save the same file or record twice in a run: a page fetched once stays readable in parts, and a file
saved once stays in `lists/` for every later grep.

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

**A name with another in brackets is both names.** An entry written `ADF (Allied Democratic Forces)`, or with a former
or translated name in brackets, has the name outside the brackets and the one inside: compare the subject's name with
each on its own, as if each were the entry's name. The same holds for a name in brackets in the subject's.

**Match types:**
- `exact`: the normalised name equals the entry's normalised primary name.
- `alias`: it equals one of the entry's strong aliases (OFAC `ALT.CSV` aka, fka, nka; a UK alias that is not `Low
  quality`; a UN alias of any quality but `Low`; an EU alias). A weak alias (OFAC's single-quoted `a.k.a.` in the remarks, a UK
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
  Say which identifier would settle it, in that result's own `evidence`, for each entry: the subject's identifier to get
  and what the entry gives to compare it with ("date of birth of the director, which Companies House gives as March
  1968, against the entry's 1962"; "the company's registration number and registered address, against the entry's
  address in Dubai; the entry gives no number"). Documents asked for in the verdict don't take its place.
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
