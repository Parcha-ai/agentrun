---
type: regex
pattern: '\n\s*\|\s*\**Meals\**\s*\|\s*2\s*\|\s*\$?1,?500\.41\s*\|[\s\S]*?\n\s*\|\s*\**Travel\**\s*\|\s*1\s*\|\s*\$?1,?352\.12\s*\|[\s\S]*?\n\s*\|\s*\**Office\**\s*\|\s*3\s*\|\s*\$?272\.08\s*\|[\s\S]*?\n\s*\|\s*\**Software\**\s*\|\s*2\s*\|\s*\$?59\.71\s*\|'
---
One row per category with spend, each with its count and its total (2 decimals), sorted by Total from highest to lowest: Meals 2 1500.41, Travel 1 1352.12, Office 3 272.08, Software 2 59.71.
