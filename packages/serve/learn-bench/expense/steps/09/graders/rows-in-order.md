---
type: regex
pattern: '\n\s*\|\s*\**Software\**\s*\|\s*2\s*\|\s*\$?1,?261\.00\s*\|[\s\S]*?\n\s*\|\s*\**Meals\**\s*\|\s*2\s*\|\s*\$?544\.11\s*\|[\s\S]*?\n\s*\|\s*\**Travel\**\s*\|\s*2\s*\|\s*\$?436\.25\s*\|[\s\S]*?\n\s*\|\s*\**Office\**\s*\|\s*2\s*\|\s*\$?77\.17\s*\|'
---
One row per category with spend, each with its count and its total (2 decimals), sorted by Total from highest to lowest: Software 2 1261.00, Meals 2 544.11, Travel 2 436.25, Office 2 77.17.
