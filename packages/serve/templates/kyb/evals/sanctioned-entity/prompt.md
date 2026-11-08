---
description: A dissolved UK company on OFAC's SDN list (ent_num 26466, SDNTK), with its director listed too (26402). The run's input carries the day's OFAC rows; the agent matches the company and the director against them, cites the entries and escalates. Pass 3 of 3.
runs: 3
max_cost_usd: 1.50
---
Run KYB on this company before we pay its invoice.

- Company: Smile Property & Travel Ltd
- Country of incorporation: United Kingdom
- Registration number: 08220547
- Why we're checking: vendor

Our screening cache's OFAC rows for today follow. They come from OFAC's Sanctions List Service files published
2026-11-05 (SDN.CSV, ALT.CSV, ADD.CSV, in OFAC's own column format, no header row) and are every SDN row the cache
matched to this company's name and to the names of its directors on Companies House. They cover the OFAC SDN list only:
the UN, EU and UK lists are not in them.

SDN.CSV rows:

```csv
26402,"FERRARI, Sergio David","individual","SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 10 Feb 1968; POB Buenos Aires, Argentina; nationality Argentina; Gender Male; Passport AAA760416 (Argentina); D.N.I. 20010866 (Argentina); C.U.I.T. 20200108664 (Argentina); a.k.a. 'Yagy'; Linked To: SMILE TECHNOLOGIES S.A.; Linked To: SMILE PROPERTY & TRAVEL LTD; Linked To: SMILEWALLET S.A.S.; Linked To: SMILE TECHNOLOGIES CANADA LTD."
26465,"SMILE TECHNOLOGIES S.A.",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Website www.smiletechnologies.com.ar; alt. Website smilepayments.com; C.U.I.T. 30715339176 (Argentina)."
26466,"SMILE PROPERTY & TRAVEL LTD",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Website quartierlatinapartments.com; alt. Website smilebitcard.com; Company Number 08220547 (United Kingdom)."
26467,"SMILEWALLET S.A.S.",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"NIT # 9011450176 (Colombia)."
26468,"SMILE TECHNOLOGIES CANADA LTD",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Website www.smiletraveltours.com; alt. Website www.sweetaparts.com; Company Number 2592364 (Canada); MSB Registration Number M18867067 (Canada)."
26585,"SMILEWALLET, LLC",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Tax ID No. 32065536529 (United States)."
26586,"SMILEPAYMENTS, LLC",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"File Number 5736292 (United States)."
26603,"SMILE PROPERTY & TRAVEL LTD.",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Tax ID No. 32066912794 (United States)."
26604,"SMILE TECHNOLOGIES S.A. LLC",-0- ,"SDNTK",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Tax ID No. 32066912711 (United States)."
```

ALT.CSV rows:

```csv
26465,41736,"aka","SMILE WALLET LIMITED",-0- 
26465,41737,"aka","SMILE WALLET LTD",-0- 
26465,41738,"aka","SMILE PAYMENTS",-0- 
26466,41740,"aka","SMILE PROPERTY AND TRAVEL LTD",-0- 
26466,41741,"aka","QUARTIERLATINAPARTMENTS",-0- 
26466,41742,"aka","SMILE BITCARD",-0- 
26468,41745,"aka","SMILE WALLET",-0- 
26468,41746,"aka","SMILEWALLET",-0- 
26468,41747,"aka","SMILE TECHNOLOGIES CANADA LIMITED",-0- 
26468,41748,"aka","SMILETRAVELS",-0- 
26468,41749,"aka","SWEET APARTMENTS",-0- 
26603,42013,"aka","SMILE PROPERTY AND TRAVEL LTD.",-0- 
```

ADD.CSV rows:

```csv
26402,40137,"Chivilcoy 3157 Piso 2 Depto D","Buenos Aires 1417","Argentina",-0- 
26402,40138,-0- ,"Buenos Aires","Argentina",-0- 
26465,40117,"Avenida Chivilcoy 3157, piso 2, departamento D","Buenos Aires","Argentina",-0- 
26466,40119,"Flat 1 73a White Lion Street, Islington","London N1 9PF","United Kingdom",-0- 
26466,40120,"72 High Street Haslemere","Surrey GU27 2LA","United Kingdom",-0- 
26467,40122,"CR 15 # 146 29 Casa 1","Bogota, D.C.","Colombia",-0- 
26468,40124,"5825 Tiz Road","Mississauga, Ontario L5N0B6","Canada",-0- 
26468,40125,"731 States Street","Mississauga, Ontario L5R 0B6","Canada",-0- 
26468,40126,"2 Robert Speck Parkway, 7th Floor","Mississauga, Ontario L4Z 1H8","Canada",-0- 
26585,40326,-0- ,"San Antonio, TX","United States",-0- 
26586,40328,-0- ,"Wilmington, DE","United States",-0- 
26603,40353,-0- ,"San Antonio, TX","United States",-0- 
26604,40356,-0- ,"San Antonio, TX","United States",-0- 
```
