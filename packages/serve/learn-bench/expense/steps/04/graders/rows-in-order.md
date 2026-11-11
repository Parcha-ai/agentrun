---
type: regex
pattern: '\n\s*\|\s*\**Office\**\s*\|\s*3\s*\|\s*\$?1,?150\.99\s*\|[\s\S]*?\n\s*\|\s*\**Software\**\s*\|\s*3\s*\|\s*\$?1,?088\.12\s*\|[\s\S]*?\n\s*\|\s*\**Meals\**\s*\|\s*1\s*\|\s*\$?346\.75\s*\|[\s\S]*?\n\s*\|\s*\**Travel\**\s*\|\s*1\s*\|\s*\$?270\.84\s*\|'
---
One row per category with spend, each with its count and its total (2 decimals), sorted by Total from highest to lowest: Office 3 1150.99, Software 3 1088.12, Meals 1 346.75, Travel 1 270.84.
