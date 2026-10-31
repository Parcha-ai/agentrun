# Demo documents

Every company, person, officer, Secretary of State, bank, address, file number and EIN in these documents is invented. None is a real person or a real customer.

24 PDFs: certificates and articles of incorporation, IRS EIN confirmation letters in the CP 575 layout, and bank account verification letters. Twelve are clean, eight have a defect you can see on page 1, and four make up a KYB packet for one company. `labels.json` holds the ground truth for each file (type, company, jurisdiction, issuer, the date as shown, EIN, valid, defects, page count) and the two KYB packets with the outcome each should get.

Rebuild them with `python3 -I build.py <this directory>`. The script launches its own headless Chrome through Playwright (`/usr/bin/google-chrome`) and renders HTML to Letter-size PDFs.

## Clean

| File | Type | Company | Jurisdiction | Date |
| --- | --- | --- | --- | --- |
| coi-bramblewick-tidal-instruments.pdf | Certificate of incorporation | Bramblewick Tidal Instruments, Inc. | Delaware | 2025-03-04 |
| coi-quarry-lantern-software.pdf | Certificate of incorporation | Quarry Lantern Software, Inc. | Delaware | 2023-08-21 |
| coi-marrowfield-bakeworks.pdf | Articles of incorporation | Marrowfield Bakeworks Corp. | Wyoming | 2022-11-09 |
| coi-tessaline-freight-systems.pdf | Articles of incorporation | Tessaline Freight Systems, Inc. | Nevada | 2024-06-12 |
| coi-wrenfield-acoustics.pdf | Articles of incorporation | Wrenfield Acoustics, Inc. | California | 2021-05-17 |
| ein-quarry-lantern-software.pdf | EIN letter (CP 575) | Quarry Lantern Software, Inc. | federal | 2023-09-05 |
| ein-osterby-orchard-supply.pdf | EIN letter (CP 575) | Osterby Orchard Supply LLC | federal | 2024-02-14 |
| ein-pellucid-harbor-analytics.pdf | EIN letter (CP 575) | Pellucid Harbor Analytics, Inc. | federal | 2025-01-22 |
| ein-dunmore-kiln-works.pdf | EIN letter (CP 575) | Dunmore Kiln Works Corp. | federal | 2022-07-11 |
| bank-bramblewick-tidal-instruments.pdf | Bank letter (Cobalt Ridge Bank) | Bramblewick Tidal Instruments, Inc. | | opened 2025-04-02 |
| bank-tessaline-freight-systems.pdf | Bank letter (Silverbirch National Bank) | Tessaline Freight Systems, Inc. | | opened 2024-07-01 |
| bank-osterby-orchard-supply.pdf | Bank letter (Northcairn Savings Bank) | Osterby Orchard Supply LLC | | opened 2024-03-04 |

## With a defect

| File | Defect | What a reviewer sees |
| --- | --- | --- |
| coi-quillmere-harbor-robotics.pdf | name_mismatch | The title says Quillmere Harbor Robotics, Inc.; Article FIRST says Quillmere Harbour Robotic Systems, LLC. |
| coi-ashgrove-vireo-labs.pdf | altered_date | The filing stamp's dates are whited out and retyped as 09/30/2024 in a typewriter font; the certification still says July 15, 2024. |
| coi-calloway-pinnacle-mining.pdf | missing_seal, missing_signature | The seal space in the filing stamp is empty, and the incorporator, agent and Secretary of State signature lines are blank. |
| coi-ferncastle-biotics.pdf | future_date | Filed February 17, 2027, after the review date of October 30, 2026. |
| ein-hollowmere-textiles.pdf | pasted_field | The EIN in the header sits on a tinted, tilted patch with a drop shadow; the stub on page 2 shows a different EIN. |
| ein-vantablue-logistics.pdf | inconsistent_fonts | The entity name and the EIN are in large serif and italic type, unlike the sans-serif of the rest of the notice. |
| bank-ashgrove-vireo-labs.pdf | missing_signature | The letter ends over a blank "Authorized Signature" line with no signer named. |
| bank-quorvane-medical-devices.pdf | altered_date | The Date Opened value is whited out and retyped as February 11, 2025, with the original's first letter showing. |

## KYB packet: Brisklow Marine Coatings, Inc. (Delaware)

| File | Notes |
| --- | --- |
| kyb-brisklow-coi.pdf | Delaware certificate, filed 2023-04-11 |
| kyb-brisklow-ein.pdf | CP 575, notice 2023-05-02 |
| kyb-brisklow-bank.pdf | Northcairn Savings Bank letter, opened 2023-06-15, holder Brisklow Marine Coatings, Inc. |
| kyb-brisklow-bank-mismatch.pdf | The same letter with the holder Brisklow Marine Holdings LLC, a different entity. No visual tampering. |

Packet `brisklow` (CoI, EIN letter, bank letter) should be approved. Packet `brisklow-mismatch` (the mismatched bank letter instead) should go to review.
