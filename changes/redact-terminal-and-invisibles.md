---
packages: @parcha/agentrun-serve
kind: fix
---
Redaction now reads text as a terminal shows it as well as with its controls dropped, so a held value split by an ANSI colour code, a title or hyperlink sequence (raw, 8-bit, or escaped in JSON, Python, percent-encoding or an HTML reference) or a backspace overstrike is withheld. Coloured output with no held value is shown as before, and a held value coloured whole is still cut in place. Characters that show as a box or a blank (U+FFFE, U+FFF9-FFFB, the noncharacters U+FDD0-FDEF, private use characters, the braille blank and a lone surrogate) are dropped as a zero-width character is, while a surrogate pair stays. The MCP wire's and the computer keys' scrubbers withhold an answer that still holds a credential in such a form, and the source snapshot and the Git checkpoint block on one.
