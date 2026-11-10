---
type: regex
pattern: '\n\s*\|\s*\**Travel\**\s*\|\s*4\s*\|\s*\$?1,?520\.84\s*\|[\s\S]*?\n\s*\|\s*\**Software\**\s*\|\s*1\s*\|\s*\$?650\.81\s*\|[\s\S]*?\n\s*\|\s*\**Meals\**\s*\|\s*1\s*\|\s*\$?385\.42\s*\|[\s\S]*?\n\s*\|\s*\**Office\**\s*\|\s*2\s*\|\s*\$?135\.42\s*\|'
---
One row per category with spend, each with its count and its total (2 decimals), sorted by Total from highest to lowest: Travel 4 1520.84, Software 1 650.81, Meals 1 385.42, Office 2 135.42.
